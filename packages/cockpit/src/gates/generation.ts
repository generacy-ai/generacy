import type { IssueRef } from './schemas.js';
import type { ArtifactReviewKind } from './types.js';

// Note: untrusted callers should validate `kind` via ArtifactReviewKindSchema.parse before calling.

export interface ClarificationGenerationInput {
  batchId: string;
}
export function deriveClarificationGeneration(input: ClarificationGenerationInput): string {
  return input.batchId;
}

export interface ArtifactReviewGenerationInput {
  kind: ArtifactReviewKind;
  headSha: string;
}
export function deriveArtifactReviewGeneration(input: ArtifactReviewGenerationInput): string {
  return `${input.kind}:${input.headSha}`;
}

export interface ImplementationReviewGenerationInput {
  headSha: string;
}
export function deriveImplementationReviewGeneration(
  input: ImplementationReviewGenerationInput,
): string {
  return input.headSha;
}

export interface ManualValidationGenerationInput {
  phaseNumber: number;
}
export function deriveManualValidationGeneration(
  input: ManualValidationGenerationInput,
): string {
  return String(input.phaseNumber);
}

export interface EscalationGenerationInput {
  subtype: string;
  labelOrState: string;
  counter: number;
}
export function deriveEscalationGeneration(input: EscalationGenerationInput): string {
  return `${input.subtype}:${input.labelOrState}:${input.counter}`;
}

export interface PhaseQueueGenerationInput {
  phaseNumber: number;
}
export function derivePhaseQueueGeneration(input: PhaseQueueGenerationInput): string {
  return String(input.phaseNumber);
}

export interface FilingGenerationInput {
  draftHash: string;
}
export function deriveFilingGeneration(input: FilingGenerationInput): string {
  return input.draftHash;
}

export interface ScopeDrainedGenerationInput {
  trackingIssueRef: IssueRef;
  counter: number;
}
export function deriveScopeDrainedGeneration(input: ScopeDrainedGenerationInput): string {
  const { trackingIssueRef, counter } = input;
  return `${trackingIssueRef.owner}/${trackingIssueRef.repo}#${trackingIssueRef.number}:${counter}`;
}
