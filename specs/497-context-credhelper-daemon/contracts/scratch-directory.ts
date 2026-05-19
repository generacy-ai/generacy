/**
 * Contract: scratch-directory.ts
 *
 * Per-session scratch directory lifecycle.
 * Created at session begin, cleaned at session end.
 */

// --- Constants ---

/** Base path for all scratch directories */
export const SCRATCH_BASE_DIR = '/var/lib/generacy/scratch';

/** Directory permissions (owner-only rwx) */
export const SCRATCH_DIR_MODE = 0o700;

/** Workflow user uid */
export const SCRATCH_OWNER_UID = 1001;

// --- Functions ---

/**
 * Create the per-session scratch directory.
 *
 * @param sessionId - Unique session identifier
 * @param uid - Owner uid (default: 1001, workflow user)
 * @param gid - Owner gid (default: same as uid)
 * @returns Absolute path to the created scratch directory
 *
 * Behavior:
 * - Creates /var/lib/generacy/scratch/<sessionId>/ with mode 0700
 * - Creates parent /var/lib/generacy/scratch/ if it doesn't exist (mode 0755)
 * - chown to uid:gid
 * - Throws if directory already exists (session ID collision)
 */
export declare function createScratchDir(
  sessionId: string,
  uid?: number,
  gid?: number,
): Promise<string>;

/**
 * Remove the per-session scratch directory and all contents.
 *
 * @param scratchDir - Absolute path to the scratch directory
 *
 * Behavior:
 * - Recursive delete (rm -rf equivalent)
 * - No-op if directory doesn't exist
 * - Best-effort: logs warning on failure but doesn't throw
 */
export declare function removeScratchDir(scratchDir: string): Promise<void>;
