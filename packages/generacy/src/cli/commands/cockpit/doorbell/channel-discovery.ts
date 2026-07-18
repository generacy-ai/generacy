/**
 * `discoverChannelUrl` — resolves the smee.io channel URL for the doorbell to
 * consume. Five-stage lookup: env override → webhook-config (via `gh api
 * /hooks`) → workspace walk-up → absolute workspace-mirror path →
 * cluster-internal fallback. Never throws; malformed input logs a warning and
 * returns null.
 *
 * Contract: `specs/988-summary-cockpit-auto-doorbell/contracts/channel-discovery.md`.
 */
import type { PathLike } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import { z } from 'zod';
import type { CommandRunner } from '@generacy-ai/cockpit';

export const DEFAULT_CHANNEL_FILE_PATH = '/var/lib/generacy/smee-channel';
export const DEFAULT_WORKSPACE_MIRROR_PATH =
  '/workspaces/.generacy/cockpit/smee-channel';
export const DEFAULT_WEBHOOK_CONFIG_TIMEOUT_MS = 5_000;

// Copied verbatim from packages/orchestrator/src/services/smee-channel-resolver.ts:27
// to avoid an orchestrator import in the CLI.
export const SMEE_URL_PATTERN = /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/;

export type ChannelSource =
  | 'env'
  | 'webhook-config'
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
  /**
   * Pre-parsed target repos for the webhook-config stage, primary-first.
   * The caller (`doorbell.ts`) derives this via `resolveWebhookTargets`.
   * When absent or empty, the webhook-config stage is skipped.
   */
  targets?: Array<{ owner: string; repo: string }>;
  /**
   * Command runner used to invoke `gh api …/hooks`. When absent, the
   * webhook-config stage is skipped even if `targets` is non-empty.
   */
  runner?: CommandRunner;
  /**
   * Per-call timeout for the `gh api …/hooks` invocation. Default 5000ms
   * (spec FR-009). Exposed for tests.
   */
  webhookConfigTimeoutMs?: number;
}

export const SmeeHookSchema = z
  .object({
    id: z.number().int(),
    active: z.boolean(),
    config: z.object({ url: z.string() }),
    updated_at: z.string(),
  })
  .passthrough();

export type SmeeHook = z.infer<typeof SmeeHookSchema>;

/**
 * Pure tie-break for `/hooks` payloads (FR-005).
 * 1. Keep only `active === true`.
 * 2. Keep only entries whose `config.url` matches `SMEE_URL_PATTERN`.
 * 3. Sort by `Date.parse(updated_at)` desc; `NaN` sorts last (`-Infinity`).
 * 4. Return the first entry or `null`.
 */
export function pickSmeeHook(hooks: SmeeHook[]): SmeeHook | null {
  const candidates = hooks.filter(
    (h) => h.active === true && SMEE_URL_PATTERN.test(h.config.url),
  );
  const scored = candidates.map((h) => {
    const t = Date.parse(h.updated_at);
    return { h, t: Number.isNaN(t) ? -Infinity : t };
  });
  scored.sort((a, b) => b.t - a.t);
  return scored[0]?.h ?? null;
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

async function runWebhookConfigStage(
  input: ChannelDiscoveryInput,
): Promise<string | null> {
  if (input.runner == null) return null;
  const targets = input.targets;
  if (targets == null || targets.length === 0) return null;
  const timeoutMs =
    input.webhookConfigTimeoutMs != null && input.webhookConfigTimeoutMs > 0
      ? input.webhookConfigTimeoutMs
      : DEFAULT_WEBHOOK_CONFIG_TIMEOUT_MS;
  const runner = input.runner;
  for (const target of targets) {
    const label = `${target.owner}/${target.repo}`;
    let result;
    try {
      result = await runner(
        'gh',
        ['api', `/repos/${target.owner}/${target.repo}/hooks`],
        { timeoutMs },
      );
    } catch (err) {
      warn(
        input,
        `cockpit doorbell: webhook-config stage failed for ${label}: exit=1 (${errMessage(err)})`,
      );
      continue;
    }
    if (result.exitCode !== 0) {
      warn(
        input,
        `cockpit doorbell: webhook-config stage failed for ${label}: exit=${result.exitCode}`,
      );
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      warn(
        input,
        `cockpit doorbell: webhook-config stage: malformed JSON for ${label}`,
      );
      continue;
    }
    const parsed = z.array(SmeeHookSchema).safeParse(raw);
    if (!parsed.success) {
      warn(
        input,
        `cockpit doorbell: webhook-config stage: unexpected /hooks shape for ${label}`,
      );
      continue;
    }
    const hook = pickSmeeHook(parsed.data);
    if (hook == null) continue; // routine — no smee hook here, try next
    return hook.config.url;
  }
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

  // Stage 2: webhook-config (gh api /hooks). Silent no-op when runner or
  // targets are absent — the FS stages below still run.
  const webhookUrl = await runWebhookConfigStage(input);
  if (webhookUrl != null) {
    return { url: webhookUrl, source: 'webhook-config' };
  }

  // Stage 3: walk-up scan starting at cwd.
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

  // Stage 4: absolute workspace mirror path.
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

  // Stage 5: cluster-internal channel file.
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
