/**
 * `generacy init` command — scaffolds a Generacy project in the current repository.
 *
 * Wires together the full init flow:
 *   1. Detect git root
 *   2. Resolve options (flags + prompts + auto-detection)
 *   3. GitHub validation (advisory)
 *   4. Fetch cluster base repo files from GitHub
 *   5. Collect existing files for merge support
 *   6. Generate CLI-owned files (config, env, gitignore, extensions)
 *   7. Merge template + CLI files
 *   8. Check & resolve file conflicts
 *   9. Write files (or dry-run preview)
 *  10. Post-generation config validation
 *  11. Print summary & next steps
 */
import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import { loadConfig } from '../../../config/index.js';
import { getLogger } from '../../utils/logger.js';
import { detectGitRoot } from './repo-utils.js';
import { resolveOptions, ResolverError } from './resolver.js';
import { runGitHubValidation } from './github.js';
import { fetchClusterTemplates } from './template-fetcher.js';
import { generateCliFiles, generateExtensionsJson } from './file-generators.js';
import { checkConflicts, resolveConflicts } from './conflicts.js';
import { writeFiles, collectExistingFiles } from './writer.js';
import { printSummary, printNextSteps } from './summary.js';

/**
 * Create the `init` subcommand with all CLI flags.
 */
export function initCommand(): Command {
  const command = new Command('init');

  command
    .description('Initialize a Generacy project in the current repository')
    .option('--project-id <id>', 'Link to existing project (proj_xxx format)')
    .option('--project-name <name>', 'Project display name')
    .option('--primary-repo <repo>', 'Primary repository (github.com/owner/repo)')
    .option('--dev-repo <repo...>', 'Dev repository (repeatable)')
    .option('--clone-repo <repo...>', 'Clone repository (repeatable)')
    .option('--agent <agent>', 'Default agent', 'claude-code')
    .option('--base-branch <branch>', 'Default base branch', 'main')
    .addOption(
      new Option('--release-stream <stream>', 'Release stream')
        .choices(['stable', 'preview'])
        .default('stable'),
    )
    .addOption(
      new Option('--variant <variant>', 'Cluster variant (standard = DooD, microservices = DinD)')
        .choices(['standard', 'microservices']),
    )
    .option('--template-ref <ref>', 'Git ref for cluster base repo (branch, tag, or commit)')
    .option('--refresh-templates', 'Bypass template cache and re-download')
    .option('--force', 'Overwrite existing files without prompting')
    .option('--dry-run', 'Preview files without writing')
    .option('--skip-github-check', 'Skip GitHub access validation')
    .option('-y, --yes', 'Accept defaults without prompting')
    .action(async (_opts, cmd) => {
      await initAction(cmd.opts());
    });

  return command;
}

/**
 * Full init action — orchestrates the entire project initialization flow.
 */
async function initAction(flags: Record<string, unknown>): Promise<void> {
  const logger = getLogger();

  // ── 1. Detect git root ─────────────────────────────────────────────────
  const gitRoot = detectGitRoot(process.cwd());
  if (!gitRoot) {
    p.log.error('Not inside a Git repository. Run this command from within a Git repo.');
    process.exit(1);
  }

  // ── 2. Resolve options (flags + prompts + auto-detect) ─────────────────
  let initOptions;
  try {
    initOptions = await resolveOptions(flags, gitRoot);
  } catch (error) {
    if (error instanceof ResolverError) {
      p.log.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  logger.debug({ initOptions }, 'Resolved init options');

  // ── 3. GitHub validation (unless skipped) ──────────────────────────────
  await runGitHubValidation(initOptions);

  // ── 4. Fetch cluster base repo files from GitHub ────────────────────────
  // TODO: [FR-017] When API integration is available, fetch project details
  //       from the Generacy API if --project-id was provided.
  // TODO: [FR-018] When API integration is available, optionally create a
  //       new project via the Generacy API and use the server-issued ID.

  let clusterFiles: Map<string, string>;
  try {
    clusterFiles = await fetchClusterTemplates({
      variant: initOptions.variant,
      ref: initOptions.templateRef,
      refreshCache: initOptions.refreshTemplates,
    });
  } catch (error) {
    p.log.error(
      `Failed to fetch cluster base repo: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  logger.debug({ fileCount: clusterFiles.size }, 'Fetched cluster template files');

  // ── 5. Collect existing files for merge support ────────────────────────
  const existingFiles = collectExistingFiles(gitRoot);

  // ── 6. Generate CLI-owned files ────────────────────────────────────────
  const cliFiles = generateCliFiles(initOptions);

  // Merge extensions.json with existing content if present
  const extensionsPath = '.vscode/extensions.json';
  const existingExtensions = existingFiles.get(extensionsPath);
  if (existingExtensions) {
    cliFiles.set(extensionsPath, generateExtensionsJson(existingExtensions));
  }

  // ── 7. Merge template + CLI files ──────────────────────────────────────
  const renderedFiles = new Map([...clusterFiles, ...cliFiles]);

  logger.debug({ fileCount: renderedFiles.size }, 'Total files to write');

  // ── 8. Check conflicts ─────────────────────────────────────────────────
  const conflicts = checkConflicts(renderedFiles, gitRoot);
  if (conflicts.size > 0) {
    logger.debug({ conflictCount: conflicts.size }, 'File conflicts detected');
  }

  // ── 8b. Migration detection for old-format devcontainer.json ──────────
  const devcontainerPath = '.devcontainer/devcontainer.json';
  const existingDevcontainer = conflicts.get(devcontainerPath);
  if (existingDevcontainer) {
    try {
      const parsed = JSON.parse(existingDevcontainer);
      if (parsed.image && !parsed.dockerComposeFile) {
        p.log.warn(
          'Existing devcontainer.json uses the old image-based format.\n' +
            '  Cluster templates use docker-compose. We recommend overwriting to adopt the new format.',
        );
      }
    } catch {
      // Invalid JSON — skip migration detection silently
    }
  }

  // ── 9. Resolve conflicts (prompt or force) ─────────────────────────────
  const actions = await resolveConflicts(renderedFiles, conflicts, initOptions);

  // ── 10. Write files (or dry-run preview) ───────────────────────────────
  const results = await writeFiles(renderedFiles, actions, gitRoot, initOptions.dryRun);

  // ── 11. Post-generation validation (skip if dry-run) ──────────────────
  if (!initOptions.dryRun) {
    try {
      loadConfig({ startDir: gitRoot });
      logger.debug('Post-generation config validation passed');
    } catch (error) {
      p.log.warn('Generated config failed validation — please check .generacy/config.yaml');
      logger.debug({ error }, 'Post-generation validation error');
    }
  }

  // ── 12. Print summary and next steps ──────────────────────────────────
  printSummary(results, initOptions.dryRun, initOptions.variant);
  if (!initOptions.dryRun) {
    printNextSteps();
  }

  p.outro('Done!');
}
