/**
 * SmeeChannelResolver
 *
 * Resolves the smee channel URL for the orchestrator through a 4-tier
 * precedence: env-or-yaml (via presetUrl) → persisted file → provision
 * `POST https://smee.io/new` → persist. Never throws; every failure mode
 * folds into `return null` (spec FR-006: fail open, degrade to polling).
 *
 * Feature: #952
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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

export type ChannelSource = 'env-or-yaml' | 'persisted' | 'provisioned';

export interface SmeeChannelResolverOptions {
  /** Absolute path to the persisted channel file. */
  channelFilePath: string;
  /** If provided, resolver returns it immediately (source: 'env-or-yaml'). */
  presetUrl?: string;
  /** Injected for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Injected for tests. Defaults to a `setTimeout`-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
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
      return { channelUrl: this.options.presetUrl, source: 'env-or-yaml' };
    }

    // Tier 2: persisted file
    const persisted = await this.readPersistedFile();
    if (persisted) {
      this.logger.info(
        { channelUrl: persisted, source: 'persisted' },
        'Reusing persisted smee channel URL',
      );
      return { channelUrl: persisted, source: 'persisted' };
    }

    // Tier 3: provision from smee.io
    const provisioned = await this.provision();
    if (!provisioned) {
      return null;
    }

    // Tier 3 persist
    const persistOk = await this.writePersistedFile(provisioned);
    if (!persistOk) {
      return null;
    }

    this.logger.info(
      { channelUrl: provisioned, source: 'provisioned' },
      'Provisioned new smee channel URL',
    );
    return { channelUrl: provisioned, source: 'provisioned' };
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
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (response.status !== 302) {
          lastError = `unexpected status ${response.status}`;
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
}
