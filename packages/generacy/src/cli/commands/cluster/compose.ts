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

export interface RunComposeOptions {
  env?: Record<string, string>;
}

export function runCompose(ctx: ClusterContext, subcommand: string[], options?: RunComposeOptions): ExecResult {
  const logger = getLogger();
  const managementEndpoint = findManagementEndpoint(ctx);

  // SSH-forwarding branch: run docker compose on remote host
  if (managementEndpoint?.startsWith('ssh://')) {
    const target = parseSshTarget(managementEndpoint);
    const remotePath = target.remotePath ?? ctx.projectRoot;
    const envPrefix = options?.env
      ? Object.entries(options.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') + ' '
      : '';
    const remoteCmd = `cd "${remotePath}" && ${envPrefix}docker compose ${subcommand.join(' ')}`;
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

  const env: Record<string, string> = { ...(options?.env ?? {}) };
  // Auto-detect project-scoped Docker config
  if (dockerConfigExists(ctx.generacyDir)) {
    const dockerConfig = getDockerConfigDir(ctx.generacyDir);
    env.DOCKER_CONFIG = dockerConfig;
    logger.debug({ DOCKER_CONFIG: dockerConfig }, 'Using project-scoped Docker config');
  }

  if (Object.keys(env).length > 0) {
    return execSafe(cmd, { env });
  }
  return execSafe(cmd);
}

export interface LifecycleActionResult {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * Invoke a control-plane lifecycle action via the orchestrator container.
 *
 * Wraps `docker compose exec orchestrator curl --unix-socket ... -X POST
 * http://x/lifecycle/<action>`. Best-effort: a 10s exec timeout caps the call;
 * non-2xx and exec failures are swallowed and logged as warnings so CLI
 * teardown is never blocked by a misbehaving control-plane.
 */
export function lifecycleAction(
  ctx: ClusterContext,
  action: string,
  body?: unknown,
): LifecycleActionResult {
  const logger = getLogger();
  const socketPath = '/run/generacy-control-plane/control.sock';
  const url = `http://x/lifecycle/${action}`;

  const curlArgs = [
    '--silent',
    '--show-error',
    '--max-time', '10',
    '--unix-socket', socketPath,
    '-X', 'POST',
    '-w', '\\n%{http_code}',
  ];

  if (body !== undefined) {
    curlArgs.push('-H', 'Content-Type: application/json');
    curlArgs.push('-d', JSON.stringify(body));
  } else {
    curlArgs.push('-H', 'Content-Length: 0');
  }

  curlArgs.push(url);

  const subcommand = [
    'exec',
    '-T',
    'orchestrator',
    'curl',
    ...curlArgs,
  ];

  const result = runCompose(ctx, subcommand);

  if (!result.ok) {
    logger.warn(
      { action, stderr: result.stderr },
      'Lifecycle action invocation failed (best-effort, continuing)',
    );
    return { ok: false, status: 0, body: result.stderr };
  }

  const output = result.stdout;
  const lastNewline = output.lastIndexOf('\n');
  let status = 0;
  let responseBody = output;
  if (lastNewline >= 0) {
    const statusStr = output.slice(lastNewline + 1).trim();
    const parsed = parseInt(statusStr, 10);
    if (!isNaN(parsed)) {
      status = parsed;
      responseBody = output.slice(0, lastNewline);
    }
  }

  const ok = status >= 200 && status < 300;
  if (!ok) {
    logger.warn(
      { action, status, body: responseBody },
      'Lifecycle action returned non-2xx (best-effort, continuing)',
    );
  }

  return { ok, status, body: responseBody };
}
