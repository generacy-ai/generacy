import { z } from 'zod';

/**
 * Artifact-review kinds — a cluster-local enumeration used only by the
 * `deriveArtifactReviewGeneration` helper (generation.ts) to build the
 * `<kind>:<headSha>` discriminator. It is NOT a wire type: the gate-open
 * record carries `gateType: 'artifact-review'`, and the kind is folded into
 * `gateKey`'s generation slot.
 *
 * The wire enum (`GateTypeSchema`), the gate option/answer/outcome shapes and
 * the gateKey/gateId derivation all live in `./schema.ts` — the single source.
 */
export const ARTIFACT_REVIEW_KINDS = [
  'spec-review',
  'plan-review',
  'tasks-review',
  'clarification-review',
] as const;

export const ArtifactReviewKindSchema = z.enum(ARTIFACT_REVIEW_KINDS);
export type ArtifactReviewKind = z.infer<typeof ArtifactReviewKindSchema>;
