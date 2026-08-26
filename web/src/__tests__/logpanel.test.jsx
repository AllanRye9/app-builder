import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import LogPanel from '../components/LogPanel.jsx';

describe('LogPanel error highlighting', () => {
  it('flags error/exception/fatal lines red, leaves normal lines alone', () => {
    const lines = [
      'Downloading gradle-8.5-bin.zip',
      'FAILURE: Build failed with an exception.',
      'Caused by: java.lang.RuntimeException: boom',
      'BUILD SUCCESSFUL in 42s',
    ];
    const { container } = render(<LogPanel lines={lines} live={false} />);
    const rows = container.querySelectorAll('.log-line');
    expect(rows.length).toBe(4);
    expect(rows[0].className).not.toMatch(/log-line-error/);
    expect(rows[1].className).toMatch(/log-line-error/);
    expect(rows[2].className).toMatch(/log-line-error/);
    expect(rows[3].className).not.toMatch(/log-line-error/);
  });
});
