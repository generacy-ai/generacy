import { z } from 'zod';
import type { OrchestratorClient } from '@generacy-ai/cockpit';
import type { FirstFailureWarner } from '../shared/orchestrator-warn.js';

/**
 * In-process state for the orchestrator-counts state machine. Tracked across
 * watch poll ticks so we can emit only on transitions per `data-model.md §5`.
 *
 * Held in the watch loop as `prevOrchestrator: OrchestratorCountsState | null`
 * (null = pre-first-tick / startup).
 */
export type OrchestratorCountsState =
  | { kind: 'available'; jobs: number; workers: number }
  | { kind: 'unavailable'; reason: string };

/**
 * The NDJSON event written to stdout for one orchestrator-counts transition.
 * Contract: `contracts/cockpit-output.md §C`.
 *
 * Two shapes — available (`type` + `jobs` + `workers`) and unavailable
 * (`type` + `available: false` + `reason`). Discriminating on presence-of-
 * `available` rather than a single string field; see schema below.
 */
export type OrchestratorCountsEvent =
  | { type: 'orchestrator-counts'; jobs: number; workers: number }
  | { type: 'orchestrator-counts'; available: false; reason: string };

/**
 * Zod schema for `OrchestratorCountsEvent`. Used to validate every event
 * before write (mirrors the `CockpitEventSchema` pattern in `watch/emit.ts`).
 *
 * NOTE: this is `z.union`, NOT `z.discriminatedUnion`. The two branches share
 * the same value for `type` and differ on the presence of `available` —
 * `discriminatedUnion` requires a single field whose literal differs between
 * branches, which doesn't fit this shape. The runtime validation guarantee is
 * the same.
 */
export const OrchestratorCountsEventSchema = z.union([
  z.object({
    type: z.literal('orchestrator-counts'),
    jobs: z.number().int().nonnegative(),
    workers: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('orchestrator-counts'),
    available: z.literal(false),
    reason: z.string(),
  }),
]);

const DEFAULT_TIMEOUT_MS = 1500;

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    setTimeout(() => resolve(value), ms).unref?.();
  });
}

function shouldEmit(
  prev: OrchestratorCountsState | null,
  curr: OrchestratorCountsState,
): boolean {
  if (prev === null) return true;
  if (prev.kind === 'available' && curr.kind === 'available') {
    return prev.jobs !== curr.jobs || prev.workers !== curr.workers;
  }
  if (prev.kind === 'unavailable' && curr.kind === 'unavailable') {
    return prev.reason !== curr.reason;
  }
  // available <-> unavailable transitions always emit
  return true;
}

function toEvent(curr: OrchestratorCountsState): OrchestratorCountsEvent {
  if (curr.kind === 'available') {
    return {
      type: 'orchestrator-counts',
      jobs: curr.jobs,
      workers: curr.workers,
    };
  }
  return {
    type: 'orchestrator-counts',
    available: false,
    reason: curr.reason,
  };
}

/**
 * Poll the orchestrator once and decide whether to emit an
 * `orchestrator-counts` event.
 *
 * Mirrors the `getFooter` Promise.race timeout pattern in
 * `shared/orchestrator-footer.ts`. Never throws — any failure
 * (timeout, http-error, cloud-unreachable, no-token) maps to a
 * `{kind: 'unavailable', reason}` `curr` state. The watch loop is
 * therefore guaranteed not to die on orchestrator outages
 * (SC-005 / spec §FR-008).
 *
 * Side effect: when `curr.kind === 'unavailable'` and `reason !== 'no-token'`,
 * calls `onFirstFailure(reason)`. The warner self-dedupes across ticks, so
 * the stderr line is written at most once per CLI invocation.
 *
 * Emit decision follows `data-model.md §5`:
 * - `prev === null` (startup) → always emit baseline.
 * - both `available` with same counts → no event.
 * - both `available` with any count change → emit.
 * - either side a transition (avail↔unavail) → emit.
 * - both `unavailable` with same reason → no event.
 * - both `unavailable` with different reason → emit.
 */
export async function pollOrchestratorCounts(
  client: OrchestratorClient,
  prev: OrchestratorCountsState | null,
  onFirstFailure: FirstFailureWarner,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ event: OrchestratorCountsEvent | null; curr: OrchestratorCountsState }> {
  let curr: OrchestratorCountsState;
  try {
    const sentinel = Symbol('timeout');
    const races = await Promise.all([
      Promise.race([client.getJobs(), timeout(timeoutMs, sentinel)]),
      Promise.race([client.getWorkers(), timeout(timeoutMs, sentinel)]),
    ]);
    const [jobsResult, workersResult] = races;
    if (jobsResult === sentinel || workersResult === sentinel) {
      curr = { kind: 'unavailable', reason: 'timeout' };
    } else if (!jobsResult.available) {
      curr = { kind: 'unavailable', reason: jobsResult.reason };
    } else if (!workersResult.available) {
      curr = { kind: 'unavailable', reason: workersResult.reason };
    } else {
      curr = {
        kind: 'available',
        jobs: jobsResult.jobs.length,
        workers: workersResult.count,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    curr = { kind: 'unavailable', reason: msg.length > 0 ? msg : 'unknown' };
  }

  if (curr.kind === 'unavailable' && curr.reason !== 'no-token') {
    onFirstFailure(curr.reason);
  }

  if (!shouldEmit(prev, curr)) {
    return { event: null, curr };
  }

  const event = OrchestratorCountsEventSchema.parse(toEvent(curr)) as OrchestratorCountsEvent;
  return { event, curr };
}
