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

  it('observeElapsed past 90s window demotes', () => {
    const stderr = new MockStderr();
    let time = 1_000_000;
    const now = (): number => time;
    const sel = new SourceSelector({
      initial: 'smee-attempt',
      stderr,
      now,
    });
    expect(DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS).toBe(90_000);
    sel.onReconnectSuccess();
    time += DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS + 1;
    sel.observeElapsed();
    expect(sel.currentSource).toBe('poll-fallback');
    sel.stop();
  });

  it('(a) onSseBytes() refreshes liveness so a ≥60-min quiet stream does not demote', () => {
    vi.useFakeTimers();
    const stderr = new MockStderr();
    let time = 1_000_000;
    const now = (): number => time;
    const sel = new SourceSelector({
      initial: 'smee-attempt',
      stderr,
      now,
    });
    sel.onReconnectSuccess();
    expect(sel.currentSource).toBe('smee-active');

    // Simulate 60 minutes of virtual time with an onSseBytes call every 30s.
    const totalMs = 60 * 60 * 1000;
    const stepMs = 30_000;
    for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
      time += stepMs;
      sel.onSseBytes();
      sel.observeElapsed();
    }
    expect(sel.currentSource).toBe('smee-active');
    // Never demoted: only the startup line on stderr.
    expect(stderr.lines).toHaveLength(1);
    sel.stop();
  });

  it('(b) smee-active without onSseBytes past 90s demotes with smee-runtime-lost', () => {
    vi.useFakeTimers();
    const stderr = new MockStderr();
    let time = 1_000_000;
    const now = (): number => time;
    const sel = new SourceSelector({
      initial: 'smee-attempt',
      stderr,
      now,
    });
    sel.onReconnectSuccess();
    // Get a few bytes, then stop.
    sel.onSseBytes();
    sel.onSseBytes();
    time += 91_000;
    sel.observeElapsed();
    expect(sel.currentSource).toBe('poll-fallback');
    expect(stderr.lines).toContain(
      'cockpit doorbell: source=poll-fallback reason=smee-runtime-lost\n',
    );
    sel.stop();
  });

  it('(c) onReconnectSuccess from poll-fallback transitions to smee-active with smee-re-promoted', () => {
    vi.useFakeTimers();
    const stderr = new MockStderr();
    const sel = new SourceSelector({
      initial: 'smee-attempt',
      stderr,
      rePromoteIntervalMs: 100,
    });
    sel.onReconnectSuccess();
    sel.onReconnectAttempt(5); // → poll-fallback with smee-runtime-lost
    expect(sel.currentSource).toBe('poll-fallback');
    // Bridge exit: background smee reconnected.
    sel.onReconnectSuccess();
    expect(sel.currentSource).toBe('smee-active');
    expect(stderr.lines).toContain(
      'cockpit doorbell: source=smee reason=smee-re-promoted\n',
    );
    // rePromoteTimer should be cleared: advancing past its interval must
    // not trigger a further transition.
    const beforeCount = stderr.lines.length;
    vi.advanceTimersByTime(500);
    expect(sel.currentSource).toBe('smee-active');
    expect(stderr.lines).toHaveLength(beforeCount);
    sel.stop();
  });

  it('(d) markStartupSmeeFailed from smee-attempt transitions to poll-fallback with startup-smee-failed', () => {
    vi.useFakeTimers();
    const stderr = new MockStderr();
    const cb = vi.fn();
    const sel = new SourceSelector({
      initial: 'smee-attempt',
      stderr,
      rePromoteIntervalMs: 100,
    });
    sel.onModeChange(cb);
    const cbCallsBefore = cb.mock.calls.length;
    sel.markStartupSmeeFailed();
    expect(sel.currentSource).toBe('poll-fallback');
    expect(stderr.lines).toContain(
      'cockpit doorbell: source=poll-fallback reason=startup-smee-failed\n',
    );
    // Callback fired exactly once with (poll-fallback, startup-smee-failed).
    expect(cb.mock.calls.length - cbCallsBefore).toBe(1);
    expect(cb.mock.calls[cbCallsBefore]).toEqual(['poll-fallback', 'startup-smee-failed']);
    // rePromoteTimer is armed: advancing past its interval transitions to
    // smee-attempt silently.
    vi.advanceTimersByTime(101);
    expect(sel.currentSource).toBe('smee-attempt');
    sel.stop();
  });

  it('(d) markStartupSmeeFailed from any state other than smee-attempt is a no-op', () => {
    const stderr = new MockStderr();
    const sel = new SourceSelector({ initial: 'smee-attempt', stderr });
    sel.onReconnectSuccess(); // → smee-active
    const before = stderr.lines.length;
    sel.markStartupSmeeFailed();
    expect(sel.currentSource).toBe('smee-active');
    expect(stderr.lines).toHaveLength(before);
    sel.stop();
  });

  it('onSseBytes is a no-op unless _current === smee-active', () => {
    const stderr = new MockStderr();
    let time = 1_000_000;
    const sel = new SourceSelector({
      initial: 'smee-attempt',
      stderr,
      now: () => time,
    });
    // In smee-attempt: no-op.
    sel.onSseBytes();
    // Enter smee-active: refresh works.
    sel.onReconnectSuccess();
    const originalLastConnect = time;
    time += 5_000;
    sel.onSseBytes();
    // Verify by advancing past demotion window and confirming no demotion:
    // if lastSuccessfulConnectAt was refreshed to `originalLastConnect + 5_000`,
    // elapsed after +80_000 more = 80_000 < 90_000 → no demotion.
    time += 80_000;
    sel.observeElapsed();
    expect(sel.currentSource).toBe('smee-active');
    // If refresh had NOT happened, elapsed would be 85_000, still < 90_000
    // — so also assert that repeat call refreshes further.
    time += 20_000; // now 100_000 since originalLastConnect
    sel.onSseBytes();
    time += 80_000;
    sel.observeElapsed();
    expect(sel.currentSource).toBe('smee-active');

    // Sanity: originalLastConnect used only for readability; without
    // onSseBytes, time+180s from onReconnectSuccess would demote.
    void originalLastConnect;

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
