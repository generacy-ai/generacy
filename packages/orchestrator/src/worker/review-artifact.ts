/**
 * Review-findings artifact sidecar (#1124 Decision 2/6, FR-005/FR-006/FR-007).
 *
 * The single persisted entity of the review phase: a filesystem sidecar at
 * `<checkoutPath>/.generacy/review-findings-<sanitized-workflowId>.json`.
 *
 * Handoff shape (Decision 2, Q1→A): the review agent writes a *candidate* file
 * with its findings; the engine reads that file, Zod-validates the findings,
 * RECOMPUTES the verdict (any agent-claimed verdict is ignored, FR-007), stamps
 * `round` + `lastReviewedCommitSha`, and rewrites the artifact atomically
 * (temp + rename). The strict schema below governs the *engine-written* file
 * that `readReviewArtifact` / `readReviewArtifactSync` return.
 *
 * Layout + sanitization mirror `pause-context.ts` (`[^a-zA-Z0-9_-]` → `_`,
 * atomic temp+rename, null-on-invalid reads). The sync reader exists because
 * `PhaseLoopDeps.remediateTrigger` is synchronous (`(context) => boolean`).
 */
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const DEFAULT_STATE_DIR = '.generacy';
const REVIEW_ARTIFACT_FILE_PREFIX = 'review-findings-';
const REVIEW_ARTIFACT_FILE_EXT = '.json';

export type Severity = 'critical' | 'major' | 'minor';
export type FindingStatus = 'open' | 'resolved';

const SeveritySchema = z.enum(['critical', 'major', 'minor']);
const FindingStatusSchema = z.enum(['open', 'resolved']);

export const ReviewFindingSchema = z.object({
  severity: SeveritySchema,
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  title: z.string().min(1),
  detail: z.string().min(1),
  round: z.number().int().nonnegative(),
  status: FindingStatusSchema,
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

const VerdictSchema = z.enum(['clean', 'changes-required']);

export const ReviewArtifactSchema = z.object({
  findings: z.array(ReviewFindingSchema),
  verdict: VerdictSchema,
  round: z.number().int().positive(),
  lastReviewedCommitSha: z.string().min(1),
});

export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;

function sanitizeWorkflowId(workflowId: string): string {
  return workflowId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Relative sidecar path handed to the agent in the charter (its write target). */
export function getReviewArtifactRelPath(workflowId: string): string {
  const safeId = sanitizeWorkflowId(workflowId);
  return path.join(
    DEFAULT_STATE_DIR,
    `${REVIEW_ARTIFACT_FILE_PREFIX}${safeId}${REVIEW_ARTIFACT_FILE_EXT}`,
  );
}

/** Absolute sidecar path: `<checkoutPath>/.generacy/review-findings-<id>.json`. */
export function getReviewArtifactPath(checkoutPath: string, workflowId: string): string {
  return path.join(checkoutPath, getReviewArtifactRelPath(workflowId));
}

/**
 * Write the review artifact atomically (temp file + rename). `mkdir -p`s the
 * `.generacy` dir. Overwrites any existing file unconditionally.
 */
export async function writeReviewArtifact(
  checkoutPath: string,
  workflowId: string,
  artifact: ReviewArtifact,
): Promise<void> {
  const filePath = getReviewArtifactPath(checkoutPath, workflowId);
  const dirPath = path.dirname(filePath);

  await fs.mkdir(dirPath, { recursive: true });

  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(artifact, null, 2), 'utf-8');
  await fs.rename(tempPath, filePath);
}

/**
 * Read the review artifact. Returns `null` on missing / unreadable / invalid
 * JSON / schema-invalid content — NEVER throws.
 */
export async function readReviewArtifact(
  checkoutPath: string,
  workflowId: string,
): Promise<ReviewArtifact | null> {
  const filePath = getReviewArtifactPath(checkoutPath, workflowId);

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  return parseArtifact(content);
}

/**
 * Synchronous read for the sync `remediateTrigger` seam. Same null contract as
 * {@link readReviewArtifact} — NEVER throws.
 */
export function readReviewArtifactSync(
  checkoutPath: string,
  workflowId: string,
): ReviewArtifact | null {
  const filePath = getReviewArtifactPath(checkoutPath, workflowId);

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  return parseArtifact(content);
}

function parseArtifact(content: string): ReviewArtifact | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }

  const parsed = ReviewArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

/** Delete the review artifact. Idempotent — swallows ENOENT. */
export async function clearReviewArtifact(
  checkoutPath: string,
  workflowId: string,
): Promise<void> {
  const filePath = getReviewArtifactPath(checkoutPath, workflowId);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Lenient per-finding schema for the *candidate* file the agent writes. Unlike
 * the strict {@link ReviewFindingSchema} governing the engine-written artifact,
 * `round` and `status` are optional here — the executor stamps the authoritative
 * `round` and defaults `status` to `'open'` (a fresh finding). Any agent-claimed
 * top-level `verdict`/`round` is ignored (FR-007); only `findings` is read.
 */
const CandidateFindingSchema = z.object({
  severity: SeveritySchema,
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  title: z.string().min(1),
  detail: z.string().min(1),
  round: z.number().int().nonnegative().optional(),
  status: FindingStatusSchema.optional(),
});

const CandidateArtifactSchema = z.object({
  findings: z.array(CandidateFindingSchema),
});

/**
 * Read the agent-written *candidate* sidecar and return validated findings,
 * stamping the authoritative `round` and defaulting `status` to `'open'`.
 * Tolerates a missing per-finding `round`/`status` and ignores any agent-claimed
 * top-level `verdict`. Returns `[]` on missing / unreadable / invalid — NEVER
 * throws.
 */
export async function readCandidateFindings(
  checkoutPath: string,
  workflowId: string,
  round: number,
): Promise<ReviewFinding[]> {
  const filePath = getReviewArtifactPath(checkoutPath, workflowId);

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return [];
  }

  const parsed = CandidateArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }

  return parsed.data.findings.map((f) => ({
    severity: f.severity,
    file: f.file,
    ...(f.line !== undefined ? { line: f.line } : {}),
    title: f.title,
    detail: f.detail,
    round: f.round ?? round,
    status: f.status ?? 'open',
  }));
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1 };

/**
 * Compute the engine-internal verdict (FR-007). Returns `changes-required` iff
 * at least one finding is `status: 'open'` AND ranks at or above
 * `blockingSeverity` (`critical > major > minor`); otherwise `clean`. Pure and
 * total over the closed severity enum.
 */
export function computeVerdict(
  findings: ReviewFinding[],
  blockingSeverity: Severity,
): 'clean' | 'changes-required' {
  const threshold = SEVERITY_RANK[blockingSeverity];
  const blocking = findings.some(
    (f) => f.status === 'open' && SEVERITY_RANK[f.severity] >= threshold,
  );
  return blocking ? 'changes-required' : 'clean';
}
