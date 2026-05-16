import { execSafe, type ExecResult } from '../../utils/exec.js';
import { getLogger } from '../../utils/logger.js';
import type { ClusterContext } from './context.js';
import { readRegistry } from './registry.js';
import { parseSshTarget } from '../deploy/ssh-target.js';
import { sshExec } from '../deploy/ssh-client.js';
import { dockerConfigExists, getDockerConfigDir } from '../registry-login/docker-config.js';

export function dockerComposeArgs(ctx: ClusterContext): string[] {
  return [
    `--project-name=${ctx.projectName}`,
    `--file=${ctx.composePath}`,
  ];
}

/**
 * Find the management endpoint for a cluster from the registry.
 */
function findManagementEndpoint(ctx: ClusterContext): string | undefined {
  const registry = readRegistry();
  const entry = registry.find(
    (e) => e.path === ctx.projectRoot || e.clusterId === ctx.clusterIdentity?.cluster_id,
  );
  return entry?.managementEndpoint;
}

export function runCompose(ctx: ClusterContext, subcommand: string[]): ExecResult {
  const logger = getLogger();
  const managementEndpoint = findManagementEndpoint(ctx);

  // SSH-forwarding branch: run docker compose on remote host
  if (managementEndpoint?.startsWith('ssh://')) {
    const target = parseSshTarget(managementEndpoint);
    const remotePath = target.remotePath ?? ctx.projectRoot;
    const remoteCmd = `cd "${remotePath}" && docker compose ${subcommand.join(' ')}`;
    logger.debug({ remoteCmd, host: target.host }, 'Running docker compose over SSH');

    try {
      const stdout = sshExec(target, remoteCmd);
      return { ok: true, stdout, stderr: '' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, stdout: '', stderr: msg };
    }
  }

  // Local compose path
  const args = dockerComposeArgs(ctx);
  const cmd = ['docker', 'compose', ...args, ...subcommand].join(' ');
  logger.debug({ cmd }, 'Running docker compose');

  // Auto-detect project-scoped Docker config
  if (dockerConfigExists(ctx.generacyDir)) {
    const dockerConfig = getDockerConfigDir(ctx.generacyDir);
    logger.debug({ DOCKER_CONFIG: dockerConfig }, 'Using project-scoped Docker config');
    return execSafe(cmd, { env: { DOCKER_CONFIG: dockerConfig } });
  }

  return execSafe(cmd);
}
