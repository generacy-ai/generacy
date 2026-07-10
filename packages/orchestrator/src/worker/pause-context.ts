/**
 * Pause-context sidecar (#902 Decision 2, FR-003).
 *
 * Small filesystem sidecar at
 * `<workdir>/.generacy/pause-context-<sanitized-workflowId>.json` that carries
 * the interrupted phase in-band from the phase-loop pause site to the
 * MergeConflictHandler at dispatch time.
 *
 * Writer: `runPrePhaseBaseMerge` in `phase-loop.ts`, **before**
 * `labelManager.onGateHit()`. If the write throws, the pause label is never
 * applied, so the pause simply doesn't materialize — no dead-park class.
 *
 * Reader: `ClaudeCliWorker.handle` `case 'resolve-merge-conflicts'`, after
 * checkout completes. Populates `item.metadata.phase`. Absence → handler's
 * fail-loud path (FR-004) fires — never re-derived from labels.
 *
 * Layout mirrors `FilesystemWorkflowStore.getStateFilePath` sanitization
 * (`[^a-zA-Z0-9_-]` → `_`).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const DEFAULT_STATE_DIR = '.generacy';
const PAUSE_CONTEXT_FILE_PREFIX = 'pause-context-';
const PAUSE_CONTEXT_FILE_EXT = '.json';

const WorkflowPhaseSchema = z.enum([
  'specify',
  'clarify',
  'plan',
  'tasks',
  'implement',
  'validate',
]);

export const PauseContextSchema = z.object({
  phase: WorkflowPhaseSchema,
  writtenAt: z.string(),
  issueRef: z.string(),
});

export type PauseContext = z.infer<typeof PauseContextSchema>;

function sanitizeWorkflowId(workflowId: string): string {
  return workflowId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getPauseContextPath(workdir: string, workflowId: string): string {
  const safeId = sanitizeWorkflowId(workflowId);
  return path.join(
    workdir,
    DEFAULT_STATE_DIR,
    `${PAUSE_CONTEXT_FILE_PREFIX}${safeId}${PAUSE_CONTEXT_FILE_EXT}`,
  );
}

/**
 * Write pause-context sidecar atomically (temp file + rename).
 * Overwrites any existing file unconditionally — writes are idempotent.
 */
export async function writePauseContext(
  workdir: string,
  workflowId: string,
  ctx: PauseContext,
): Promise<void> {
  const filePath = getPauseContextPath(workdir, workflowId);
  const dirPath = path.dirname(filePath);

  await fs.mkdir(dirPath, { recursive: true });

  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(ctx, null, 2), 'utf-8');
  await fs.rename(tempPath, filePath);
}

/**
 * Read pause-context sidecar. Returns `null` if missing, unreadable, invalid
 * JSON, or schema-invalid — the caller treats absence as fail-loud path.
 */
export async function readPauseContext(
  workdir: string,
  workflowId: string,
): Promise<PauseContext | null> {
  const filePath = getPauseContextPath(workdir, workflowId);

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

  const parsed = PauseContextSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

/**
 * Delete pause-context sidecar. Idempotent — swallows ENOENT.
 */
export async function clearPauseContext(
  workdir: string,
  workflowId: string,
): Promise<void> {
  const filePath = getPauseContextPath(workdir, workflowId);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}
