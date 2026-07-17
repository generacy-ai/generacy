import { describe, expect, it, vi } from 'vitest';
import { createRateLimitScheduler } from '../gh/rate-limit-scheduler.js';
import type { CommandRunner } from '../gh/command-runner.js';

function probeRunner(remaining: number, limit = 5000): CommandRunner {
  return vi.fn(async () => ({
    stdout: JSON.stringify({
      resources: { graphql: { remaining, limit, reset: 0 } },
    }),
    stderr: '',
    exitCode: 0,
  }));
}

describe('RateLimitScheduler', () => {
  describe('ladder table', () => {
    it('r >= 0.30 → base interval (reset)', async () => {
      const s = createRateLimitScheduler({ runner: probeRunner(2000) });
      await s.probeNow();
      expect(s.getCurrentIntervalMs()).toBe(30_000);
    });

    it('0.20 <= r < 0.30 → hysteresis: previous interval retained', async () => {
      const s = createRateLimitScheduler({ runner: probeRunner(1250) });
      const initial = s.getCurrentIntervalMs();
      await s.probeNow();
      expect(s.getCurrentIntervalMs()).toBe(initial);
      expect(s.getCurrentIntervalMs()).toBe(30_000);
    });

    it('0.20 <= r < 0.30 after widening: retains widened value', async () => {
      const s = createRateLimitScheduler({});
      const r1 = createRateLimitScheduler({ runner: probeRunner(750) });
      // start with a widened interval by probing at low
      const widen = createRateLimitScheduler({ runner: probeRunner(500) });
      await widen.probeNow();
      expect(widen.getCurrentIntervalMs()).toBe(60_000);
      // Same scheduler now sees hysteresis band probe
      const runnerRef = { value: probeRunner(1200) };
      const s2 = createRateLimitScheduler({ runner: (cmd, args) => runnerRef.value(cmd, args) });
      // Simulate: first probe at 500 -> widened
      runnerRef.value = probeRunner(500);
      await s2.probeNow();
      expect(s2.getCurrentIntervalMs()).toBe(60_000);
      // Then probe in hysteresis band -> retain widened
      runnerRef.value = probeRunner(1200);
      await s2.probeNow();
      expect(s2.getCurrentIntervalMs()).toBe(60_000);
      // Above reset -> back to base
      runnerRef.value = probeRunner(2000);
      await s2.probeNow();
      expect(s2.getCurrentIntervalMs()).toBe(30_000);
      // Silence unused vars
      void r1;
      void s;
    });

    it('0.05 <= r < 0.20 → 2× base', async () => {
      const s = createRateLimitScheduler({ runner: probeRunner(500) });
      await s.probeNow();
      expect(s.getCurrentIntervalMs()).toBe(60_000);
    });

    it('r < 0.05 → 4× base (clamped to ceiling)', async () => {
      const s = createRateLimitScheduler({ runner: probeRunner(100) });
      await s.probeNow();
      expect(s.getCurrentIntervalMs()).toBe(120_000);
    });

    it('4× base never exceeds ceiling', async () => {
      const s = createRateLimitScheduler({
        baseIntervalMs: 100_000,
        ceilingMs: 250_000,
        runner: probeRunner(100),
      });
      await s.probeNow();
      expect(s.getCurrentIntervalMs()).toBe(250_000);
    });
  });

  describe('retry-after', () => {
    it('overrides ladder while active', () => {
      let clock = 0;
      const s = createRateLimitScheduler({ now: () => clock });
      s.noteRetryAfter(60);
      expect(s.getCurrentIntervalMs()).toBe(60_000);
      clock += 30_000;
      expect(s.getCurrentIntervalMs()).toBe(30_000);
      clock += 30_000;
      expect(s.getCurrentIntervalMs()).toBe(30_000);
    });

    it('clamps to ceiling', () => {
      const s = createRateLimitScheduler({ ceilingMs: 60_000 });
      s.noteRetryAfter(3600);
      expect(s.getCurrentIntervalMs()).toBe(60_000);
    });
  });

  describe('failed probe', () => {
    it('leaves interval unchanged', async () => {
      const runner: CommandRunner = vi.fn(async () => ({
        stdout: '',
        stderr: 'boom',
        exitCode: 1,
      }));
      const s = createRateLimitScheduler({ runner });
      const before = s.getCurrentIntervalMs();
      const r = await s.probeNow();
      expect(r).toBeNull();
      expect(s.getCurrentIntervalMs()).toBe(before);
    });

    it('malformed JSON leaves interval unchanged', async () => {
      const runner: CommandRunner = vi.fn(async () => ({
        stdout: 'not json',
        stderr: '',
        exitCode: 0,
      }));
      const s = createRateLimitScheduler({ runner });
      const before = s.getCurrentIntervalMs();
      const r = await s.probeNow();
      expect(r).toBeNull();
      expect(s.getCurrentIntervalMs()).toBe(before);
    });
  });

  describe('construction validation', () => {
    it('throws on inverted low/reset watermarks', () => {
      expect(() =>
        createRateLimitScheduler({
          lowWatermarkRatio: 0.5,
          resetWatermarkRatio: 0.2,
        }),
      ).toThrow(/resetWatermarkRatio.*lowWatermarkRatio/);
    });

    it('throws on inverted critical/low watermarks', () => {
      expect(() =>
        createRateLimitScheduler({
          lowWatermarkRatio: 0.01,
          criticalWatermarkRatio: 0.5,
        }),
      ).toThrow(/lowWatermarkRatio.*criticalWatermarkRatio/);
    });

    it('throws when ceilingMs < baseIntervalMs', () => {
      expect(() =>
        createRateLimitScheduler({
          baseIntervalMs: 60_000,
          ceilingMs: 30_000,
        }),
      ).toThrow(/ceilingMs.*baseIntervalMs/);
    });

    it('throws on non-positive criticalWatermarkRatio', () => {
      expect(() =>
        createRateLimitScheduler({ criticalWatermarkRatio: 0 }),
      ).toThrow(/criticalWatermarkRatio/);
    });
  });

  describe('start/stop idempotency', () => {
    it('start called twice is a no-op', () => {
      const s = createRateLimitScheduler({ runner: probeRunner(3000) });
      s.start();
      s.start();
      s.stop();
    });

    it('stop called twice is a no-op', () => {
      const s = createRateLimitScheduler({ runner: probeRunner(3000) });
      s.start();
      s.stop();
      s.stop();
    });
  });
});
