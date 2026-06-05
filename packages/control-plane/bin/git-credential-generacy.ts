#!/usr/bin/env node

import http from 'node:http';

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
    // If stdin is closed before any data, 'end' fires naturally.
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

interface SocketResponse {
  status: number;
  body: string;
}

function postToControlSocket(socketPath: string): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: '/git-token',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '2',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write('{}');
    req.end();
  });
}

async function runGet(socketPath: string, input: InputAttrs): Promise<void> {
  if (input.host !== 'github.com') {
    // Defensive bypass — git's per-host config should already prevent this.
    process.exit(0);
  }

  let response: SocketResponse;
  try {
    response = await postToControlSocket(socketPath);
  } catch (err) {
    const cause = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    exitErr({
      code: 'CONTROL_SOCKET_UNREACHABLE',
      message: `control socket at ${socketPath} unreachable (${cause})`,
      exitCode: EXIT_CODE_BY_CODE.CONTROL_SOCKET_UNREACHABLE!,
    });
  }

  if (response.status >= 200 && response.status < 300) {
    let parsed: { token?: unknown; expiresAt?: unknown };
    try {
      parsed = JSON.parse(response.body) as typeof parsed;
    } catch {
      exitErr({
        code: 'CLOUD_RESPONSE_INVALID',
        message: 'control-plane returned a non-JSON body on success',
        exitCode: EXIT_CODE_BY_CODE.CLOUD_RESPONSE_INVALID!,
      });
    }
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) {
      exitErr({
        code: 'CLOUD_RESPONSE_INVALID',
        message: 'control-plane response missing token',
        exitCode: EXIT_CODE_BY_CODE.CLOUD_RESPONSE_INVALID!,
      });
    }
    const out: string[] = [];
    if (input.protocol) out.push(`protocol=${input.protocol}`);
    if (input.host) out.push(`host=${input.host}`);
    out.push('username=x-access-token');
    out.push(`password=${parsed.token}`);
    out.push(''); // trailing blank line
    process.stdout.write(out.join('\n'));
    process.exit(0);
  }

  // Non-2xx — extract code/message from error body if possible.
  let code = 'INTERNAL_ERROR';
  let message = `control-plane returned HTTP ${response.status}`;
  try {
    const errBody = JSON.parse(response.body) as { code?: unknown; error?: unknown };
    if (typeof errBody.code === 'string' && errBody.code in EXIT_CODE_BY_CODE) {
      code = errBody.code;
    }
    if (typeof errBody.error === 'string') {
      message = errBody.error;
    }
  } catch {
    // Fall through to defaults.
  }
  const exitCode = EXIT_CODE_BY_CODE[code] ?? EXIT_CODE_BY_CODE.INTERNAL_ERROR!;
  exitErr({ code, message, exitCode });
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
  const socketPath = process.env['CONTROL_PLANE_SOCKET_PATH'] ?? DEFAULT_SOCKET_PATH;
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
