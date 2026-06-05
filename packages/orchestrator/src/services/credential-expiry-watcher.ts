import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { CredentialDescriptor } from '../types/github-auth.js';
import type { GitHubAuthHealthService } from './github-auth-health.js';

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface CredentialExpiryWatcherOptions {
  agencyDir: string;
  health: GitHubAuthHealthService;
  logger: Logger;
  tickIntervalMs?: number;
  nearExpiryWindowMs?: number;
  now?: () => number;
}

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_NEAR_EXPIRY_WINDOW_MS = 5 * 60_000;

interface ParsedCredentialsYaml {
  credentials?: Record<string, { type?: string; expiresAt?: string } | undefined>;
}

/**
 * Periodic watcher that reads `<agencyDir>/credentials.yaml` on a fixed cadence,
 * forwards the credential map to `GitHubAuthHealthService` on mtime changes, and
 * asks the service to request a refresh for any credential within the near-expiry
 * window.
 *
 * All filesystem and parse errors are caught and logged at `warn`; the timer
 * never throws so a single bad tick can't kill the watcher (D9).
 */
export class CredentialExpiryWatcher {
  private readonly agencyDir: string;
  private readonly health: GitHubAuthHealthService;
  private readonly logger: Logger;
  private readonly tickIntervalMs: number;
  private readonly nearExpiryWindowMs: number;
  private readonly now: () => number;

  private intervalHandle: NodeJS.Timeout | null = null;
  private inflightTick: Promise<void> | null = null;
  private lastMtimeMs: number | null = null;
  private cachedDescriptors: CredentialDescriptor[] = [];
  private fileMissingWarned = false;

  constructor(options: CredentialExpiryWatcherOptions) {
    this.agencyDir = options.agencyDir;
    this.health = options.health;
    this.logger = options.logger;
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.nearExpiryWindowMs = options.nearExpiryWindowMs ?? DEFAULT_NEAR_EXPIRY_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      this.inflightTick = this.tick().catch((err) => {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Credential expiry tick failed',
        );
      });
    }, this.tickIntervalMs);
    if (typeof this.intervalHandle.unref === 'function') {
      this.intervalHandle.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.inflightTick) {
      await this.inflightTick;
      this.inflightTick = null;
    }
  }

  /** Exposed for tests. */
  async tick(): Promise<void> {
    const yamlPath = path.join(this.agencyDir, 'credentials.yaml');

    let mtimeMs: number;
    try {
      const st = await stat(yamlPath);
      mtimeMs = st.mtimeMs;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!this.fileMissingWarned) {
          this.logger.warn(
            { yamlPath },
            'credentials.yaml not present — expiry watcher idle until written',
          );
          this.fileMissingWarned = true;
        }
        return;
      }
      this.logger.warn(
        { yamlPath, err: err instanceof Error ? err.message : String(err) },
        'Failed to stat credentials.yaml',
      );
      return;
    }
    this.fileMissingWarned = false;

    if (mtimeMs !== this.lastMtimeMs) {
      try {
        const raw = await readFile(yamlPath, 'utf8');
        const parsed = YAML.parse(raw) as ParsedCredentialsYaml | null;
        const descriptors = parseDescriptors(parsed);
        this.cachedDescriptors = descriptors;
        this.health.setCredentials(descriptors);
        this.lastMtimeMs = mtimeMs;
      } catch (err: unknown) {
        this.logger.warn(
          { yamlPath, err: err instanceof Error ? err.message : String(err) },
          'Failed to parse credentials.yaml',
        );
        return;
      }
    }

    const now = this.now();
    for (const desc of this.cachedDescriptors) {
      if (desc.type !== 'github-app') continue;
      if (!desc.expiresAt) continue;
      const expiresAtMs = Date.parse(desc.expiresAt);
      if (!Number.isFinite(expiresAtMs)) continue;
      const remainingMs = expiresAtMs - now;
      if (remainingMs <= this.nearExpiryWindowMs) {
        this.health.maybeRequestRefresh(desc.credentialId, 'near-expiry');
      }
    }
  }
}

function parseDescriptors(parsed: ParsedCredentialsYaml | null): CredentialDescriptor[] {
  if (!parsed?.credentials || typeof parsed.credentials !== 'object') {
    return [];
  }
  const descriptors: CredentialDescriptor[] = [];
  for (const [id, entry] of Object.entries(parsed.credentials)) {
    if (!entry || typeof entry !== 'object') continue;
    const type = typeof entry.type === 'string' ? entry.type : 'unknown';
    const expiresAt = typeof entry.expiresAt === 'string' ? entry.expiresAt : undefined;
    descriptors.push({ credentialId: id, type, expiresAt });
  }
  return descriptors;
}

/**
 * Read `<agencyDir>/credentials.yaml` once and return descriptors. Used at
 * orchestrator startup to resolve the github-app `credentialId` for monitor
 * services before the watcher has run its first tick.
 */
export async function readCredentialDescriptors(
  agencyDir: string,
): Promise<CredentialDescriptor[]> {
  const yamlPath = path.join(agencyDir, 'credentials.yaml');
  try {
    const raw = await readFile(yamlPath, 'utf8');
    const parsed = YAML.parse(raw) as ParsedCredentialsYaml | null;
    return parseDescriptors(parsed);
  } catch {
    return [];
  }
}
