import crypto from 'node:crypto';
import type { LaunchRequestCredentials } from '@generacy-ai/credhelper';
import type { CredhelperClient, BeginSessionResult } from './credhelper-client.js';

/**
 * Generate a composite session ID from environment variables.
 * Format: {agentId}-{workflowId}-{timestamp}-{random4}
 */
export function generateSessionId(env: Record<string, string>): string {
  const agentId = env.AGENT_ID ?? env.HOSTNAME ?? 'unknown';
  const workflowId = env.WORKFLOW_ID ?? 'adhoc';
  const timestamp = Math.floor(Date.now() / 1000);
  const random = crypto.randomBytes(2).toString('hex');
  return `${agentId}-${workflowId}-${timestamp}-${random}`;
}

/**
 * Build session environment variables from a session directory path.
 */
export function buildSessionEnv(sessionDir: string): Record<string, string> {
  return {
    GENERACY_SESSION_DIR: sessionDir,
    GIT_CONFIG_GLOBAL: `${sessionDir}/git/config`,
    GOOGLE_APPLICATION_CREDENTIALS: `${sessionDir}/gcp/external-account.json`,
    DOCKER_HOST: `unix://${sessionDir}/docker.sock`,
  };
}

/**
 * Wrap a command in an entrypoint that sources the session env file.
 * Uses positional parameters to avoid shell escaping.
 *
 * Input:  command='claude', args=['--model', 'opus']
 * Output: command='sh', args=['-c', '. "$GENERACY_SESSION_DIR/env" && exec "$@"', '_', 'claude', '--model', 'opus']
 */
export function wrapCommand(command: string, args: string[]): { command: string; args: string[] } {
  return {
    command: 'sh',
    args: [
      '-c',
      '. "$GENERACY_SESSION_DIR/env" && exec "$@"',
      '_',
      command,
      ...args,
    ],
  };
}

export interface InterceptorResult {
  command: string;
  args: string[];
  env: Record<string, string>;
  uid: number;
  gid: number;
  sessionId: string;
}

/**
 * Apply credentials interceptor: begins a credhelper session, merges session env,
 * wraps the command, and returns transformed spawn params with uid/gid.
 */
export async function applyCredentials(
  client: CredhelperClient,
  credentials: LaunchRequestCredentials,
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<InterceptorResult> {
  const sessionId = generateSessionId(env);

  const session: BeginSessionResult = await client.beginSession(
    credentials.role,
    sessionId,
  );

  const sessionEnv = buildSessionEnv(session.sessionDir);
  const mergedEnv = { ...env, ...sessionEnv };

  const wrapped = wrapCommand(command, args);

  return {
    command: wrapped.command,
    args: wrapped.args,
    env: mergedEnv,
    uid: credentials.uid,
    gid: credentials.gid,
    sessionId,
  };
}
