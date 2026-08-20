// Delta-scoped verification-pass convergence for the engine-native `review`
// phase (#1126). Pure functions over an injected findings artifact (#1124 seam).

export type {
  Severity,
  FindingStatus,
  ReviewVerdict,
  ReviewFinding,
  FindingsArtifact,
} from './findings-artifact.js';
export { normalizeArtifact, sev } from './findings-artifact.js';

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

export type { AdvanceInput, AdvanceResult } from './findings-advance.js';
export { advanceArtifact, filterNewFindings, computeVerdict } from './findings-advance.js';
