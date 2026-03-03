/**
 * Options resolver for `generacy init`.
 *
 * Merges CLI flags, existing config, interactive prompts, auto-detection,
 * and hard-coded defaults into a fully resolved `InitOptions` object.
 *
 * Priority chain (highest → lowest):
 *   CLI flags > existing config > interactive prompts > auto-detection > defaults
 */
import * as crypto from 'node:crypto';
import { basename } from 'node:path';
import * as p from '@clack/prompts';
import { loadConfig } from '../../../config/index.js';
import { getLogger } from '../../utils/logger.js';
import { runInteractivePrompts } from './prompts.js';
import { detectPrimaryRepo, normalizeRepoUrl } from './repo-utils.js';
import type { InitOptions } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a `github.com/owner/repo` config-format string to `owner/repo`
 * shorthand. Returns the input unchanged if parsing fails.
 */
function configRepoToShorthand(configUrl: string): string {
  try {
    return normalizeRepoUrl(configUrl).shorthand;
  } catch {
    return configUrl;
  }
}

/**
 * Load defaults from an existing `.generacy/config.yaml` if one is present.
 * Returns an empty partial on any failure (missing file, invalid schema, etc.).
 */
function loadExistingDefaults(gitRoot: string): Partial<InitOptions> {
  const logger = getLogger();
  try {
    const config = loadConfig({ startDir: gitRoot });
    const defaults: Partial<InitOptions> = {
      projectId: config.project.id,
      projectName: config.project.name,
      primaryRepo: configRepoToShorthand(config.repos.primary),
      agent: config.defaults?.agent,
      baseBranch: config.defaults?.baseBranch,
    };

    if (config.repos.dev && config.repos.dev.length > 0) {
      defaults.devRepos = config.repos.dev.map(configRepoToShorthand);
    }
    if (config.repos.clone && config.repos.clone.length > 0) {
      defaults.cloneRepos = config.repos.clone.map(configRepoToShorthand);
    }
    if (config.cluster?.variant) {
      defaults.variant = config.cluster.variant;
    }

    logger.debug({ defaults }, 'Loaded existing config defaults for re-init');
    return defaults;
  } catch {
    logger.debug('No existing config found or config is invalid — starting fresh');
    return {};
  }
}

/**
 * Extract typed flag values from the raw Commander options object.
 * Only keys that are explicitly set are included in the result.
 */
function extractFlags(flags: Record<string, unknown>): Partial<InitOptions> {
  const partial: Partial<InitOptions> = {};

  if (typeof flags.projectId === 'string') partial.projectId = flags.projectId;
  if (typeof flags.projectName === 'string') partial.projectName = flags.projectName;
  if (typeof flags.primaryRepo === 'string') partial.primaryRepo = flags.primaryRepo;
  if (typeof flags.agent === 'string') partial.agent = flags.agent;
  if (typeof flags.baseBranch === 'string') partial.baseBranch = flags.baseBranch;
  if (typeof flags.releaseStream === 'string') {
    partial.releaseStream = flags.releaseStream as 'stable' | 'preview';
  }
  if (typeof flags.variant === 'string') {
    partial.variant = flags.variant as 'standard' | 'microservices';
  }

  // Variadic flags come as string arrays from Commander
  if (Array.isArray(flags.devRepo)) {
    partial.devRepos = flags.devRepo.filter((v): v is string => typeof v === 'string');
  }
  if (Array.isArray(flags.cloneRepo)) {
    partial.cloneRepos = flags.cloneRepo.filter((v): v is string => typeof v === 'string');
  }

  // Boolean flags
  if (typeof flags.force === 'boolean') partial.force = flags.force;
  if (typeof flags.dryRun === 'boolean') partial.dryRun = flags.dryRun;
  if (typeof flags.skipGithubCheck === 'boolean') partial.skipGithubCheck = flags.skipGithubCheck;
  if (typeof flags.yes === 'boolean') partial.yes = flags.yes;

  return partial;
}

/**
 * Check whether all required interactive fields have been resolved.
 */
function isFullySpecified(partial: Partial<InitOptions>): boolean {
  return (
    partial.projectName !== undefined &&
    partial.primaryRepo !== undefined
  );
}

/**
 * Validate a `--project-id` value: must match `proj_` prefix followed by
 * lowercase alphanumeric characters and be at least 12 characters long.
 */
function validateProjectId(id: string): void {
  if (!/^proj_[a-z0-9]+$/.test(id)) {
    throw new ResolverError(
      `Invalid project ID "${id}". Must match format: proj_{alphanumeric} (e.g. proj_abc123).`,
    );
  }
  if (id.length < 12) {
    throw new ResolverError(
      `Invalid project ID "${id}". Must be at least 12 characters long.`,
    );
  }
}

/**
 * Generate a local placeholder project ID.
 * Format: `proj_local<8 random hex chars>` (e.g. proj_locala1b2c3d4)
 * Matches config schema regex: /^proj_[a-z0-9]+$/
 */
function generateLocalProjectId(): string {
  const hex = crypto.randomBytes(4).toString('hex');
  return `proj_local${hex}`;
}

/**
 * Normalize a single repo URL to `owner/repo` shorthand.
 * Throws a `ResolverError` with a user-friendly message on failure.
 */
function normalizeRepo(input: string): string {
  try {
    return normalizeRepoUrl(input).shorthand;
  } catch (err) {
    throw new ResolverError(
      err instanceof Error ? err.message : `Invalid repository URL: ${input}`,
    );
  }
}

/**
 * Validate that no repository appears in more than one role.
 * Compares normalized `owner/repo` strings.
 */
function validateNoDuplicateRepos(
  primaryRepo: string,
  devRepos: string[],
  cloneRepos: string[],
): void {
  const seen = new Map<string, string>(); // repo → role
  seen.set(primaryRepo, 'primary');

  for (const repo of devRepos) {
    const existing = seen.get(repo);
    if (existing) {
      throw new ResolverError(
        `Duplicate repository "${repo}" — it appears in both "${existing}" and "dev" lists. ` +
          'Each repository can only appear once across primary, dev, and clone lists.',
      );
    }
    seen.set(repo, 'dev');
  }

  for (const repo of cloneRepos) {
    const existing = seen.get(repo);
    if (existing) {
      throw new ResolverError(
        `Duplicate repository "${repo}" — it appears in both "${existing}" and "clone" lists. ` +
          'Each repository can only appear once across primary, dev, and clone lists.',
      );
    }
    seen.set(repo, 'clone');
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Error thrown when the resolver cannot produce valid `InitOptions`.
 * Callers should catch this to display the message and exit with code 1.
 */
export class ResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolverError';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a fully populated `InitOptions` from CLI flags, existing config,
 * interactive prompts, auto-detection, and defaults.
 *
 * @param flags - Raw option values from Commander.js (`command.opts()`).
 * @param gitRoot - Absolute path to the git repository root (already validated).
 * @returns Fully resolved `InitOptions` — every field is concrete.
 * @throws {ResolverError} If resolution fails (missing required values,
 *   invalid project ID, non-TTY without `--yes`, duplicate repos, etc.).
 */
export async function resolveOptions(
  flags: Record<string, unknown>,
  gitRoot: string,
): Promise<InitOptions> {
  const logger = getLogger();

  // ── 1. Extract typed CLI flags ────────────────────────────────────────
  const cliFlags = extractFlags(flags);
  logger.debug({ cliFlags }, 'Parsed CLI flags');

  // ── 2. Load existing config as fallback defaults ──────────────────────
  const existingConfig = loadExistingDefaults(gitRoot);
  logger.debug({ existingConfig }, 'Existing config defaults');

  // Merge: CLI flags take priority over existing config
  const merged: Partial<InitOptions> = { ...existingConfig, ...cliFlags };

  // ── 3. Determine resolution strategy ──────────────────────────────────
  const useYes = merged.yes === true;

  if (useYes) {
    // Auto-derive missing values from context
    if (merged.projectName === undefined) {
      merged.projectName = basename(gitRoot);
      p.log.warn(`Auto-derived project name: "${merged.projectName}"`);
    }

    if (merged.primaryRepo === undefined) {
      const detected = detectPrimaryRepo(gitRoot);
      if (!detected) {
        throw new ResolverError(
          'Cannot auto-detect primary repository — no git remote "origin" found. ' +
            'Provide --primary-repo explicitly.',
        );
      }
      merged.primaryRepo = detected;
      p.log.warn(`Auto-derived primary repo: ${merged.primaryRepo}`);
    }

    // Default arrays
    if (merged.devRepos === undefined) merged.devRepos = [];
    if (merged.cloneRepos === undefined) merged.cloneRepos = [];
  } else if (!isFullySpecified(merged)) {
    // Interactive mode needed — check TTY
    if (!process.stdin.isTTY) {
      throw new ResolverError(
        'Interactive prompts are not available in this environment (non-TTY). ' +
          'Use --yes to accept defaults, or provide all required flags ' +
          '(--project-name, --primary-repo).',
      );
    }

    // Run interactive prompts, passing already-resolved values as defaults
    const prompted = await runInteractivePrompts(merged, gitRoot);
    Object.assign(merged, prompted);
  }

  // ── 4. Project ID ─────────────────────────────────────────────────────
  let projectId: string;
  if (merged.projectId !== undefined) {
    validateProjectId(merged.projectId);
    projectId = merged.projectId;
  } else {
    projectId = generateLocalProjectId();
    logger.debug({ projectId }, 'Generated local placeholder project ID');
  }

  // ── 5. Normalize repo URLs ────────────────────────────────────────────
  const primaryRepo = normalizeRepo(merged.primaryRepo!);
  const devRepos = (merged.devRepos ?? []).map(normalizeRepo);
  const cloneRepos = (merged.cloneRepos ?? []).map(normalizeRepo);

  // ── 6. Validate no duplicate repo names ───────────────────────────────
  validateNoDuplicateRepos(primaryRepo, devRepos, cloneRepos);

  // ── 7. Assemble final InitOptions ─────────────────────────────────────
  const resolved: InitOptions = {
    projectId,
    projectName: merged.projectName!,
    primaryRepo,
    devRepos,
    cloneRepos,
    agent: merged.agent ?? 'claude-code',
    baseBranch: merged.baseBranch ?? 'main',
    releaseStream: merged.releaseStream ?? 'stable',
    variant: merged.variant ?? 'standard',
    force: merged.force ?? false,
    dryRun: merged.dryRun ?? false,
    skipGithubCheck: merged.skipGithubCheck ?? false,
    yes: merged.yes ?? false,
  };

  logger.debug({ resolved }, 'Resolved init options');
  return resolved;
}
