import path from 'node:path';
import { mkdir, rm, chown } from 'node:fs/promises';

export const DEFAULT_SCRATCH_BASE = '/var/lib/generacy/scratch';
const DEFAULT_UID = 1001;
const DIR_MODE = 0o700;

/**
 * Create a per-session scratch directory at <scratchBase>/<sessionId>/.
 * Mode 0700, owned by workflow uid (default 1001).
 */
export async function createScratchDir(
  sessionId: string,
  uid: number = DEFAULT_UID,
  gid?: number,
  scratchBase: string = DEFAULT_SCRATCH_BASE,
): Promise<string> {
  const scratchDir = path.join(scratchBase, sessionId);
  await mkdir(scratchDir, { recursive: true, mode: DIR_MODE });
  try {
    await chown(scratchDir, uid, gid ?? uid);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    // Silently ignore EPERM — daemon may not be running as root
  }
  return scratchDir;
}

/**
 * Remove a per-session scratch directory. Best-effort: ignores missing dirs.
 */
export async function removeScratchDir(scratchDir: string): Promise<void> {
  try {
    await rm(scratchDir, { recursive: true, force: true });
  } catch {
    // Best effort — log but don't fail session teardown
    console.warn(`[credhelper] Failed to remove scratch dir: ${scratchDir}`);
  }
}
