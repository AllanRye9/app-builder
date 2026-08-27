import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

// --- Mock the network-touching modules so the test drives real App.jsx /
// Dashboard state transitions without any real HTTP/EventSource traffic. ---

const streamHandlers = {}; // jobId -> handlers passed to streamLogs

vi.mock('../lib/auth.js', () => ({
  getToken: () => 'fake-token',
  setToken: () => {},
  clearToken: () => {},
}));

vi.mock('../api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchMe: vi.fn(() => Promise.resolve({ id: 'u1', email: 'test@example.com' })),
    logout: vi.fn(() => Promise.resolve()),
    uploadZip: vi.fn((file) => Promise.resolve(`job-${file.name}`)),
    streamLogs: vi.fn((jobId, handlers) => {
      streamHandlers[jobId] = handlers;
      return () => { delete streamHandlers[jobId]; };
    }),
    pauseBuild: vi.fn(),
    resumeBuild: vi.fn(),
    cancelBuild: vi.fn(),
    rebuildJob: vi.fn(),
    // Fire-and-forget stats calls the header renders on mount — stub so
    // they resolve instantly instead of hitting the network.
    pingVisitor: vi.fn(() => Promise.resolve({ totalVisitors: 0, todayVisitors: 0, countries: 0 })),
    fetchVisitorStats: vi.fn(() => Promise.resolve({ totalVisitors: 0, todayVisitors: 0, countries: 0 })),
    fetchSystemStatus: vi.fn(() => Promise.resolve({ running: 0, queued: 0, maxConcurrentBuilds: 2, memory: {} })),
  };
});

vi.mock('../lib/theme.js', () => ({
  getStoredTheme: () => 'dark',
  applyTheme: () => {},
  THEMES: [{ id: 'dark', label: 'Dark' }],
}));

import App from '../App.jsx';

function makeZip(name) {
  return new File(['dummy'], name, { type: 'application/zip' });
}

async function dropFiles(names) {
  const dropzone = screen.getByLabelText('Add project archives');
  const files = names.map(makeZip);
  await act(async () => {
    fireEvent.drop(dropzone, { dataTransfer: { files } });
  });
  // Confirm the permissions modal to actually kick off the uploads.
  const confirmBtn = await screen.findByText(/Confirm & start build/);
  await act(async () => {
    fireEvent.click(confirmBtn);
  });
}

// Tickets are now flattened into one shared list (see App.jsx's ticketRows
// comment for why — nesting them in a separate wrapper <div> per group used
// to force a remount, and a duplicate build-completion side effect, every
// time a job crossed from "running" into a terminal status). So "which
// group is this ticket in" is no longer a DOM-ancestry question — it's
// "which group-title row is the nearest one before it in document order".
// This walks the same rendered order a person actually sees on screen.
function jobNamesInGroup(headerText) {
  const header = screen.getByText(headerText).closest('.ticket-group-title');
  const names = [];
  let node = header.nextElementSibling;
  while (node && !node.classList.contains('ticket-group-title')) {
    const nameEl = node.querySelector('.ticket-name');
    if (nameEl) names.push(nameEl.textContent);
    node = node.nextElementSibling;
  }
  return names;
}

function countBadge(headerText) {
  const header = screen.getByText(headerText).closest('.ticket-group-title');
  return header.querySelector('.ticket-group-count').textContent;
}

beforeEach(() => {
  for (const k of Object.keys(streamHandlers)) delete streamHandlers[k];
  vi.clearAllMocks();
});

describe('build floor grouping', () => {
  it('buckets jobs into Running / Successful / Failed / Stopped sections, not one mixed list', async () => {
    render(<App />);

    // Wait past the session check and the loading screen's minimum
    // display time (see App.jsx's LOADING_MIN_MS).
    await waitFor(() => expect(screen.getByLabelText('Add project archives')).toBeTruthy(), { timeout: 3000 });

    await dropFiles(['kotlin.zip', 'react.zip', 'flutter.zip', 'java.zip']);

    // All 4 should have gone through uploadZip -> validating, and each
    // ticket subscribes to its own stream, so wait until all 4 handler
    // sets are registered.
    await waitFor(() => {
      expect(Object.keys(streamHandlers).length).toBe(4);
    });

    // Right after dropping, everything is still "running" (validating).
    expect(jobNamesInGroup('Running')).toEqual(
      expect.arrayContaining(['kotlin.zip', 'react.zip', 'flutter.zip', 'java.zip'])
    );
    expect(jobNamesInGroup('Running').length).toBe(4);
    expect(screen.queryByText('Successful')).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.queryByText('Stopped')).toBeNull();

    // Drive kotlin.zip to success.
    await act(async () => {
      streamHandlers['job-kotlin.zip'].onDone({ status: 'success', error: null, exitCode: 0 });
    });
    // Drive react.zip to failed.
    await act(async () => {
      streamHandlers['job-react.zip'].onDone({ status: 'failed', error: 'Gradle blew up', exitCode: 1 });
    });
    // Drive flutter.zip to stopped.
    await act(async () => {
      streamHandlers['job-flutter.zip'].onDone({ status: 'stopped', error: null, exitCode: null });
    });
    // java.zip stays running/building.
    await act(async () => {
      streamHandlers['job-java.zip'].onStatus({ status: 'building' });
    });

    // Now each status should have landed in its own section, and none of
    // the sections should be mixing statuses together.
    await waitFor(() => {
      expect(screen.getByText('Successful')).toBeTruthy();
      expect(screen.getByText('Failed')).toBeTruthy();
      expect(screen.getByText('Stopped')).toBeTruthy();
    });

    expect(jobNamesInGroup('Running')).toEqual(['java.zip']);
    expect(jobNamesInGroup('Successful')).toEqual(['kotlin.zip']);
    expect(jobNamesInGroup('Failed')).toEqual(['react.zip']);
    expect(jobNamesInGroup('Stopped')).toEqual(['flutter.zip']);

    // Each group's count badge should match how many tickets are in it.
    expect(countBadge('Running')).toBe('1');
    expect(countBadge('Successful')).toBe('1');
    expect(countBadge('Failed')).toBe('1');
    expect(countBadge('Stopped')).toBe('1');
  });

  it('keeps the same JobTicket mounted (does not reopen its log stream) when a job moves from running into a terminal group', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('Add project archives')).toBeTruthy(), { timeout: 3000 });

    await dropFiles(['react.zip']);
    await waitFor(() => expect(Object.keys(streamHandlers).length).toBe(1));

    // streamLogs (mocked) is the thing a fresh JobTicket mount would call
    // again to open a new subscription — assert it's still only been
    // called once after the job crosses into "Failed", proving the
    // ticket that was already subscribed is the same one still mounted
    // rather than a remounted replacement opening a second stream.
    const { streamLogs } = await import('../api.js');
    expect(streamLogs).toHaveBeenCalledTimes(1);

    await act(async () => {
      streamHandlers['job-react.zip'].onDone({ status: 'failed', error: 'Gradle blew up', exitCode: 1 });
    });

    await waitFor(() => expect(screen.getByText('Failed')).toBeTruthy());
    expect(jobNamesInGroup('Failed')).toEqual(['react.zip']);
    expect(streamLogs).toHaveBeenCalledTimes(1);
  });
});
