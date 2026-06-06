#!/usr/bin/env node

import {
  createJitGitTokenClient,
  JitTokenError,
  type JitTokenErrorCode,
} from '../src/services/jit-git-token-client.js';

const DEFAULT_SOCKET_PATH = '/run/generacy-control-plane/control.sock';

type Action = 'get' | 'store' | 'erase';

interface ErrorOutcome {
  code: string;
  message: string;
  exitCode: number;
}

const EXIT_CODE_BY_CODE: Record<string, number> = {
  CONTROL_SOCKET_UNREACHABLE: 2,
  CLUSTER_API_KEY_MISSING: 3,
  CLOUD_UNREACHABLE: 4,
  CLOUD_AUTH_REJECTED: 5,
  CLOUD_REQUEST_INVALID: 6,
  CLOUD_UPSTREAM_ERROR: 7,
  CLOUD_RESPONSE_INVALID: 8,
  CREDENTIAL_NOT_CONFIGURED: 9,
  RESPONSE_PARSE_ERROR: 8,
  INTERNAL_ERROR: 1,
};

function exitErr(outcome: ErrorOutcome): never {
  process.stderr.write(`generacy-git-helper: ${outcome.code}: ${outcome.message}\n`);
  process.exit(outcome.exitCode);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

interface InputAttrs {
  protocol?: string;
  host?: string;
}

function parseInput(raw: string): InputAttrs {
  const attrs: InputAttrs = {};
  for (const line of raw.split('\n')) {
    if (line === '') break;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === 'protocol') attrs.protocol = value;
    else if (key === 'host') attrs.host = value;
  }
  return attrs;
}

function resolveSocketPath(): string {
  return (
    process.env['GIT_TOKEN_SOCKET_PATH'] ??
    process.env['CONTROL_PLANE_SOCKET_PATH'] ??
    DEFAULT_SOCKET_PATH
  );
}

function mapJitErrorToExit(code: JitTokenErrorCode): number {
  return EXIT_CODE_BY_CODE[code] ?? EXIT_CODE_BY_CODE.INTERNAL_ERROR!;
}

async function runGet(socketPath: string, input: InputAttrs): Promise<void> {
  if (input.host !== 'github.com') {
    // Defensive bypass — git's per-host config should already prevent this.
    process.exit(0);
  }

  const client = createJitGitTokenClient({ socketPath });

  let token: string;
  try {
    const response = await client.fetch();
    token = response.token;
  } catch (err) {
    if (err instanceof JitTokenError) {
      exitErr({
        code: err.code,
        message: err.message,
        exitCode: mapJitErrorToExit(err.code),
      });
    }
    exitErr({
      code: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : String(err),
      exitCode: EXIT_CODE_BY_CODE.INTERNAL_ERROR!,
    });
  }

  const out: string[] = [];
  if (input.protocol) out.push(`protocol=${input.protocol}`);
  if (input.host) out.push(`host=${input.host}`);
  out.push('username=x-access-token');
  out.push(`password=${token}`);
  out.push(''); // trailing blank line
  process.stdout.write(out.join('\n'));
  process.exit(0);
}

async function main(): Promise<void> {
  const action = process.argv[2] as Action | undefined;
  if (action !== 'get' && action !== 'store' && action !== 'erase') {
    exitErr({
      code: 'INTERNAL_ERROR',
      message: `unknown action ${action ?? '<none>'}`,
      exitCode: EXIT_CODE_BY_CODE.INTERNAL_ERROR!,
    });
  }

  const raw = await readStdin();

  if (action === 'store' || action === 'erase') {
    process.exit(0);
  }

  const input = parseInput(raw);
  const socketPath = resolveSocketPath();
  await runGet(socketPath, input);
}

main().catch((err: unknown) => {
  // Defensive catch — main() should never throw past runGet/exitErr.
  exitErr({
    code: 'INTERNAL_ERROR',
    message: err instanceof Error ? err.message : String(err),
    exitCode: EXIT_CODE_BY_CODE.INTERNAL_ERROR!,
  });
});
