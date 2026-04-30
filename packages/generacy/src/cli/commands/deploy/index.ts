import { Command } from 'commander';
import { rmSync } from 'node:fs';
import { getLogger } from '../../utils/logger.js';
import { parseSshTarget, formatSshTarget } from './ssh-target.js';
import { verifySshConnectivity, verifyDockerPresence } from './ssh-client.js';
import { runActivation } from './activation.js';
import { fetchLaunchConfig } from './cloud-client.js';
import { scaffoldBundle } from './scaffolder.js';
import { deployToRemote } from './remote-compose.js';
import { pollClusterStatus } from './status-poller.js';
import { readRegistry, writeRegistry, type RegistryEntry } from '../cluster/registry.js';
import type { DeployOptions, DeployResult } from './types.js';
import { DeployError } from './types.js';

const DEFAULT_TIMEOUT_S = 300;
const DEFAULT_CLOUD_URL = 'https://api.generacy.ai';

async function handleDeploy(options: DeployOptions): Promise<DeployResult> {
  const logger = getLogger();

  // 1. Parse SSH target
  const target = parseSshTarget(options.target);
  logger.info(`Deploying to ${target.user}@${target.host}:${target.port}`);

  // 2. Verify SSH connectivity
  logger.info('Verifying SSH connectivity...');
  verifySshConnectivity(target);
  logger.info('SSH connectivity verified');

  // 3. Verify Docker presence
  logger.info('Verifying Docker on remote host...');
  verifyDockerPresence(target);
  logger.info('Docker verified');

  // 4. Run device-flow activation
  const cloudUrl = options.cloudUrl ?? DEFAULT_CLOUD_URL;
  logger.info('Starting device-flow activation...');
  const activation = await runActivation({ cloudUrl, logger });

  // 5. Fetch launch config from cloud
  logger.info('Fetching cluster configuration from cloud...');
  let launchConfig;
  try {
    launchConfig = await fetchLaunchConfig(cloudUrl, activation.clusterId);
  } catch (error) {
    throw new DeployError(
      `Failed to fetch launch config: ${error instanceof Error ? error.message : String(error)}`,
      'LAUNCH_CONFIG_FAILED',
      error instanceof Error ? error : undefined,
    );
  }

  // 6. Resolve remote path
  const remotePath = target.remotePath ?? `~/generacy-clusters/${activation.projectId}`;

  // 7. Scaffold bootstrap bundle
  logger.info('Generating bootstrap bundle...');
  const bundleDir = scaffoldBundle(launchConfig, activation, cloudUrl);

  // 8. Transfer and start
  try {
    deployToRemote(target, bundleDir, remotePath);
  } finally {
    // Clean up temp dir
    try { rmSync(bundleDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // 9. Poll for registration
  const timeoutMs = (options.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
  logger.info(`Waiting for cluster to register (timeout: ${Math.round(timeoutMs / 1000)}s)...`);
  await pollClusterStatus(cloudUrl, activation.clusterId, activation.apiKey, timeoutMs);

  logger.info('Cluster registered successfully!');

  // 10. Add to local registry
  const managementEndpoint = formatSshTarget({ ...target, remotePath });
  const now = new Date().toISOString();
  const registry = readRegistry();
  const entry: RegistryEntry = {
    clusterId: activation.clusterId,
    name: launchConfig.projectName,
    path: remotePath,
    composePath: `${remotePath}/docker-compose.yml`,
    variant: launchConfig.variant as 'standard' | 'microservices',
    channel: 'stable',
    cloudUrl,
    lastSeen: now,
    createdAt: now,
    managementEndpoint,
  };
  registry.push(entry);
  writeRegistry(registry);

  logger.info(`Cluster ${activation.clusterId} added to registry`);

  return {
    clusterId: activation.clusterId,
    projectId: activation.projectId,
    orgId: activation.orgId,
    cloudUrl,
    managementEndpoint,
    remotePath,
  };
}

export function deployCommand(): Command {
  const cmd = new Command('deploy');

  cmd
    .description('Deploy a Generacy cluster to a remote VM via SSH')
    .argument('<target>', 'SSH target: ssh://[user@]host[:port][/path]')
    .option('--timeout <seconds>', 'Timeout for cluster registration in seconds', String(DEFAULT_TIMEOUT_S))
    .option('--cloud-url <url>', 'Cloud API URL override')
    .action(async (target: string, opts: { timeout?: string; cloudUrl?: string }) => {
      try {
        const result = await handleDeploy({
          target,
          timeout: opts.timeout ? parseInt(opts.timeout, 10) : DEFAULT_TIMEOUT_S,
          cloudUrl: opts.cloudUrl,
        });

        console.log(`\nCluster deployed successfully!`);
        console.log(`  Cluster ID: ${result.clusterId}`);
        console.log(`  Management: ${result.managementEndpoint}`);
        console.log(`  Remote path: ${result.remotePath}`);
        console.log(`\nManage with: generacy stop/up/down --cluster=${result.clusterId}`);
      } catch (error) {
        if (error instanceof DeployError) {
          console.error(`\nDeploy failed: ${error.message}`);
          if (process.env['DEBUG'] && error.cause) {
            console.error(error.cause);
          }
          process.exit(1);
        }
        throw error;
      }
    });

  return cmd;
}
