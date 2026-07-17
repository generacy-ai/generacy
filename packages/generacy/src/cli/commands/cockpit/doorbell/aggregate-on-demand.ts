/**
 * `maybeRefreshAggregate` — Q4=A on-demand aggregate refresh. Recomputes
 * `phase-complete` / `epic-complete` events only when the current webhook
 * payload could plausibly change an aggregate state (completed:* label,
 * issue.closed, pull_request.closed). Zero GraphQL cost on non-completion
 * payloads.
 *
 * Contract: `specs/978-summary-generacy-cockpit/contracts/aggregate-on-demand.md`.
 */
import { resolveEpic, type GhWrapper, type ResolvedEpic } from '@generacy-ai/cockpit';
import { runOnePoll } from '../watch/poll-loop.js';
import { computeAggregateEvents, type AggregateState } from '../watch/aggregate.js';
import type { AggregateEvent } from '../watch/aggregate-emit.js';
import type { SnapshotMap } from '../watch/snapshot.js';

export type AggregateTrigger =
  | { kind: 'completed-label'; label: string }
  | { kind: 'issue-closed' }
  | { kind: 'pr-closed' }
  | null;

export interface AggregateRefreshInput {
  trigger: AggregateTrigger;
  epicRef: string;
  epicRepo: string;
  epicNumber: number;
  prevAgg: AggregateState;
  prev: SnapshotMap;
  currentResolved: ResolvedEpic | null;
  gh: GhWrapper;
  logger: { warn: (msg: string) => void };
  now: () => string;
}

export interface AggregateRefreshOutput {
  events: AggregateEvent[];
  nextAgg: AggregateState;
  nextPrev: SnapshotMap;
  nextResolved: ResolvedEpic | null;
}

function identity(input: AggregateRefreshInput): AggregateRefreshOutput {
  return {
    events: [],
    nextAgg: input.prevAgg,
    nextPrev: input.prev,
    nextResolved: input.currentResolved,
  };
}

export async function maybeRefreshAggregate(
  input: AggregateRefreshInput,
): Promise<AggregateRefreshOutput> {
  if (input.trigger == null) return identity(input);

  let resolved: ResolvedEpic | null = input.currentResolved;
  if (resolved == null) {
    try {
      resolved = await resolveEpic({
        epicRef: input.epicRef,
        gh: input.gh,
        logger: input.logger,
      });
    } catch (err) {
      input.logger.warn(
        `cockpit doorbell: aggregate resolveEpic failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return identity(input);
    }
  }

  let pollResult: { curr: SnapshotMap };
  try {
    pollResult = await runOnePoll(input.prev, {
      gh: input.gh,
      refs: resolved.parsed.allRefs,
      epicOwnerRepo: resolved.epic.repo,
      logger: input.logger,
    });
  } catch (err) {
    input.logger.warn(
      `cockpit doorbell: aggregate runOnePoll failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      events: [],
      nextAgg: input.prevAgg,
      nextPrev: input.prev,
      nextResolved: resolved,
    };
  }

  const aggregate = computeAggregateEvents({
    curr: pollResult.curr,
    parsed: resolved.parsed,
    epicRepo: input.epicRepo,
    epicNumber: input.epicNumber,
    prevState: input.prevAgg,
    initial: false,
    now: input.now,
  });

  return {
    events: aggregate.events,
    nextAgg: aggregate.nextState,
    nextPrev: pollResult.curr,
    nextResolved: resolved,
  };
}
