import type { LinkedPR, WorkflowState } from '../types/store.js';

/**
 * Append a linked PR entry to workflow state, de-duplicating on `repo + number`.
 * If an entry with the same key exists, it is replaced (update-on-duplicate).
 * Returns a new state object — the original is not mutated.
 */
export function addLinkedPR(state: WorkflowState, entry: LinkedPR): WorkflowState {
  const existing = state.linkedPRs ?? [];
  const idx = existing.findIndex(
    (e) => e.repo === entry.repo && e.number === entry.number,
  );

  const updated =
    idx >= 0
      ? existing.map((e, i) => (i === idx ? entry : e))
      : [...existing, entry];

  return { ...state, linkedPRs: updated };
}
