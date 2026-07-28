/**
 * #1054 shared drop-log severity decision. Pure function; caller owns the
 * transition-edge state Map. Mirrors the `isTransition` / `lastUnresolvedThreadCount`
 * pattern at `pr-feedback-monitor-service.ts:284-286` — one severity flip
 * in, one severity flip out. Used by both the queue adapters and the four
 * monitor drop sites (FR-006 / FR-007) so all six call sites share a single
 * decision function (SC-004 severity divergence = 0 by construction).
 */

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Per-itemKey severity state, remembered across drop calls so the helper
 * can emit `warn` exactly once when the entry crosses the threshold and
 * once when it clears — never per-cycle. Callers own the Map.
 */
export interface DropTransitionState {
  lastSeverity: 'info' | 'warn';
}

export interface DropSeverityDecision {
  severity: 'info' | 'warn';
  /** True when this call flipped severity vs. the previous state for this itemKey. */
  isTransitionEdge: boolean;
  stateAfter: DropTransitionState;
}

/**
 * Decide whether this drop-log call should escalate to `warn`.
 *
 * Transition-edge semantics (per clarifications Q4=A + FR-006 addition):
 *   - Emits `warn` **once** when the entry's age first crosses `thresholdMs`.
 *   - Emits `warn` **once** when the entry clears (drops back below threshold).
 *   - Between transitions the line stays at `info` regardless of how many
 *     monitor cycles fire (this is what makes the signal actually visible in
 *     log queries — 17 identical `warn`s is the anti-pattern that hid #1054).
 *
 * A `null` `ageMs` returns `{ severity: 'info', isTransitionEdge: false }`
 * (fail-safe per FR-006/FR-007 monitor side) and does not mutate state.
 *
 * Mirrors the transition-edge pattern at `pr-feedback-monitor-service.ts:284-286`.
 *
 * @param itemKey     The in-flight itemKey (`<owner>/<repo>#<issue>`).
 * @param ageMs       Age of the in-flight entry in ms. `null` on transport error
 *                    → fall back to `info` (fail-safe).
 * @param thresholdMs `DispatchConfig.maxRunDurationMs` (default 30 min).
 * @param state       Caller-owned Map keyed by itemKey. The caller is expected
 *                    to persist `decision.stateAfter` after this call.
 */
export function classifyDropSeverity(
  itemKey: string,
  ageMs: number | null,
  thresholdMs: number,
  state: Map<string, DropTransitionState>,
): DropSeverityDecision {
  const prev = state.get(itemKey);
  const prevSeverity: 'info' | 'warn' = prev?.lastSeverity ?? 'info';

  if (ageMs === null) {
    return {
      severity: 'info',
      isTransitionEdge: false,
      stateAfter: { lastSeverity: prevSeverity },
    };
  }

  const overThreshold = ageMs > thresholdMs;
  const newSeverity: 'info' | 'warn' = overThreshold ? 'warn' : 'info';
  const isTransitionEdge = newSeverity !== prevSeverity;
  const stateAfter: DropTransitionState = { lastSeverity: newSeverity };
  state.set(itemKey, stateAfter);

  return {
    severity: newSeverity,
    isTransitionEdge,
    stateAfter,
  };
}

/**
 * Thin adapter that calls `logger.info` or `logger.warn` based on the
 * decision. Kept as a separate function so callers can unit-test the
 * classification without spying on the logger.
 *
 * Emit rule (per contract table, updated for #1054 finding 4):
 *   - isTransitionEdge=true (EITHER info→warn OR warn→info) → `logger.warn`
 *     — loud first-alert on wedge open AND loud clear on wedge close, so an
 *     operator paging on warns actually sees the wedge close instead of
 *     watching it stay open in their mental model until they check by hand
 *     (FR-008 audience: "an operator paging on warns"). The `severity` field
 *     on the payload distinguishes the two edges.
 *   - all other combinations → `logger.info` (silent for anti-spam per FR-006)
 *
 * This matches the "17 identical warns is the anti-pattern that hid #1054"
 * design constraint: a wedge produces exactly ONE `warn` line on entry
 * and ONE `warn` line on exit (plus one via `reap-orphan-claims`).
 * Subsequent drops for the same wedged itemKey between the two transitions
 * emit at `info` so log queries can still surface them but alerting stays
 * quiet.
 */
export function emitDropLog(
  logger: Logger,
  decision: DropSeverityDecision,
  payload: Record<string, unknown>,
  message: string,
): void {
  if (decision.isTransitionEdge) {
    // Attach the resolved severity so a single warn line carries whether it
    // is a wedge-open (severity='warn') or wedge-close (severity='info') edge.
    logger.warn({ ...payload, severity: decision.severity }, message);
  } else {
    logger.info(payload, message);
  }
}
