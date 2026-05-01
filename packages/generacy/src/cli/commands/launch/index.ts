/**
 * `generacy launch` command — claim-code first-run flow.
 *
 * Bootstraps a new cluster from a cloud-issued claim code:
 *   1. Validate Node version (>=20) and Docker reachability
 *   2. Read --claim or prompt for it
 *   3. Fetch launch-config from cloud API
 *   4. Scaffold project directory with config files
 *   5. docker compose pull + up
 *   6. Stream logs until activation URL appears
 *   7. Auto-open browser with verification URL
 *   8. Register cluster in ~/.generacy/clusters.json
 */
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { getLogger } from '../../utils/logger.js';
import { execSafe } from '../../utils/exec.js';
import { checkNodeVersion } from '../../utils/node-version.js';
import type { LaunchOptions } from './types.js';
import { promptClaimCode, confirmDirectory } from './prompts.js';
import { fetchLaunchConfig } from './cloud-client.js';
import { scaffoldProject, resolveProjectDir } from './scaffolder.js';
import { pullImage, startCluster, streamLogsUntilActivation } from './compose.js';
import { openBrowser } from './browser.js';
import { registerCluster } from './registry.js';
import { resolve } from 'node:path';

/**
 * Create the `launch` subcommand.
 */
export function launchCommand(): Command {
  const command = new Command('launch');

  command
    .description('Bootstrap a new cluster from a cloud-issued claim code')
    .option('--claim <code>', 'Claim code from the Generacy cloud dashboard')
    .option('--dir <path>', 'Project directory (default: ~/Generacy/<projectName>)')
    .action(async (_opts, cmd) => {
      await launchAction(cmd.opts() as LaunchOptions);
    });

  return command;
}


/**
 * Validate Docker daemon is reachable.
 */
function validateDocker(): { ok: boolean; message: string } {
  const result = execSafe('docker info');
  if (result.ok) {
    return { ok: true, message: 'Docker is available' };
  }

  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (combined.includes('not found') || combined.includes('is not recognized')) {
    return { ok: false, message: 'Docker is not installed. Install Docker Desktop from https://docker.com' };
  }
  if (combined.includes('cannot connect to the docker daemon')) {
    return {
      ok: false,
      message: 'Docker daemon is not running. Start Docker Desktop or run `sudo systemctl start docker`',
    };
  }
  if (combined.includes('permission denied')) {
    return {
      ok: false,
      message: 'Insufficient permissions to access Docker. Run: sudo usermod -aG docker $USER',
    };
  }
  return { ok: false, message: 'Docker check failed. Run `docker info` manually to diagnose.' };
}

/**
 * Full launch action — orchestrates the entire first-run flow.
 */
async function launchAction(opts: LaunchOptions): Promise<void> {
  const logger = getLogger();

  p.intro('generacy launch');

  // ── 1. Validate Node version ────────────────────────────────────────
  checkNodeVersion(22);

  // ── 2. Validate Docker ──────────────────────────────────────────────
  const dockerStatus = validateDocker();
  if (!dockerStatus.ok) {
    p.log.error(dockerStatus.message);
    process.exit(1);
  }

  // ── 3. Read --claim or prompt for it ────────────────────────────────
  const claimCode = opts.claim ?? await promptClaimCode();
  logger.debug({ claimCode }, 'Using claim code');

  // ── 4. Fetch launch-config from cloud API ───────────────────────────
  const cloudUrl = process.env['GENERACY_CLOUD_URL'] ?? 'https://api.generacy.ai';
  let config;
  try {
    const spin = p.spinner();
    spin.start('Fetching launch configuration...');
    config = await fetchLaunchConfig(cloudUrl, claimCode);
    spin.stop('Launch configuration received');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    p.log.error(`Failed to fetch launch configuration: ${msg}`);
    process.exit(1);
  }

  logger.debug({ config }, 'Received launch config');

  // ── 5. Determine project directory + confirm ────────────────────────
  const projectDir = resolveProjectDir(config.projectName, opts.dir);
  const confirmed = await confirmDirectory(projectDir);
  if (!confirmed) {
    p.log.info('Use --dir to specify a different directory.');
    p.cancel('Launch cancelled.');
    process.exit(130);
  }

  // ── 6. Scaffold project directory ───────────────────────────────────
  try {
    scaffoldProject(projectDir, config);
    p.log.success('Project directory created');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    p.log.error(`Failed to scaffold project: ${msg}`);
    process.exit(1);
  }

  // ── 7. docker compose pull ──────────────────────────────────────────
  try {
    const spin = p.spinner();
    spin.start('Pulling cluster image...');
    pullImage(projectDir);
    spin.stop('Image pulled');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    p.log.error(
      `Failed to pull cluster image ${config.imageTag}: ${msg}\n` +
        '  Check Docker Hub / GHCR access. Run `docker login ghcr.io`',
    );
    process.exit(1);
  }

  // ── 8. docker compose up -d ─────────────────────────────────────────
  try {
    startCluster(projectDir);
    p.log.success('Cluster started');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    p.log.error(
      `Failed to start cluster: ${msg}\n` + '  Check `docker compose logs` for details',
    );
    process.exit(1);
  }

  // ── 9. Stream logs → match activation URL ───────────────────────────
  let activationUrl: string;
  let userCode: string;
  try {
    const spin = p.spinner();
    spin.start('Waiting for activation URL...');
    const activation = await streamLogsUntilActivation(projectDir);
    spin.stop('Activation URL detected');
    activationUrl = activation.verificationUri;
    userCode = activation.userCode;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    p.log.error(
      `Timed out waiting for activation URL: ${msg}\n` +
        '  Check cluster health with `docker compose logs`',
    );
    process.exit(1);
  }

  // ── 10. Display code, open browser ──────────────────────────────────
  p.log.info(`\n  Your activation code: ${userCode}\n`);
  openBrowser(activationUrl);

  // ── 11. Register cluster ────────────────────────────────────────────
  try {
    const composePath = resolve(projectDir, '.generacy', 'docker-compose.yml');
    const now = new Date().toISOString();
    registerCluster({
      clusterId: config.clusterId,
      name: config.projectName,
      path: projectDir,
      composePath,
      variant: (config.variant as 'cluster-base' | 'cluster-microservices') ?? 'cluster-base',
      channel: 'stable',
      cloudUrl: config.cloudUrl,
      lastSeen: now,
      createdAt: now,
    });
    logger.debug('Cluster registered in ~/.generacy/clusters.json');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    p.log.warn(`Failed to register cluster: ${msg}`);
    // Non-fatal — cluster is running, just not registered
  }

  p.outro('Cluster is running! Complete activation in your browser.');
}
