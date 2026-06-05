#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs/promises';
import {
  createHandler,
  logProxyInit,
} from '../src/git-token-proxy/index.js';

const DEFAULT_LISTEN_SOCKET = '/run/generacy-git-token/control.sock';
const DEFAULT_UPSTREAM_SOCKET = '/run/generacy-control-plane/control.sock';
const LISTEN_SOCKET_MODE = 0o660;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function fail(message: string, exitCode = 1): never {
  process.stderr.write(`git-token-proxy: ${message}\n`);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const listenSocketPath = process.env['GIT_TOKEN_PROXY_SOCKET'] ?? DEFAULT_LISTEN_SOCKET;
  const upstreamSocketPath = process.env['CONTROL_PLANE_SOCKET_PATH'] ?? DEFAULT_UPSTREAM_SOCKET;

  try {
    await fs.unlink(listenSocketPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      fail(`unlink failed: ${listenSocketPath}: ${code ?? 'unknown'}`);
    }
  }

  const server = http.createServer(createHandler({ upstreamSocketPath }));

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      reject(err);
    };
    server.once('error', onError);
    server.listen({ path: listenSocketPath }, () => {
      server.removeListener('error', onError);
      resolve();
    });
  }).catch((err) => {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    fail(`bind failed: ${listenSocketPath}: ${code}`);
  });

  try {
    await fs.chmod(listenSocketPath, LISTEN_SOCKET_MODE);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    fail(`chmod failed: ${listenSocketPath}: ${code}`);
  }

  logProxyInit({ listenSocket: listenSocketPath, upstreamSocket: upstreamSocketPath });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();
    server.close(() => {
      fs.unlink(listenSocketPath)
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(`startup failed: ${message}`);
});
