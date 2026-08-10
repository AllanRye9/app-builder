import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';

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

beforeEach(() => {
  for (const k of Object.keys(streamHandlers)) delete streamHandlers[k];
});

describe('build floor grouping', () => {
  it('buckets jobs into Running / Successful / Failed / Stopped sections, not one mixed list', async () => {
    render(<App />);

    // Wait past the session check.
    await waitFor(() => expect(screen.getByLabelText('Add project archives')).toBeTruthy());

    await dropFiles(['kotlin.zip', 'react.zip', 'flutter.zip', 'java.zip']);

    // All 4 should have gone through uploadZip -> validating, and each
    // ticket subscribes to its own stream, so wait until all 4 handler
    // sets are registered.
    await waitFor(() => {
      expect(Object.keys(streamHandlers).length).toBe(4);
    });

    // Right after dropping, everything is still "running" (validating).
    let runningGroup = screen.getByText('Running').closest('.ticket-group');
    expect(within(runningGroup).getAllByText(/\.zip$/).length).toBe(4);
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

    runningGroup = screen.getByText('Running').closest('.ticket-group');
    const successGroup = screen.getByText('Successful').closest('.ticket-group');
    const failedGroup = screen.getByText('Failed').closest('.ticket-group');
    const stoppedGroup = screen.getByText('Stopped').closest('.ticket-group');

    expect(within(runningGroup).getByText('java.zip')).toBeTruthy();
    expect(within(runningGroup).queryByText('kotlin.zip')).toBeNull();
    expect(within(runningGroup).queryByText('react.zip')).toBeNull();
    expect(within(runningGroup).queryByText('flutter.zip')).toBeNull();

    expect(within(successGroup).getByText('kotlin.zip')).toBeTruthy();
    expect(within(failedGroup).getByText('react.zip')).toBeTruthy();
    expect(within(stoppedGroup).getByText('flutter.zip')).toBeTruthy();

    // Each group's count badge should match how many tickets are in it.
    expect(within(runningGroup).getByText('1')).toBeTruthy();
    expect(within(successGroup).getByText('1')).toBeTruthy();
    expect(within(failedGroup).getByText('1')).toBeTruthy();
    expect(within(stoppedGroup).getByText('1')).toBeTruthy();
  });
});
