import { createHash } from 'node:crypto';
import type { IssueRef } from './schemas.js';
import type { ArtifactReviewKind } from './types.js';

// Note: untrusted callers should validate `kind` via ArtifactReviewKindSchema.parse before calling.

/**
 * Single question within an unanswered clarification batch. See
 * `ClarificationGenerationInput` for the canonicalization contract.
 */
export interface ClarificationBatchQuestion {
  questionNumber: number;
  questionText: string;
}

export interface ClarificationGenerationInput {
  questions: ClarificationBatchQuestion[];
}

/**
 * Derive the `generation` discriminator for a clarification gate.
 *
 * Canonicalization contract (frozen — sweep + live paths MUST hash identical
 * bytes): sort ascending by questionNumber, re-emit each entry with fixed key
 * order (questionNumber then questionText), JSON.stringify with no
 * pretty-print, sha256, hex, slice first 24 chars.
 */
export function deriveClarificationGeneration(input: ClarificationGenerationInput): string {
  const canonical = [...input.questions]
    .sort((a, b) => a.questionNumber - b.questionNumber)
    .map((q) => ({ questionNumber: q.questionNumber, questionText: q.questionText }));
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex').slice(0, 24);
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
