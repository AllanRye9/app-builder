import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import ToastStack from '../components/ToastStack.jsx';

describe('ToastStack', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders a toast, then removes it after auto-dismiss + leave animation', () => {
    const notices = [{ id: 1, level: 'success', title: 'Build complete', message: 'app.zip is ready.' }];
    const onDismiss = vi.fn();
    const { rerender } = render(<ToastStack notices={notices} onDismiss={onDismiss} />);

    expect(screen.getByText('Build complete')).toBeTruthy();
    expect(onDismiss).not.toHaveBeenCalled();

    // Before the ~2.2s auto-dismiss timer fires, nothing should happen yet.
    act(() => { vi.advanceTimersByTime(2000); });
    expect(onDismiss).not.toHaveBeenCalled();

    // Crossing that mark should flip the toast into its leaving phase
    // (onDismiss itself is *not* called immediately -- it only fires once
    // the leave animation duration has elapsed).
    act(() => { vi.advanceTimersByTime(250); });
    const toastEl = document.querySelector('.toast');
    expect(toastEl.className).toContain('toast-leaving');
    expect(onDismiss).not.toHaveBeenCalled();

    // After the leave-animation window, the parent's onDismiss should be
    // invoked so the toast actually gets removed from state.
    act(() => { vi.advanceTimersByTime(200); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(1);

    // Simulate the parent actually removing it (as App.jsx's
    // dismissToast does) and confirm it's gone from the DOM.
    rerender(<ToastStack notices={[]} onDismiss={onDismiss} />);
    expect(screen.queryByText('Build complete')).toBeNull();
  });

  it('gives error toasts more time before auto-dismissing than other levels', () => {
    const onDismiss = vi.fn();
    render(<ToastStack notices={[{ id: 2, level: 'error', title: 'Build failed', message: 'oops' }]} onDismiss={onDismiss} />);

    // Well past the normal ~2.2s window -- an error toast should still be up.
    act(() => { vi.advanceTimersByTime(3000); });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.querySelector('.toast').className).not.toContain('toast-leaving');

    // Past its own longer window, it should start leaving too (i.e. it's
    // not permanent -- it just gets more time than a normal toast).
    act(() => { vi.advanceTimersByTime(1500); });
    expect(document.querySelector('.toast').className).toContain('toast-leaving');
  });

  it('dismiss (×) button starts the leave animation immediately rather than removing instantly', () => {
    const onDismiss = vi.fn();
    render(<ToastStack notices={[{ id: 3, level: 'warning', title: 'Not accepted', message: 'bad file' }]} onDismiss={onDismiss} />);

    act(() => { screen.getByLabelText('Dismiss').click(); });
    expect(document.querySelector('.toast').className).toContain('toast-leaving');
    expect(onDismiss).not.toHaveBeenCalled(); // not yet -- still animating out

    act(() => { vi.advanceTimersByTime(250); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
