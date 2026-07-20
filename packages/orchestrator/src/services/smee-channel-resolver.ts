/**
 * SmeeChannelResolver
 *
 * Resolves the smee channel URL for the orchestrator through a 4-tier
 * precedence: env-or-yaml (via presetUrl) → persisted file → provision
 * `GET https://smee.io/new` → persist. Never throws; every failure mode
 * folds into `return null` (spec FR-006: fail open, degrade to polling).
 *
 * Feature: #952
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RepositoryConfig } from './webhook-setup-service.js';

/**
 * Logger interface matching Pino/Fastify logger shape.
 */
interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Strict validation pattern for smee.io channel URLs. */
export const SMEE_URL_PATTERN = /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/;

const PROVISION_URL = 'https://smee.io/new';
const HTTP_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 1000;
const MAX_ATTEMPTS = 2;
const CONTENT_PREVIEW_MAX = 64;

export type ChannelSource = 'env-or-yaml' | 'persisted' | 'adopted' | 'provisioned';

export interface SmeeChannelResolverOptions {
  /** Absolute path to the persisted channel file. */
  channelFilePath: string;
  /** If provided, resolver returns it immediately (source: 'env-or-yaml'). */
  presetUrl?: string;
  /** Injected for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Injected for tests. Defaults to a `setTimeout`-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * When set, resolver mirror-writes the resolved URL to this path (mode
   * 0644) alongside the cluster-internal write. Mirror-write failures are
   * logged and non-fatal. Undefined or empty string disables the mirror.
   */
  workspaceMirrorPath?: string;
  /**
   * Repos to inspect for an existing Generacy smee webhook when persisted is
   * absent (tier 3 "adopt-existing"). When absent or empty, the adopt tier is
   * skipped and the resolver falls straight through to tier 4 (provision).
   */
  repos?: RepositoryConfig[];
  /**
   * Discovery callback for the adopt tier. When set (and `repos` is non-empty
   * and persisted returned null), the resolver calls this to find a live
   * smee.io channel URL already registered on a configured repo's GitHub
   * webhooks. Must return `null` (not throw) on "no match" or unrecoverable
   * failure. Throws are caught and retried once (MAX_ATTEMPTS = 2).
   */
  discoverExistingChannel?: (repos: RepositoryConfig[]) => Promise<string | null>;
}

export interface SmeeChannelResolverResult {
  channelUrl: string;
  source: ChannelSource;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class SmeeChannelResolver {
  private readonly logger: Logger;
  private readonly options: SmeeChannelResolverOptions;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(logger: Logger, options: SmeeChannelResolverOptions) {
    this.logger = logger;
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleepImpl = options.sleep ?? defaultSleep;
  }

  async resolve(): Promise<SmeeChannelResolverResult | null> {
    // Tier 1: env/yaml preset — trust Zod validation
    if (this.options.presetUrl) {
      await this.mirrorToWorkspaceIfNeeded(this.options.presetUrl);
      return { channelUrl: this.options.presetUrl, source: 'env-or-yaml' };
    }

    // Tier 2: persisted file
    const persisted = await this.readPersistedFile();
    if (persisted) {
      this.logger.info(
        { channelUrl: persisted, source: 'persisted' },
        'Reusing persisted smee channel URL',
      );
      await this.mirrorToWorkspaceIfNeeded(persisted);
      return { channelUrl: persisted, source: 'persisted' };
    }

    // Tier 3: adopt an existing Generacy smee channel URL from a configured
    // repo's GitHub webhooks. Only fires when a discovery callback and a
    // non-empty repo list are configured (activation predicate). Fail-open:
    // any failure returns null and falls through to provision.
    const adoptedUrl = await this.runAdoptTier();
    if (adoptedUrl !== null) {
      // Persist-on-adopt is best-effort. Diverges from provisioned (which
      // returns null on persist failure) because the channel already exists
      // on GitHub — persist failure just re-runs the adopt tier next boot,
      // no orphan risk.
      const persistedOk = await this.writePersistedFile(adoptedUrl);
      if (!persistedOk) {
        this.logger.warn(
          { path: this.options.channelFilePath, url: adoptedUrl },
          'Adopted smee channel URL but failed to persist — next boot will re-run adopt tier',
        );
      }
      await this.mirrorToWorkspace(adoptedUrl);
      this.logger.info(
        { channelUrl: adoptedUrl, source: 'adopted' },
        'Adopted existing smee channel URL from repo webhook',
      );
      return { channelUrl: adoptedUrl, source: 'adopted' };
    }

    // Tier 4: provision from smee.io
    const provisioned = await this.provision();
    if (!provisioned) {
      return null;
    }

    // Tier 3 persist
    const persistOk = await this.writePersistedFile(provisioned);
    if (!persistOk) {
      return null;
    }

    // Tier 3 mirror is unguarded — always attempt after provision.
    await this.mirrorToWorkspace(provisioned);

    this.logger.info(
      { channelUrl: provisioned, source: 'provisioned' },
      'Provisioned new smee channel URL',
    );
    return { channelUrl: provisioned, source: 'provisioned' };
  }

  /**
   * Tier-3 adopt: call the injected discovery callback (bounded retry) to
   * find an existing Generacy smee channel URL registered on a configured
   * repo's GitHub webhooks. Returns the URL on success, or `null` on miss /
   * exhaustion / malformed response. NEVER THROWS.
   *
   * Activation predicate: both `discoverExistingChannel` and a non-empty
   * `repos` list MUST be configured on options. Otherwise the tier is a
   * silent no-op (no log — it's a legitimate configuration miss, not a
   * failure).
   *
   * Retry semantics: throws are retried once (up to `MAX_ATTEMPTS = 2`).
   * `null` returns and malformed-URL returns are legitimate misses — no
   * retry.
   */
  private async runAdoptTier(): Promise<string | null> {
    if (
      !this.options.discoverExistingChannel ||
      !this.options.repos ||
      this.options.repos.length === 0
    ) {
      return null;
    }

    const { discoverExistingChannel, repos } = this.options;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let result: string | null;
      try {
        result = await discoverExistingChannel(repos);
      } catch (err) {
        lastError = (err as Error).message ?? String(err);
        if (attempt < MAX_ATTEMPTS) {
          await this.sleepImpl(RETRY_DELAY_MS);
        }
        continue;
      }

      if (result === null) {
        return null;
      }

      if (!SMEE_URL_PATTERN.test(result)) {
        this.logger.warn(
          { result, source: 'adopted' },
          'Adopt callback returned URL not matching SMEE_URL_PATTERN — falling through',
        );
        return null;
      }

      return result;
    }

    if (lastError !== undefined) {
      this.logger.warn(
        { attempts: MAX_ATTEMPTS, lastError, source: 'adopted' },
        'Adopt callback failed after N attempts — falling through to provision',
      );
    }
    return null;
  }

  private async readPersistedFile(): Promise<string | null> {
    try {
      const raw = await readFile(this.options.channelFilePath, 'utf-8');
      const trimmed = raw.trim();
      if (SMEE_URL_PATTERN.test(trimmed)) {
        return trimmed;
      }
      const contentPreview = trimmed.slice(0, CONTENT_PREVIEW_MAX);
      this.logger.warn(
        { path: this.options.channelFilePath, contentPreview },
        'Persisted smee channel file has malformed content — re-provisioning',
      );
      return null;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return null;
      }
      this.logger.warn(
        { path: this.options.channelFilePath, error: err.message ?? String(err) },
        'Failed to read persisted smee channel file — falling through to provision',
      );
      return null;
    }
  }

  private async provision(): Promise<string | null> {
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.fetchImpl(PROVISION_URL, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (response.status < 300 || response.status >= 400) {
          lastError = `expected 3xx with Location, got ${response.status}`;
        } else {
          const location = response.headers.get('location');
          if (!location) {
            lastError = 'missing Location header';
          } else if (!SMEE_URL_PATTERN.test(location)) {
            lastError = `Location does not match SMEE_URL_PATTERN`;
          } else {
            return location;
          }
        }
      } catch (error) {
        const err = error as Error;
        lastError = err.name === 'TimeoutError' || err.name === 'AbortError'
          ? `timeout after ${HTTP_TIMEOUT_MS}ms`
          : err.message ?? String(err);
      }
      if (attempt < MAX_ATTEMPTS) {
        await this.sleepImpl(RETRY_DELAY_MS);
      }
    }
    this.logger.warn(
      { attempts: MAX_ATTEMPTS, lastError },
      'Failed to provision smee channel after 2 attempts — cluster is webhook-less, falling back to polling',
    );
    return null;
  }

  private async writePersistedFile(url: string): Promise<boolean> {
    const path = this.options.channelFilePath;
    const tmp = `${path}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, url, { mode: 0o600 });
      await rename(tmp, path);
      return true;
    } catch (error) {
      const err = error as Error;
      this.logger.warn(
        { path, error: err.message ?? String(err) },
        'Provisioned smee channel URL but failed to persist — dropping URL to avoid orphaned GitHub webhook accumulation',
      );
      return false;
    }
  }

  /**
   * Guarded mirror write for tier-1 (preset) and tier-2 (persisted) hits.
   * Skips the write when the mirror already contains the exact same URL
   * (avoids inode churn on every restart). On any other read outcome
   * (ENOENT, other errors), attempts the write.
   */
  private async mirrorToWorkspaceIfNeeded(url: string): Promise<void> {
    const path = this.options.workspaceMirrorPath;
    if (!path) return;
    try {
      const existing = (await readFile(path, 'utf-8')).trim();
      if (existing === url) {
        return;
      }
    } catch {
      // ENOENT or any other read error — fall through and attempt the write.
    }
    await this.mirrorToWorkspace(url);
  }

  /**
   * Best-effort mirror write to the shared *_workspace volume. Failures
   * emit one warn line and are swallowed — the cluster-internal write is
   * the source of truth.
   */
  private async mirrorToWorkspace(url: string): Promise<void> {
    const path = this.options.workspaceMirrorPath;
    if (!path) return;
    const tmp = `${path}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, url, { mode: 0o644 });
      await rename(tmp, path);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      this.logger.warn(
        { path, code: err.code, message: err.message ?? String(err) },
        'Workspace mirror write failed — operator sessions may fall back to polling',
      );
    }
  }
}
