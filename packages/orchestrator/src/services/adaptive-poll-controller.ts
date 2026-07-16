/**
 * #953 — Shared adaptive-polling decision function used by
 * `LabelMonitorService`, `PrFeedbackMonitorService`, and
 * `MergeConflictMonitorService`. Extracted to eliminate the three-way
 * copy-paste that produced the "smee-less cluster stuck at base cadence" bug.
 *
 * Pure: no I/O, no `this`, no `Date.now()`. Time flows in via `params.nowMs`.
 */

export interface AdaptivePollParams {
  /** From MonitorState — construction-time constant. */
  webhooksConfigured: boolean;
  /** From service options — reflects the config knob. */
  adaptivePolling: boolean;
  /** Configured base cadence. */
  basePollIntervalMs: number;
  /** Current cadence being run at (for transition detection). */
  currentPollIntervalMs: number;
  /** From MonitorState — null when never received. */
  lastWebhookEvent: number | null;
  /** From MonitorState — current health belief. */
  webhookHealthy: boolean;
  /** Per-service tuning: LabelMonitor=3, PrFeedback=2, MergeConflict=2. */
  adaptiveDivisor: number;
  /** Per-service tuning: 10_000 across all three today. */
  minPollIntervalMs: number;
  /**
   * Injected for testability. Callers pass `Date.now()`.
   * Only consulted on the `webhooksConfigured === true` branch.
   */
  nowMs: number;
}

export type AdaptivePollReason =
  | 'webhooks-not-configured'
  | 'operator-opt-out'
  | 'webhook-stale'
  | 'webhook-recovered'
  | 'quiet';

export interface AdaptivePollDecision {
  /** New effective cadence to run at. */
  currentPollIntervalMs: number;
  /** New health belief. Meaningful only when `webhooksConfigured === true`. */
  webhookHealthy: boolean;
  /**
   * Whether an edge fired this call. Callers gate log emission on this.
   * - 'to-fast': cadence dropped to the adaptive fast interval
   * - 'to-base': cadence returned to base (webhook recovered)
   * - 'none':    no cadence change
   */
  transition: 'to-fast' | 'to-base' | 'none';
  /** Why the decision was reached — stable per parameter shape. */
  reason: AdaptivePollReason;
}

/**
 * Fast interval calculation shared between `decideAdaptivePoll` and callers
 * that need the value at construction time.
 */
export function computeFastInterval(
  basePollIntervalMs: number,
  adaptiveDivisor: number,
  minPollIntervalMs: number,
): number {
  return Math.max(minPollIntervalMs, Math.floor(basePollIntervalMs / adaptiveDivisor));
}

/**
 * Decide the next poll cadence given current state and tuning.
 *
 * Branch summary:
 * - webhooksConfigured=false, adaptivePolling=true:
 *     cycle 1  → { fast, healthy=false, to-fast, webhooks-not-configured }
 *     cycle 2+ → { fast, healthy=false, none,    webhooks-not-configured }
 * - webhooksConfigured=false, adaptivePolling=false:
 *     always   → { base, healthy=true,  none,    operator-opt-out }
 * - webhooksConfigured=true, lastWebhookEvent===null:
 *     always   → { unchanged, unchanged, none,   quiet }
 * - webhooksConfigured=true, lastWebhookEvent!==null:
 *     staleness = nowMs - lastWebhookEvent; threshold = basePoll * 2
 *     if (staleness > threshold && webhookHealthy) → to-fast, webhook-stale
 *     else → { unchanged, unchanged, none, quiet }
 *
 * The `recordWebhookEvent` handler in each service also delegates here for
 * the recovery path — it flips `webhookHealthy=true` and `lastWebhookEvent`
 * before calling; the helper returns `to-base, webhook-recovered` when the
 * caller was previously at the fast interval.
 */
export function decideAdaptivePoll(params: AdaptivePollParams): AdaptivePollDecision {
  const {
    webhooksConfigured,
    adaptivePolling,
    basePollIntervalMs,
    currentPollIntervalMs,
    lastWebhookEvent,
    webhookHealthy,
    adaptiveDivisor,
    minPollIntervalMs,
    nowMs,
  } = params;

  const fastIntervalMs = computeFastInterval(basePollIntervalMs, adaptiveDivisor, minPollIntervalMs);

  if (!webhooksConfigured) {
    if (!adaptivePolling) {
      return {
        currentPollIntervalMs: basePollIntervalMs,
        webhookHealthy: true,
        transition: 'none',
        reason: 'operator-opt-out',
      };
    }
    // adaptivePolling === true, webhooksConfigured === false:
    // fast interval, unhealthy. Emit `to-fast` on the transition edge only.
    const transition = webhookHealthy ? 'to-fast' : 'none';
    return {
      currentPollIntervalMs: fastIntervalMs,
      webhookHealthy: false,
      transition,
      reason: 'webhooks-not-configured',
    };
  }

  // webhooksConfigured === true from here on.

  if (lastWebhookEvent === null) {
    // Grace: never received an event, don't ratchet down cadence.
    return {
      currentPollIntervalMs,
      webhookHealthy,
      transition: 'none',
      reason: 'quiet',
    };
  }

  const staleness = nowMs - lastWebhookEvent;
  const staleThreshold = basePollIntervalMs * 2;

  // Recovery path: caller set webhookHealthy=true before delegating.
  // If we're on the fast interval, transition back to base.
  if (webhookHealthy && currentPollIntervalMs !== basePollIntervalMs) {
    return {
      currentPollIntervalMs: basePollIntervalMs,
      webhookHealthy: true,
      transition: 'to-base',
      reason: 'webhook-recovered',
    };
  }

  if (staleness > staleThreshold && webhookHealthy) {
    return {
      currentPollIntervalMs: fastIntervalMs,
      webhookHealthy: false,
      transition: 'to-fast',
      reason: 'webhook-stale',
    };
  }

  return {
    currentPollIntervalMs,
    webhookHealthy,
    transition: 'none',
    reason: 'quiet',
  };
}
