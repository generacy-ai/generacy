/**
 * `discoverChannelUrl` — resolves the smee.io channel URL for the doorbell to
 * consume. Reads env override first, then the persisted channel file. Never
 * throws; malformed input logs a warning and returns null.
 *
 * Contract: `specs/978-summary-generacy-cockpit/contracts/channel-discovery.md`.
 */
import type { PathLike } from 'node:fs';

export const DEFAULT_CHANNEL_FILE_PATH = '/var/lib/generacy/smee-channel';

// Copied verbatim from packages/orchestrator/src/services/smee-channel-resolver.ts:27
// to avoid an orchestrator import in the CLI.
export const SMEE_URL_PATTERN = /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/;

export type ChannelSource = 'env' | 'file';

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
}

const ENV_KEY = 'COCKPIT_DOORBELL_SMEE_URL';

function warn(input: ChannelDiscoveryInput, msg: string): void {
  input.logger?.warn?.(msg);
}

function isEnoent(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT';
}

export async function discoverChannelUrl(
  input: ChannelDiscoveryInput,
): Promise<ChannelDiscoveryResult | null> {
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

  let raw: string;
  try {
    raw = await input.fs.readFile(input.channelFilePath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return null;
    warn(
      input,
      `cockpit doorbell: failed to read channel file ${input.channelFilePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
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
