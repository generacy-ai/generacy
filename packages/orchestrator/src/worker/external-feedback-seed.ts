/**
 * External-feedback seed sidecar (#1130, D-1/D-3).
 *
 * The checkout-local handoff between the thin `address-pr-feedback` adapter and
 * the {@link SeedAwareReviewExecutor}. The adapter extracts trusted findings
 * from inline review threads AND review bodies (dual-source), writes them here,
 * then runs the normal phase loop entering at `review`. The seed-aware review
 * wrapper reads the seed on the first round, synthesizes the findings artifact
 * with `verdict = changes-required`, and deletes the seed (consume-once).
 *
 * Layout + sanitization mirror `review-artifact.ts` (`[^a-zA-Z0-9_-]` → `_`,
 * atomic temp+rename, null-on-invalid reads). All state is per-job and
 * ephemeral — no Redis, no PR/issue markers.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const DEFAULT_STATE_DIR = '.generacy';
const SEED_FILE_PREFIX = 'external-feedback-';
const SEED_FILE_EXT = '.json';

export interface ExternalFeedbackFinding {
  /** Stable id from the source thread/comment (legacy parser `id`). */
  id: string;
  /**
   * The finding text. For review-body-only findings this preserves the legacy
   * "review body (no file anchor):\n\n<body>" prefix so no body-only ask is
   * dropped (FR-004).
   */
  body: string;
  /** Trusted author login (authorship-based, FR-002). */
  author: string;
  /** File path when the source was an inline thread; undefined for review-body. */
  path?: string;
  /** Line when the source was an inline thread; undefined for review-body. */
  line?: number;
}

export interface ExternalFeedbackSeed {
  /** Schema version for forward-compat; literal 1 for this feature. */
  version: 1;
  /** PR the feedback came from — carried for logging/trace only. */
  prNumber: number;
  /** ISO timestamp the adapter wrote the seed. */
  seededAt: string;
  /** Dual-source findings extracted from inline threads AND review bodies. */
  findings: ExternalFeedbackFinding[];
}

const ExternalFeedbackFindingSchema = z.object({
  id: z.string().min(1),
  body: z.string().min(1),
  author: z.string().min(1),
  path: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
});

const ExternalFeedbackSeedSchema = z.object({
  version: z.literal(1),
  prNumber: z.number().int().positive(),
  seededAt: z.string().min(1),
  findings: z.array(ExternalFeedbackFindingSchema).min(1),
});

function sanitizeWorkflowId(workflowId: string): string {
  return workflowId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Path: `<checkoutPath>/.generacy/external-feedback-<sanitize(workflowId)>.json`. */
export function getExternalFeedbackSeedPath(checkoutPath: string, workflowId: string): string {
  const safeId = sanitizeWorkflowId(workflowId);
  return path.join(checkoutPath, DEFAULT_STATE_DIR, `${SEED_FILE_PREFIX}${safeId}${SEED_FILE_EXT}`);
}

/**
 * Write the seed atomically (temp file + rename). `mkdir -p`s the `.generacy`
 * dir. The Zod invariant (`findings.min(1)`) is enforced before writing — an
 * empty seed is never written.
 */
export async function writeExternalFeedbackSeed(
  checkoutPath: string,
  workflowId: string,
  seed: ExternalFeedbackSeed,
): Promise<void> {
  ExternalFeedbackSeedSchema.parse(seed);

  const filePath = getExternalFeedbackSeedPath(checkoutPath, workflowId);
  const dirPath = path.dirname(filePath);

  await fs.mkdir(dirPath, { recursive: true });

  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(seed, null, 2), 'utf-8');
  await fs.rename(tempPath, filePath);
}

/**
 * Read the seed. Returns `null` on missing / unreadable / invalid JSON /
 * schema-invalid / unknown-version content — NEVER throws (fail-open, same
 * conservatism as `readReviewArtifact`).
 */
export async function readExternalFeedbackSeed(
  checkoutPath: string,
  workflowId: string,
): Promise<ExternalFeedbackSeed | null> {
  const filePath = getExternalFeedbackSeedPath(checkoutPath, workflowId);

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }

  const parsed = ExternalFeedbackSeedSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Delete the seed. Idempotent — swallows ENOENT. */
export async function clearExternalFeedbackSeed(
  checkoutPath: string,
  workflowId: string,
): Promise<void> {
  const filePath = getExternalFeedbackSeedPath(checkoutPath, workflowId);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}
