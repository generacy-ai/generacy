// Delta-scoped verification-pass convergence for the engine-native `review`
// phase (#1126, activated #1161). Pure functions over the canonical review
// artifact (`worker/review-artifact.ts`).

export type {
  Severity,
  FindingStatus,
  ReviewFinding,
  ReviewArtifact,
} from '../review-artifact.js';
export { SEVERITY_RANK, computeVerdict } from '../review-artifact.js';

export type { ReviewMode } from './review-mode.js';
export { determineReviewMode } from './review-mode.js';

export type {
  DeltaBase,
  ReviewDelta,
  ReviewDeltaGitHub,
  ComputeReviewDeltaInput,
} from './review-delta.js';
export { computeReviewDelta } from './review-delta.js';

export type { VerificationInput } from './verification-input.js';
export { composeVerificationInput } from './verification-input.js';

export type { VerificationPromptParts } from './verification-prompt.js';
export { buildVerificationPrompt } from './verification-prompt.js';

export { advanceArtifact, filterNewFindings } from './findings-advance.js';
