import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SourceSelector,
  DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS,
} from '../source-selector.js';

class MockStderr {
  lines: string[] = [];
  write(chunk: string): void {
    this.lines.push(chunk);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SourceSelector', () => {
  it('startup with smee-attempt emits startup-smee-selected', () => {
    const stderr = new MockStderr();
    const sel = new SourceSelector({ initial: 'smee-attempt', stderr });
    expect(sel.currentSource).toBe('smee-attempt');
    expect(stderr.lines).toEqual([
      'cockpit doorbell: source=smee reason=startup-smee-selected\n',
    ]);
    sel.stop();
  });

  it('startup with poll-fallback emits startup-no-channel', () => {
    const stderr = new MockStderr();
    const sel = new SourceSelector({ initial: 'poll-fallback', stderr });
    expect(sel.currentSource).toBe('poll-fallback');
    expect(stderr.lines).toEqual([
      'cockpit doorbell: source=poll-fallback reason=startup-no-channel\n',
    ]);
    sel.stop();
  });

  it('first onReconnectSuccess() silently transitions to smee-active', () => {
    const stderr = new MockStderr();
    const sel = new SourceSelector({ initial: 'smee-attempt', stderr });
    sel.onReconnectSuccess();
    expect(sel.currentSource).toBe('smee-active');
    // Only startup line — no additional line.
    expect(stderr.lines).toHaveLength(1);
    sel.stop();
  });

  it('4 reconnect attempts do NOT demote', () => {
    const stderr = new MockStderr();
    const sel = new SourceSelector({ initial: 'smee-attempt', stderr });
    sel.onReconnectSuccess();
    sel.onReconnectAttempt(1);
    sel.onReconnectAttempt(2);
    sel.onReconnectAttempt(3);
    sel.onReconnectAttempt(4);
    expect(sel.currentSource).toBe('smee-active');
    expect(stderr.lines).toHaveLength(1);
    sel.stop();
  });

  it('5th reconnect attempt demotes with smee-runtime-lost', () => {
    const stderr = new MockStderr();
    const sel = new SourceSelector({ initial: 'smee-attempt', stderr });
    sel.onReconnectSuccess();
    sel.onReconnectAttempt(1);
    sel.onReconnectAttempt(5);
    expect(sel.currentSource).toBe('poll-fallback');
    expect(stderr.lines).toContain(
      'cockpit doorbell: source=poll-fallback reason=smee-runtime-lost\n',
    );
    sel.stop();
  });

  it('observeElapsed past 5-min window demotes', () => {
    const stderr = new MockStderr();
    let time = 1_000_000;
    const now = (): number => time;
    const sel = new SourceSelector({
      initial: 'smee-attempt',
      stderr,
      now,
    });
    sel.onReconnectSuccess();
    time += DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS + 1;
    sel.observeElapsed();
    expect(sel.currentSource).toBe('poll-fallback');
    sel.stop();
  });

  it('re-promote timer transitions poll-fallback → smee-attempt silently', () => {
    vi.useFakeTimers();
    const stderr = new MockStderr();
    const sel = new SourceSelector({
      initial: 'smee-attempt',
      stderr,
      rePromoteIntervalMs: 100,
    });
    sel.onReconnectSuccess();
    sel.onReconnectAttempt(5); // → poll-fallback
    expect(sel.currentSource).toBe('poll-fallback');
    const beforeCount = stderr.lines.length;
    vi.advanceTimersByTime(101);
    expect(sel.currentSource).toBe('smee-attempt');
    // No new stderr line yet — deferred until connect success.
    expect(stderr.lines).toHaveLength(beforeCount);
    sel.stop();
  });

  it('post re-promote onReconnectSuccess emits smee-re-promoted', () => {
    vi.useFakeTimers();
    const stderr = new MockStderr();
    const sel = new SourceSelector({
      initial: 'smee-attempt',
      stderr,
      rePromoteIntervalMs: 100,
    });
    sel.onReconnectSuccess();
    sel.onReconnectAttempt(5);
    vi.advanceTimersByTime(101);
    sel.onReconnectSuccess();
    expect(sel.currentSource).toBe('smee-active');
    expect(stderr.lines).toContain(
      'cockpit doorbell: source=smee reason=smee-re-promoted\n',
    );
    sel.stop();
  });

  it('stop() clears timers and further calls no-op', () => {
    const stderr = new MockStderr();
    const sel = new SourceSelector({ initial: 'smee-attempt', stderr });
    sel.stop();
    sel.onReconnectAttempt(10);
    expect(sel.currentSource).toBe('smee-attempt');
    // stop is idempotent
    sel.stop();
  });

  it('successful reconnect resets counter', () => {
    const stderr = new MockStderr();
    const sel = new SourceSelector({ initial: 'smee-attempt', stderr });
    sel.onReconnectSuccess();
    sel.onReconnectAttempt(4);
    sel.onReconnectSuccess();
    sel.onReconnectAttempt(4);
    // still on smee-active, no demotion because counter reset in between
    expect(sel.currentSource).toBe('smee-active');
    sel.stop();
  });

  it('onModeChange callback fires on transition', () => {
    const stderr = new MockStderr();
    const sel = new SourceSelector({ initial: 'smee-attempt', stderr });
    const cb = vi.fn();
    sel.onModeChange(cb);
    sel.onReconnectSuccess();
    sel.onReconnectAttempt(5);
    // Callback fires on the transition to poll-fallback
    const callArgs = cb.mock.calls.map((c) => c[0]);
    expect(callArgs).toContain('poll-fallback');
    sel.stop();
  });
});
