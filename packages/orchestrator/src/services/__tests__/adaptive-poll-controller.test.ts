import { describe, it, expect } from 'vitest';
import {
  decideAdaptivePoll,
  computeFastInterval,
  type AdaptivePollParams,
} from '../adaptive-poll-controller.js';

/**
 * Base parameter shape. Each test overrides only what it exercises.
 * NOTE: `basePollIntervalMs=60_000, adaptiveDivisor=3, minPollIntervalMs=10_000`
 * ensures the clamp does NOT bind (fast=20_000), so a wrong divisor is
 * detectable. See contract §Clamp-vs-Divide Coverage.
 */
function baseParams(overrides: Partial<AdaptivePollParams> = {}): AdaptivePollParams {
  return {
    webhooksConfigured: false,
    adaptivePolling: true,
    basePollIntervalMs: 60_000,
    currentPollIntervalMs: 60_000,
    lastWebhookEvent: null,
    webhookHealthy: true,
    adaptiveDivisor: 3,
    minPollIntervalMs: 10_000,
    nowMs: 1_000_000,
    ...overrides,
  };
}

describe('computeFastInterval', () => {
  it('divides when result exceeds min (clamp does not bind)', () => {
    expect(computeFastInterval(60_000, 3, 10_000)).toBe(20_000);
  });

  it('clamps to min when division falls below', () => {
    expect(computeFastInterval(30_000, 3, 10_000)).toBe(10_000);
  });

  it('clamps to min when divisor produces sub-min value', () => {
    expect(computeFastInterval(15_000, 2, 10_000)).toBe(10_000);
  });

  it('floors the divide result', () => {
    // 25_000 / 3 = 8_333.33 → floor 8_333 → clamped to 10_000
    expect(computeFastInterval(25_000, 3, 10_000)).toBe(10_000);
    // 100_000 / 3 = 33_333.33 → floor 33_333 (clamp does not bind)
    expect(computeFastInterval(100_000, 3, 10_000)).toBe(33_333);
  });
});

describe('decideAdaptivePoll', () => {
  // Contract §Test Matrix row 1: cycle 1 on smee-less + adaptive → to-fast
  it('row 1: webhooksConfigured=false, adaptivePolling=true, healthy=true → to-fast, webhooks-not-configured, fast', () => {
    const result = decideAdaptivePoll(baseParams({
      webhooksConfigured: false,
      adaptivePolling: true,
      webhookHealthy: true,
      lastWebhookEvent: null,
    }));
    expect(result).toEqual({
      currentPollIntervalMs: 20_000,
      webhookHealthy: false,
      transition: 'to-fast',
      reason: 'webhooks-not-configured',
    });
  });

  // Contract §Test Matrix row 2: cycle 2+ is idempotent
  it('row 2: webhooksConfigured=false, adaptivePolling=true, healthy=false → none, webhooks-not-configured, fast', () => {
    const result = decideAdaptivePoll(baseParams({
      webhooksConfigured: false,
      adaptivePolling: true,
      webhookHealthy: false,
      lastWebhookEvent: null,
    }));
    expect(result).toEqual({
      currentPollIntervalMs: 20_000,
      webhookHealthy: false,
      transition: 'none',
      reason: 'webhooks-not-configured',
    });
  });

  // Contract §Test Matrix row 3: adaptivePolling=false wins
  it('row 3: webhooksConfigured=false, adaptivePolling=false → none, operator-opt-out, base', () => {
    const result = decideAdaptivePoll(baseParams({
      webhooksConfigured: false,
      adaptivePolling: false,
      webhookHealthy: true,
      lastWebhookEvent: null,
    }));
    expect(result).toEqual({
      currentPollIntervalMs: 60_000,
      webhookHealthy: true,
      transition: 'none',
      reason: 'operator-opt-out',
    });
  });

  // Contract §Test Matrix row 4: configured but quiet → grace applies
  it('row 4: webhooksConfigured=true, lastWebhookEvent=null → none, quiet, unchanged', () => {
    const result = decideAdaptivePoll(baseParams({
      webhooksConfigured: true,
      adaptivePolling: true,
      webhookHealthy: true,
      lastWebhookEvent: null,
      currentPollIntervalMs: 60_000,
    }));
    expect(result).toEqual({
      currentPollIntervalMs: 60_000,
      webhookHealthy: true,
      transition: 'none',
      reason: 'quiet',
    });
  });

  // Contract §Test Matrix row 5: configured, stale, healthy → transition to fast
  it('row 5: webhooksConfigured=true, staleness > threshold, healthy=true → to-fast, webhook-stale, fast', () => {
    const lastWebhookEvent = 100_000;
    const nowMs = lastWebhookEvent + 3 * 60_000; // 3x base
    const result = decideAdaptivePoll(baseParams({
      webhooksConfigured: true,
      adaptivePolling: true,
      webhookHealthy: true,
      lastWebhookEvent,
      nowMs,
      currentPollIntervalMs: 60_000,
    }));
    expect(result).toEqual({
      currentPollIntervalMs: 20_000,
      webhookHealthy: false,
      transition: 'to-fast',
      reason: 'webhook-stale',
    });
  });

  // Contract §Test Matrix row 6: already stale (unhealthy), stays quiet
  it('row 6: webhooksConfigured=true, staleness > threshold, healthy=false → none, quiet, unchanged', () => {
    const lastWebhookEvent = 100_000;
    const nowMs = lastWebhookEvent + 3 * 60_000;
    const result = decideAdaptivePoll(baseParams({
      webhooksConfigured: true,
      adaptivePolling: true,
      webhookHealthy: false,
      lastWebhookEvent,
      nowMs,
      currentPollIntervalMs: 20_000, // already at fast
    }));
    expect(result).toEqual({
      currentPollIntervalMs: 20_000,
      webhookHealthy: false,
      transition: 'none',
      reason: 'quiet',
    });
  });

  // Contract §Test Matrix row 7: within threshold, no change
  it('row 7: webhooksConfigured=true, staleness within threshold → none, quiet, unchanged', () => {
    const lastWebhookEvent = 100_000;
    const nowMs = lastWebhookEvent + 60_000; // 1x base, below 2x threshold
    const result = decideAdaptivePoll(baseParams({
      webhooksConfigured: true,
      adaptivePolling: true,
      webhookHealthy: true,
      lastWebhookEvent,
      nowMs,
      currentPollIntervalMs: 60_000,
    }));
    expect(result).toEqual({
      currentPollIntervalMs: 60_000,
      webhookHealthy: true,
      transition: 'none',
      reason: 'quiet',
    });
  });

  // Contract §Recovery path row: `recordWebhookEvent` delegate
  it('recovery: webhooksConfigured=true, currently fast, caller flips healthy=true → to-base, webhook-recovered, base', () => {
    // Caller (recordWebhookEvent) already set:
    //   state.lastWebhookEvent = nowMs
    //   state.webhookHealthy = true
    // We were previously at the fast interval.
    const nowMs = 500_000;
    const result = decideAdaptivePoll(baseParams({
      webhooksConfigured: true,
      adaptivePolling: true,
      webhookHealthy: true,
      lastWebhookEvent: nowMs,
      nowMs,
      currentPollIntervalMs: 20_000, // was at fast
    }));
    expect(result).toEqual({
      currentPollIntervalMs: 60_000,
      webhookHealthy: true,
      transition: 'to-base',
      reason: 'webhook-recovered',
    });
  });

  // Clamp coverage: default LabelMonitor (30s base, divisor 3) — clamp binds
  it('clamp-binding case: base=30_000, divisor=3, min=10_000 → fast=10_000', () => {
    const result = decideAdaptivePoll(baseParams({
      basePollIntervalMs: 30_000,
      currentPollIntervalMs: 30_000,
      adaptiveDivisor: 3,
      webhooksConfigured: false,
      adaptivePolling: true,
      webhookHealthy: true,
    }));
    expect(result.currentPollIntervalMs).toBe(10_000);
    expect(result.transition).toBe('to-fast');
  });

  // Invariant guard: interval never exceeds base
  it('invariant: currentPollIntervalMs never exceeds basePollIntervalMs', () => {
    const params = baseParams({
      webhooksConfigured: true,
      lastWebhookEvent: 100,
      nowMs: 200,
      currentPollIntervalMs: 60_000,
    });
    const result = decideAdaptivePoll(params);
    expect(result.currentPollIntervalMs).toBeLessThanOrEqual(params.basePollIntervalMs);
  });

  // Invariant guard: interval never falls below min
  it('invariant: currentPollIntervalMs never falls below minPollIntervalMs', () => {
    const params = baseParams({
      basePollIntervalMs: 15_000,
      adaptiveDivisor: 5,
      minPollIntervalMs: 10_000,
      webhooksConfigured: false,
      adaptivePolling: true,
    });
    const result = decideAdaptivePoll(params);
    expect(result.currentPollIntervalMs).toBeGreaterThanOrEqual(params.minPollIntervalMs);
  });
});
