import { execSafe, type ExecResult } from '../../utils/exec.js';
import { getLogger } from '../../utils/logger.js';
import type { ClusterContext } from './context.js';

export function dockerComposeArgs(ctx: ClusterContext): string[] {
  return [
    `--project-name=${ctx.projectName}`,
    `--file=${ctx.composePath}`,
  ];
}

export function runCompose(ctx: ClusterContext, subcommand: string[]): ExecResult {
  const logger = getLogger();
  const args = dockerComposeArgs(ctx);
  const cmd = ['docker', 'compose', ...args, ...subcommand].join(' ');
  logger.debug({ cmd }, 'Running docker compose');
  return execSafe(cmd);
}
