/**
 * `discoverChannelUrl` — resolves the smee.io channel URL for the doorbell to
 * consume. Four-stage lookup: env override → workspace walk-up →
 * absolute workspace-mirror path → cluster-internal fallback. Never throws;
 * malformed input logs a warning and returns null.
 *
 * Contract: `specs/980-summary-978-shipped-working/contracts/channel-discovery.md`.
 */
import type { PathLike } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';

export const DEFAULT_CHANNEL_FILE_PATH = '/var/lib/generacy/smee-channel';
export const DEFAULT_WORKSPACE_MIRROR_PATH =
  '/workspaces/.generacy/cockpit/smee-channel';

// Copied verbatim from packages/orchestrator/src/services/smee-channel-resolver.ts:27
// to avoid an orchestrator import in the CLI.
export const SMEE_URL_PATTERN = /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/;

export type ChannelSource =
  | 'env'
  | 'workspace-walkup'
  | 'workspace-absolute'
  | 'file';

export interface ChannelDiscoveryResult {
  url: string;
  source: ChannelSource;
}

interface ReadFileFn {
  (path: PathLike, encoding: BufferEncoding): Promise<string>;
}

export interface ChannelDiscoveryInput {
  env: NodeJS.ProcessEnv;
  channelFilePath: string;
  fs: { readFile: ReadFileFn };
  logger?: { warn?: (msg: string) => void };
  /** Starting directory for walk-up scan. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Absolute fallback if walk-up produces no hit. */
  workspaceMirrorPath?: string;
}

const ENV_KEY = 'COCKPIT_DOORBELL_SMEE_URL';
const WALKUP_SUFFIX = join('.generacy', 'cockpit', 'smee-channel');

function warn(input: ChannelDiscoveryInput, msg: string): void {
  input.logger?.warn?.(msg);
}

function isEnoent(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function tryReadUrl(
  input: ChannelDiscoveryInput,
  path: string,
  onNonEnoentError: (msg: string) => void,
  onMalformed: (msg: string) => void,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await input.fs.readFile(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return null;
    onNonEnoentError(errMessage(err));
    return null;
  }
  const trimmed = raw.trim();
  if (SMEE_URL_PATTERN.test(trimmed)) {
    return trimmed;
  }
  onMalformed(trimmed);
  return null;
}

export async function discoverChannelUrl(
  input: ChannelDiscoveryInput,
): Promise<ChannelDiscoveryResult | null> {
  // Stage 1: env override.
  const envRaw = input.env[ENV_KEY];
  const envPresent = envRaw != null && envRaw !== '';
  if (envPresent) {
    if (SMEE_URL_PATTERN.test(envRaw)) {
      return { url: envRaw, source: 'env' };
    }
    warn(
      input,
      `cockpit doorbell: ${ENV_KEY} does not match smee URL pattern; falling through to channel file`,
    );
  }

  // Stage 2: walk-up scan starting at cwd.
  const startCwd = input.cwd ?? process.cwd();
  const root = parsePath(startCwd).root;
  let dir = startCwd;
  // Bound the walk: worst case ~few dozen hops, so no infinite-loop guard beyond
  // the root check is required — path.dirname eventually stabilizes at root.
  for (;;) {
    const candidate = join(dir, WALKUP_SUFFIX);
    const url = await tryReadUrl(
      input,
      candidate,
      (msg) =>
        warn(input, `cockpit doorbell: walk-up read failed at ${dir}: ${msg}`),
      () =>
        warn(
          input,
          `cockpit doorbell: channel content at ${candidate} does not match smee URL pattern`,
        ),
    );
    if (url != null) {
      return { url, source: 'workspace-walkup' };
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Stage 3: absolute workspace mirror path.
  const mirrorPath = input.workspaceMirrorPath ?? DEFAULT_WORKSPACE_MIRROR_PATH;
  const mirrorUrl = await tryReadUrl(
    input,
    mirrorPath,
    (msg) =>
      warn(
        input,
        `cockpit doorbell: failed to read workspace mirror at ${mirrorPath}: ${msg}`,
      ),
    () =>
      warn(
        input,
        `cockpit doorbell: channel content at ${mirrorPath} does not match smee URL pattern`,
      ),
  );
  if (mirrorUrl != null) {
    return { url: mirrorUrl, source: 'workspace-absolute' };
  }

  // Stage 4: cluster-internal channel file.
  let raw: string;
  try {
    raw = await input.fs.readFile(input.channelFilePath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return null;
    warn(
      input,
      `cockpit doorbell: failed to read channel file ${input.channelFilePath}: ${errMessage(err)}`,
    );
    return null;
  }
  const trimmed = raw.trim();
  if (SMEE_URL_PATTERN.test(trimmed)) {
    return { url: trimmed, source: 'file' };
  }
  warn(
    input,
    `cockpit doorbell: channel file ${input.channelFilePath} content does not match smee URL pattern`,
  );
  return null;
}
