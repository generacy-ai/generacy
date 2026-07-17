import { z } from 'zod';
import type { CommandRunner } from './command-runner.js';

export interface RateLimitSchedulerOptions {
  baseIntervalMs?: number;
  ceilingMs?: number;
  probeCadenceMs?: number;
  fastProbeCadenceMs?: number;
  lowWatermarkRatio?: number;
  criticalWatermarkRatio?: number;
  resetWatermarkRatio?: number;
  runner?: CommandRunner;
  now?: () => number;
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}

export interface RateLimitProbeResult {
  remaining: number;
  limit: number;
  resetAt: number;
}

export interface RateLimitScheduler {
  getCurrentIntervalMs(): number;
  probeNow(): Promise<RateLimitProbeResult | null>;
  noteRetryAfter(seconds: number): void;
  noteResponseHeaders(headers: Record<string, string>): void;
  start(): void;
  stop(): void;
}

const DEFAULTS = {
  baseIntervalMs: 30_000,
  ceilingMs: 300_000,
  probeCadenceMs: 300_000,
  fastProbeCadenceMs: 60_000,
  lowWatermarkRatio: 0.20,
  criticalWatermarkRatio: 0.05,
  resetWatermarkRatio: 0.30,
} as const;

const RateLimitApiSchema = z.object({
  resources: z.object({
    graphql: z.object({
      remaining: z.number(),
      limit: z.number(),
      reset: z.number(),
    }),
  }),
});

export function createRateLimitScheduler(
  opts: RateLimitSchedulerOptions = {},
): RateLimitScheduler {
  const baseIntervalMs = opts.baseIntervalMs ?? DEFAULTS.baseIntervalMs;
  const ceilingMs = opts.ceilingMs ?? DEFAULTS.ceilingMs;
  const probeCadenceMs = opts.probeCadenceMs ?? DEFAULTS.probeCadenceMs;
  const fastProbeCadenceMs = opts.fastProbeCadenceMs ?? DEFAULTS.fastProbeCadenceMs;
  const lowWatermarkRatio = opts.lowWatermarkRatio ?? DEFAULTS.lowWatermarkRatio;
  const criticalWatermarkRatio =
    opts.criticalWatermarkRatio ?? DEFAULTS.criticalWatermarkRatio;
  const resetWatermarkRatio = opts.resetWatermarkRatio ?? DEFAULTS.resetWatermarkRatio;
  const runner = opts.runner;
  const now = opts.now ?? Date.now;
  const logger = opts.logger;

  if (!(resetWatermarkRatio > lowWatermarkRatio)) {
    throw new Error(
      `RateLimitScheduler: resetWatermarkRatio (${resetWatermarkRatio}) must be > lowWatermarkRatio (${lowWatermarkRatio})`,
    );
  }
  if (!(lowWatermarkRatio > criticalWatermarkRatio)) {
    throw new Error(
      `RateLimitScheduler: lowWatermarkRatio (${lowWatermarkRatio}) must be > criticalWatermarkRatio (${criticalWatermarkRatio})`,
    );
  }
  if (!(criticalWatermarkRatio > 0)) {
    throw new Error(
      `RateLimitScheduler: criticalWatermarkRatio (${criticalWatermarkRatio}) must be > 0`,
    );
  }
  if (!(ceilingMs >= baseIntervalMs)) {
    throw new Error(
      `RateLimitScheduler: ceilingMs (${ceilingMs}) must be >= baseIntervalMs (${baseIntervalMs})`,
    );
  }
  if (!(probeCadenceMs > 0) || !(fastProbeCadenceMs > 0)) {
    throw new Error(
      `RateLimitScheduler: probeCadenceMs and fastProbeCadenceMs must be > 0`,
    );
  }

  let currentIntervalMs = baseIntervalMs;
  let retryAfterUntilMs = 0;
  let lastRatio: number | null = null;
  let currentCadenceMs = probeCadenceMs;
  let probeTimer: ReturnType<typeof setInterval> | null = null;

  function clamp(ms: number): number {
    return Math.min(Math.max(ms, baseIntervalMs), ceilingMs);
  }

  function recomputeInterval(): void {
    const nowMs = now();
    if (retryAfterUntilMs > nowMs) {
      currentIntervalMs = clamp(retryAfterUntilMs - nowMs);
      return;
    }
    if (lastRatio == null) {
      currentIntervalMs = baseIntervalMs;
      return;
    }
    if (lastRatio >= resetWatermarkRatio) {
      currentIntervalMs = baseIntervalMs;
      return;
    }
    if (lastRatio < criticalWatermarkRatio) {
      currentIntervalMs = clamp(4 * baseIntervalMs);
      return;
    }
    if (lastRatio < lowWatermarkRatio) {
      currentIntervalMs = clamp(2 * baseIntervalMs);
      return;
    }
    // Hysteresis band: lowWatermarkRatio <= r < resetWatermarkRatio; retain.
  }

  function selectCadenceMs(): number {
    if (lastRatio != null && lastRatio < lowWatermarkRatio) return fastProbeCadenceMs;
    return probeCadenceMs;
  }

  function armTimer(): void {
    if (probeTimer != null) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
    const t = setInterval(() => {
      void probeNow();
    }, currentCadenceMs);
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
    probeTimer = t;
  }

  function maybeRescheduleCadence(): void {
    const next = selectCadenceMs();
    if (next !== currentCadenceMs) {
      currentCadenceMs = next;
      if (probeTimer != null) {
        armTimer();
      }
    }
  }

  async function probeNow(): Promise<RateLimitProbeResult | null> {
    if (runner == null) {
      logger?.warn?.('rate-limit-scheduler: probeNow called without runner; skipping');
      return null;
    }
    try {
      const result = await runner('gh', ['api', 'rate_limit']);
      if (result.exitCode !== 0) {
        logger?.warn?.(
          `rate-limit-scheduler: probe exit ${result.exitCode}: ${result.stderr.trim()}`,
        );
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        logger?.warn?.('rate-limit-scheduler: probe returned malformed JSON');
        return null;
      }
      const shape = RateLimitApiSchema.safeParse(parsed);
      if (!shape.success) {
        logger?.warn?.(
          `rate-limit-scheduler: probe shape mismatch: ${shape.error.message}`,
        );
        return null;
      }
      const g = shape.data.resources.graphql;
      const remaining = Math.max(0, Math.min(g.remaining, g.limit));
      const probeResult: RateLimitProbeResult = {
        remaining,
        limit: g.limit,
        resetAt: g.reset,
      };
      lastRatio = g.limit > 0 ? remaining / g.limit : 1;
      recomputeInterval();
      maybeRescheduleCadence();
      logger?.info?.(
        `rate-limit-scheduler: probe remaining=${remaining}/${g.limit} interval=${currentIntervalMs}ms`,
      );
      return probeResult;
    } catch (err) {
      logger?.warn?.(
        `rate-limit-scheduler: probe error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  function noteRetryAfter(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    retryAfterUntilMs = now() + Math.min(seconds * 1000, ceilingMs);
    recomputeInterval();
    currentCadenceMs = fastProbeCadenceMs;
    if (probeTimer != null) armTimer();
  }

  function noteResponseHeaders(headers: Record<string, string>): void {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      lower[k.toLowerCase()] = v;
    }
    const retryAfter = lower['retry-after'];
    if (retryAfter != null) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        noteRetryAfter(seconds);
      }
    }
    const remainingRaw = lower['x-ratelimit-remaining'];
    const limitRaw = lower['x-ratelimit-limit'];
    if (remainingRaw != null && limitRaw != null) {
      const remaining = Number.parseInt(remainingRaw, 10);
      const limit = Number.parseInt(limitRaw, 10);
      if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
        lastRatio = Math.max(0, Math.min(remaining, limit)) / limit;
        recomputeInterval();
        maybeRescheduleCadence();
      }
    }
  }

  function start(): void {
    if (probeTimer != null) return;
    armTimer();
  }

  function stop(): void {
    if (probeTimer != null) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
  }

  function getCurrentIntervalMs(): number {
    recomputeInterval();
    return currentIntervalMs;
  }

  return {
    getCurrentIntervalMs,
    probeNow,
    noteRetryAfter,
    noteResponseHeaders,
    start,
    stop,
  };
}
