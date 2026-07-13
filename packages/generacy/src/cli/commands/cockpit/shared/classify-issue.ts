import type { CockpitState } from '@generacy-ai/cockpit';
import { classify } from '@generacy-ai/cockpit';

export interface ClassifiedIssue {
  state: CockpitState;
  sourceLabel: string;
  labels: string[];
}

/**
 * Thin wrapper over `classify(labels)` — always returns `{ state, sourceLabel, labels }`
 * with `labels` preserved alongside the classification.
 */
export function classifyIssue(labels: string[]): ClassifiedIssue {
  const { state, sourceLabel } = classify(labels);
  return { state, sourceLabel, labels: [...labels] };
}
