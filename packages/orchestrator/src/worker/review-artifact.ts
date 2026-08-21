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
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const DEFAULT_STATE_DIR = '.generacy';
const REVIEW_ARTIFACT_FILE_PREFIX = 'review-findings-';
const REVIEW_CANDIDATE_FILE_PREFIX = 'review-candidate-';
const REVIEW_ARTIFACT_FILE_EXT = '.json';

export type Severity = 'critical' | 'major' | 'minor';
export type FindingStatus = 'open' | 'resolved';

const SeveritySchema = z.enum(['critical', 'major', 'minor']);
const FindingStatusSchema = z.enum(['open', 'resolved']);

export const ReviewFindingSchema = z.object({
  // #1161 (INV-4): stable per-finding identity, deterministic from `(file, title)`
  // via {@link deriveFindingId}. Load-bearing for cross-round match-by-id in the
  // convergence merge (`advanceArtifact`) and for the poster's inline thread
  // marker. Non-empty; parse-time default-filled for pre-#1161 sidecars (INV-5).
  id: z.string().min(1),
  severity: SeveritySchema,
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  title: z.string().min(1),
  detail: z.string().min(1),
  round: z.number().int().positive(),
  status: FindingStatusSchema,
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/**
 * #1161 (INV-4): deterministic per-finding identity. `sha256(file + '\0' + title)`
 * truncated to 24 hex chars (96 bits — matches the gate-id convention). Stable
 * across `line`/`detail`/`round` drift so a round-1 finding re-emitted in round 2
 * matches the same delta entry. The `\0` separator prevents `("ab","c")` /
 * `("a","bc")` collisions.
 */
export function deriveFindingId(file: string, title: string): string {
  return createHash('sha256')
    .update(`${file}\0${title}`)
    .digest('hex')
    .slice(0, 24);
}

const VerdictSchema = z.enum(['clean', 'changes-required']);

export type Verdict = z.infer<typeof VerdictSchema>;

export const ReviewArtifactSchema = z.object({
  findings: z.array(ReviewFindingSchema),
  verdict: VerdictSchema,
  round: z.number().int().positive(),
  lastReviewedCommitSha: z.string().min(1),
  // #1128: caps the review↔remediate loop. Distinct from `round` (monotonic,
  // #1126). `.default(0)` is load-bearing — #1124 artifacts written before this
  // deploy lack the field and must still parse rather than returning `null`.
  remediationCount: z.number().int().nonnegative().default(0),
  // #1156: cross-run engine-marked-ready flag (FR-006/FR-007). Persisted so a
  // later re-entry in a new run can convert a PR the engine marked ready back to
  // draft. `.default(false)` is load-bearing — pre-#1156 artifacts lack the field
  // and must still parse. Only ever written `true` by the engine's own
  // `markReadyForReview`, so reconstruction can never demote a human-ready PR.
  markedReadyByEngine: z.boolean().default(false),
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
 * Relative *candidate* path handed to the agent as its write target (#1155,
 * FR-003). Distinct from the engine-authoritative artifact path so a missing
 * candidate on any round is unambiguously "nothing written this round".
 */
export function getReviewCandidateRelPath(workflowId: string): string {
  const safeId = sanitizeWorkflowId(workflowId);
  return path.join(
    DEFAULT_STATE_DIR,
    `${REVIEW_CANDIDATE_FILE_PREFIX}${safeId}${REVIEW_ARTIFACT_FILE_EXT}`,
  );
}

/** Absolute candidate path: `<checkoutPath>/.generacy/review-candidate-<id>.json`. */
export function getReviewCandidatePath(checkoutPath: string, workflowId: string): string {
  return path.join(checkoutPath, getReviewCandidateRelPath(workflowId));
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
 * #1128: read → +1 → atomic write of `remediationCount`. Returns the new count.
 * No-op returning `0` if the artifact is missing/invalid (nothing to bump).
 * Called once per `remediate` execution on every return path so a perpetually
 * timing-out attempt still consumes budget (Q4=A / SC-001).
 */
export async function bumpRemediationCount(
  checkoutPath: string,
  workflowId: string,
): Promise<number> {
  const artifact = await readReviewArtifact(checkoutPath, workflowId);
  if (!artifact) {
    return 0;
  }
  const next = artifact.remediationCount + 1;
  await writeReviewArtifact(checkoutPath, workflowId, {
    ...artifact,
    remediationCount: next,
  });
  return next;
}

/**
 * #1128: reset `remediationCount` to 0 (operator resume — fresh budget). No-op
 * if the artifact is missing/invalid. Leaves `round` + `lastReviewedCommitSha`
 * untouched (INV-3).
 */
export async function resetRemediationCount(
  checkoutPath: string,
  workflowId: string,
): Promise<void> {
  const artifact = await readReviewArtifact(checkoutPath, workflowId);
  if (!artifact) {
    return;
  }
  await writeReviewArtifact(checkoutPath, workflowId, {
    ...artifact,
    remediationCount: 0,
  });
}

/**
 * #1156: read → set → atomic write of `markedReadyByEngine` (FR-006). Null-safe
 * no-op when the artifact is missing/invalid (D-6). Leaves every other field
 * untouched. Called best-effort by `PrManager` on mark-ready / convert-to-draft
 * so cross-run lifecycle state survives a fresh process.
 */
export async function setMarkedReadyByEngine(
  checkoutPath: string,
  workflowId: string,
  value: boolean,
): Promise<void> {
  const artifact = await readReviewArtifact(checkoutPath, workflowId);
  if (!artifact) {
    return;
  }
  await writeReviewArtifact(checkoutPath, workflowId, {
    ...artifact,
    markedReadyByEngine: value,
  });
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

  // #1161 (INV-5): repair pre-#1161 finding fields BEFORE Zod, so an older
  // on-disk sidecar never fails the tightened schema (fills a missing `id`;
  // normalizes `round: 0` → `1`). Idempotent — a re-parse changes nothing.
  backfillFindingFields(raw);

  const parsed = ReviewArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

/**
 * #1161 (INV-5): mutate `raw.findings[]` in place, repairing fields a pre-#1161
 * sidecar may lack or carry in an old shape, BEFORE Zod validation:
 *  - fill a deterministic `id` on any finding lacking a non-empty one (uses the
 *    same `(file, title)` derivation, so a re-parse is idempotent);
 *  - normalize `round: 0` → `1`. The pre-#1161 `SeedAwareReviewExecutor`
 *    persisted external-feedback findings with `round: 0`; `round` is now
 *    `z.number().int().positive()`, so an un-normalized 0 would reject the whole
 *    artifact — silently discarding all prior review state (round reset,
 *    `lastReviewedCommitSha` and open findings lost, budget reset) on a mid-issue
 *    upgrade.
 * Tolerates arbitrary shapes (only acts on recognizable fields); malformed
 * entries are left for Zod to reject.
 */
function backfillFindingFields(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) {
    return;
  }
  const findings = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) {
    return;
  }
  for (const finding of findings) {
    if (typeof finding !== 'object' || finding === null) {
      continue;
    }
    const f = finding as { id?: unknown; file?: unknown; title?: unknown; round?: unknown };
    if (!(typeof f.id === 'string' && f.id.length > 0)) {
      if (typeof f.file === 'string' && typeof f.title === 'string') {
        f.id = deriveFindingId(f.file, f.title);
      }
    }
    if (f.round === 0) {
      f.round = 1;
    }
  }
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

/** Delete the review *candidate* sidecar (#1155). Idempotent — swallows ENOENT. */
export async function clearReviewCandidate(
  checkoutPath: string,
  workflowId: string,
): Promise<void> {
  const filePath = getReviewCandidatePath(checkoutPath, workflowId);
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
 * Read the agent-written *candidate* sidecar (#1155, FR-002) and return validated
 * findings, stamping the authoritative `round` and defaulting `status` to
 * `'open'`. Tolerates a missing per-finding `round`/`status` and ignores any
 * agent-claimed top-level `verdict`.
 *
 * Returns `null` on missing / unreadable / invalid-JSON / schema-invalid — there
 * is NO proof of review, which the engine treats as a no-verdict round (never
 * `clean`). Returns `ReviewFinding[]` (possibly `[]`) only for a valid candidate:
 * `[]` is a genuine "reviewed, zero findings" result. NEVER throws. Reads the
 * separate candidate path so a stale prior-round engine artifact can never be
 * re-ingested as this round's findings.
 */
export async function readCandidateFindings(
  checkoutPath: string,
  workflowId: string,
  round: number,
): Promise<ReviewFinding[] | null> {
  const filePath = getReviewCandidatePath(checkoutPath, workflowId);

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

  const parsed = CandidateArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }

  return parsed.data.findings.map((f) => ({
    // #1161 (INV-4): the candidate never carries an `id`; derive it here so
    // downstream match-by-id and thread markers are stable from first parse.
    id: deriveFindingId(f.file, f.title),
    severity: f.severity,
    file: f.file,
    ...(f.line !== undefined ? { line: f.line } : {}),
    title: f.title,
    detail: f.detail,
    round: f.round ?? round,
    status: f.status ?? 'open',
  }));
}

export const SEVERITY_RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1 };

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
