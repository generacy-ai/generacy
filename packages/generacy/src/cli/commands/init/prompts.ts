/**
 * Interactive prompt flow for `generacy init`.
 *
 * Uses `@clack/prompts` to collect project details from the user.
 * Prompts are skipped when the corresponding value is already provided
 * via CLI flags (passed in as `defaults`). If a `.generacy/config.yaml`
 * already exists the loaded values are used as initial/default values
 * in prompts (re-init flow).
 */
import * as p from '@clack/prompts';
import { basename } from 'node:path';
import { loadConfig } from '../../../config/index.js';
import { getLogger } from '../../utils/logger.js';
import { parseRepoUrl, toShorthand, normalizeRepoUrl } from './repo-utils.js';
import type { InitOptions } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Guard: exit with code 130 if the user cancelled a prompt.
 */
function exitIfCancelled(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel('Operation cancelled.');
    process.exit(130);
  }
}

/**
 * Convert a `github.com/owner/repo` config-format string to `owner/repo`
 * shorthand for display in prompts. Returns the input unchanged if parsing
 * fails (defensive — should not happen with validated config).
 */
function configRepoToShorthand(configUrl: string): string {
  try {
    const parsed = parseRepoUrl(configUrl);
    return toShorthand(parsed);
  } catch {
    return configUrl;
  }
}

/**
 * Validate a repo URL entered at a prompt.
 * Returns `undefined` on success, or an error message string on failure.
 */
function validateRepoInput(value: string): string | undefined {
  if (!value.trim()) return undefined; // empty is allowed for optional fields
  try {
    parseRepoUrl(value);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid repository URL';
  }
}

/**
 * Parse a comma-separated list of repo URLs.
 * Returns validated `owner/repo` shorthand strings.
 * Throws on the first invalid entry.
 */
function parseRepoList(input: string): string[] {
  if (!input.trim()) return [];
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => normalizeRepoUrl(raw).shorthand);
}

/**
 * Validate a comma-separated list of repo URLs.
 * Returns `undefined` on success, or the first error message on failure.
 */
function validateRepoList(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const entries = value.split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    try {
      parseRepoUrl(entry);
    } catch (err) {
      return err instanceof Error ? err.message : `Invalid repository URL: ${entry}`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Existing config detection
// ---------------------------------------------------------------------------

interface ExistingDefaults {
  projectId?: string;
  projectName?: string;
  primaryRepo?: string;
  devRepos?: string[];
  cloneRepos?: string[];
  agent?: string;
  baseBranch?: string;
}

/**
 * Attempt to load an existing `.generacy/config.yaml` and extract values
 * to use as defaults in the interactive prompt flow.
 * Returns an empty object if no config exists or if loading fails.
 */
function loadExistingConfigDefaults(gitRoot: string): ExistingDefaults {
  const logger = getLogger();
  try {
    const config = loadConfig({ startDir: gitRoot });
    const defaults: ExistingDefaults = {
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

    logger.debug({ defaults }, 'Loaded existing config defaults for re-init');
    return defaults;
  } catch {
    // No config or invalid — start fresh
    logger.debug('No existing config found or config is invalid — starting fresh');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the interactive prompt flow using `@clack/prompts`.
 *
 * @param defaults - Partial options already provided via CLI flags or
 *   auto-detection. Values present in `defaults` skip the corresponding
 *   prompt.
 * @param gitRoot - Absolute path to the git repository root. Used to
 *   derive the default project name and to load an existing config.
 * @returns Partial options collected from the user. The resolver merges
 *   these with flags and auto-detected values to produce a complete
 *   `InitOptions`.
 */
export async function runInteractivePrompts(
  defaults: Partial<InitOptions>,
  gitRoot: string,
): Promise<Partial<InitOptions>> {
  // Merge existing config values as fallback defaults
  const existing = loadExistingConfigDefaults(gitRoot);

  const result: Partial<InitOptions> = {};

  // ── Intro ──────────────────────────────────────────────────────────────
  p.intro('generacy init');

  // ── Project name ───────────────────────────────────────────────────────
  if (defaults.projectName !== undefined) {
    result.projectName = defaults.projectName;
  } else {
    const defaultName = existing.projectName ?? basename(gitRoot);
    const projectName = await p.text({
      message: 'Project name',
      placeholder: defaultName,
      initialValue: defaultName,
      validate(value) {
        if (!value.trim()) return 'Project name cannot be empty';
        if (value.length > 255) return 'Project name cannot exceed 255 characters';
        return undefined;
      },
    });
    exitIfCancelled(projectName);
    result.projectName = (projectName as string).trim();
  }

  // ── Primary repo ───────────────────────────────────────────────────────
  if (defaults.primaryRepo !== undefined) {
    result.primaryRepo = defaults.primaryRepo;
  } else {
    const defaultRepo = existing.primaryRepo ?? '';
    const primaryRepo = await p.text({
      message: 'Primary repository (owner/repo)',
      placeholder: 'github.com/owner/repo',
      initialValue: defaultRepo,
      validate(value) {
        if (!value.trim()) return 'Primary repository is required';
        return validateRepoInput(value);
      },
    });
    exitIfCancelled(primaryRepo);
    result.primaryRepo = normalizeRepoUrl((primaryRepo as string).trim()).shorthand;
  }

  // ── Dev repos ──────────────────────────────────────────────────────────
  if (defaults.devRepos !== undefined) {
    result.devRepos = defaults.devRepos;
  } else {
    const defaultDevRepos = existing.devRepos?.join(', ') ?? '';
    const devReposInput = await p.text({
      message: 'Development repositories (comma-separated, or leave empty)',
      placeholder: 'owner/repo-a, owner/repo-b',
      initialValue: defaultDevRepos,
      validate: validateRepoList,
    });
    exitIfCancelled(devReposInput);
    result.devRepos = parseRepoList((devReposInput as string));
  }

  // ── Clone repos ────────────────────────────────────────────────────────
  // Only prompt for clone repos if dev repos were provided (multi-repo flow)
  const hasDevRepos = (result.devRepos ?? []).length > 0;
  if (defaults.cloneRepos !== undefined) {
    result.cloneRepos = defaults.cloneRepos;
  } else if (hasDevRepos) {
    const defaultCloneRepos = existing.cloneRepos?.join(', ') ?? '';
    const cloneReposInput = await p.text({
      message: 'Clone-only repositories (comma-separated, or leave empty)',
      placeholder: 'owner/repo-c, owner/repo-d',
      initialValue: defaultCloneRepos,
      validate: validateRepoList,
    });
    exitIfCancelled(cloneReposInput);
    result.cloneRepos = parseRepoList((cloneReposInput as string));
  } else {
    result.cloneRepos = [];
  }

  // ── Agent ──────────────────────────────────────────────────────────────
  if (defaults.agent !== undefined) {
    result.agent = defaults.agent;
  } else {
    const defaultAgent = existing.agent ?? 'claude-code';
    const agent = await p.select({
      message: 'Default agent',
      options: [
        { value: 'claude-code', label: 'Claude Code', hint: 'Anthropic Claude agent' },
        { value: 'cursor-agent', label: 'Cursor Agent', hint: 'Cursor IDE agent' },
      ],
      initialValue: defaultAgent,
    });
    exitIfCancelled(agent);
    result.agent = agent as string;
  }

  // ── Base branch ────────────────────────────────────────────────────────
  if (defaults.baseBranch !== undefined) {
    result.baseBranch = defaults.baseBranch;
  } else {
    const defaultBranch = existing.baseBranch ?? 'main';
    const baseBranch = await p.text({
      message: 'Default base branch',
      placeholder: defaultBranch,
      initialValue: defaultBranch,
      validate(value) {
        if (!value.trim()) return 'Base branch cannot be empty';
        return undefined;
      },
    });
    exitIfCancelled(baseBranch);
    result.baseBranch = (baseBranch as string).trim();
  }

  return result;
}
