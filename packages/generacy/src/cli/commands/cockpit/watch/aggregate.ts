import type { ParsedEpicBody, ParsedPhase } from '@generacy-ai/cockpit';
import type { AggregateEvent } from './aggregate-emit.js';
import { snapshotKey, type SnapshotMap } from './snapshot.js';

export interface AggregateState {
  seenCompletePhases: Set<string>;
  epicComplete: boolean;
}

export function initialAggregateState(): AggregateState {
  return { seenCompletePhases: new Set(), epicComplete: false };
}

export interface AggregateComputeInput {
  curr: SnapshotMap;
  parsed: ParsedEpicBody;
  epicRepo: string;
  epicNumber: number;
  prevState: AggregateState;
  initial: boolean;
  now: () => string;
}

export interface AggregateComputeResult {
  events: AggregateEvent[];
  nextState: AggregateState;
}

export function isPhaseComplete(phase: ParsedPhase, curr: SnapshotMap): boolean {
  if (phase.refs.length === 0) return false;
  return phase.refs.every((ref) => {
    const snap =
      curr.get(snapshotKey(ref.repo, 'issue', ref.number)) ??
      curr.get(snapshotKey(ref.repo, 'pr', ref.number));
    return snap != null && snap.state === 'CLOSED';
  });
}

export function isEpicComplete(parsed: ParsedEpicBody, curr: SnapshotMap): boolean {
  if (parsed.allRefs.length === 0) return false;
  return parsed.allRefs.every((ref) => {
    const snap =
      curr.get(snapshotKey(ref.repo, 'issue', ref.number)) ??
      curr.get(snapshotKey(ref.repo, 'pr', ref.number));
    return snap != null && snap.state === 'CLOSED';
  });
}

export function computeAggregateEvents(
  input: AggregateComputeInput,
): AggregateComputeResult {
  const nextState: AggregateState = {
    seenCompletePhases: new Set(input.prevState.seenCompletePhases),
    epicComplete: input.prevState.epicComplete,
  };
  const events: AggregateEvent[] = [];

  for (const phase of input.parsed.phases) {
    const nowComplete = isPhaseComplete(phase, input.curr);
    const wasComplete = input.prevState.seenCompletePhases.has(phase.token);
    if (nowComplete && !wasComplete) {
      const ev: AggregateEvent = {
        type: 'phase-complete',
        phase: phase.heading,
        epicRepo: input.epicRepo,
        epicNumber: input.epicNumber,
        ts: input.now(),
      };
      if (input.initial) ev.initial = true;
      events.push(ev);
      nextState.seenCompletePhases.add(phase.token);
    } else if (!nowComplete && wasComplete) {
      nextState.seenCompletePhases.delete(phase.token);
    }
  }

  const epicNow = isEpicComplete(input.parsed, input.curr);
  if (epicNow && !input.prevState.epicComplete) {
    const ev: AggregateEvent = {
      type: 'epic-complete',
      epicRepo: input.epicRepo,
      epicNumber: input.epicNumber,
      ts: input.now(),
    };
    if (input.initial) ev.initial = true;
    events.push(ev);
    nextState.epicComplete = true;
  } else if (!epicNow && input.prevState.epicComplete) {
    nextState.epicComplete = false;
  }

  return { events, nextState };
}
