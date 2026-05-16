import { execSafe, type ExecResult } from '../../utils/exec.js';
import { dockerComposeArgs } from '../cluster/compose.js';
import type { ClusterContext } from '../cluster/context.js';

export function isClusterRunning(ctx: ClusterContext): boolean {
  const args = dockerComposeArgs(ctx);
  const cmd = ['docker', 'compose', ...args, 'ps', '--format', 'json'].join(' ');
  const result = execSafe(cmd);
  return result.ok && result.stdout.trim().length > 0;
}

export function forwardCredential(ctx: ClusterContext, host: string, username: string, password: string): ExecResult {
  const value = JSON.stringify({ username, password });
  const body = JSON.stringify({ type: 'docker-registry', value });
  const args = dockerComposeArgs(ctx);
  const cmd = [
    'docker', 'compose', ...args,
    'exec', 'orchestrator',
    'curl', '--silent', '--fail',
    '--unix-socket', '/run/generacy-control-plane/control.sock',
    '-X', 'PUT',
    '-H', "'Content-Type: application/json'",
    '-d', `'${body}'`,
    `http://localhost/credentials/registry-${host}`,
  ].join(' ');
  return execSafe(cmd);
}

export function removeCredential(ctx: ClusterContext, host: string): ExecResult {
  const args = dockerComposeArgs(ctx);
  const cmd = [
    'docker', 'compose', ...args,
    'exec', 'orchestrator',
    'curl', '--silent', '--fail',
    '--unix-socket', '/run/generacy-control-plane/control.sock',
    '-X', 'DELETE',
    `http://localhost/credentials/registry-${host}`,
  ].join(' ');
  return execSafe(cmd);
}
