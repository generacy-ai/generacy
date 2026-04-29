import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {
  CodeServerProcessManager,
  loadOptionsFromEnv,
  DEFAULT_CODE_SERVER_BIN,
  DEFAULT_CODE_SERVER_SOCKET,
  DEFAULT_IDLE_TIMEOUT_MS,
} from '../../src/services/code-server-manager.js';

// Build a tiny shell script that pretends to be code-server: it parses the
// --socket arg and binds a Unix socket so the manager's "running" detection
// triggers. We then SIGTERM/SIGKILL it like the real binary.
async function makeFakeCodeServer(scriptPath: string, listenerPath: string): Promise<void> {
  const helper = `#!/usr/bin/env node
const net = require('node:net');
const fs = require('node:fs');

const args = process.argv.slice(2);
let socketPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--socket') socketPath = args[i + 1];
}
if (!socketPath) { console.error('no --socket arg'); process.exit(2); }

try { fs.unlinkSync(socketPath); } catch (_) {}

const server = net.createServer();
server.listen(socketPath, () => {
  process.send && process.send('ready');
});

let shutting = false;
function shutdown() {
  if (shutting) return;
  shutting = true;
  server.close(() => {
    try { fs.unlinkSync(socketPath); } catch (_) {}
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// keep alive
setInterval(() => {}, 1000);
`;
  await fs.writeFile(scriptPath, helper, { mode: 0o755 });
  // listenerPath is unused in the script body; included so the test reads/cleans the same path.
  void listenerPath;
}

describe('CodeServerProcessManager', () => {
  let tmpDir: string;
  let socketPath: string;
  let fakeBin: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-mgr-'));
    socketPath = path.join(tmpDir, 'code-server.sock');
    fakeBin = path.join(tmpDir, 'fake-code-server.js');
    await makeFakeCodeServer(fakeBin, socketPath);
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('starts code-server, returns socket_path, and a TCP/Unix client can connect', async () => {
    const mgr = new CodeServerProcessManager({
      binPath: process.execPath,
      socketPath,
      idleTimeoutMs: 60_000,
    });
    // Override the binary spawn: we want node to run the fake script
    const start = mgr.start();
    // Patch by reissuing with an arg-prepending wrapper bin: instead, replace via subclassing.
    // Simplest: re-create with a wrapper script.
    await mgr.stop().catch(() => {});
    await start.catch(() => {});

    const wrapperBin = path.join(tmpDir, 'wrapper.sh');
    await fs.writeFile(
      wrapperBin,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeBin}" "$@"\n`,
      { mode: 0o755 },
    );

    const wrapped = new CodeServerProcessManager({
      binPath: wrapperBin,
      socketPath,
      idleTimeoutMs: 60_000,
    });
    const result = await wrapped.start();
    expect(result.socket_path).toBe(socketPath);
    expect(['starting', 'running']).toContain(result.status);

    // Wait briefly until the socket exists, then connect.
    await waitForFile(socketPath, 5000);
    await new Promise<void>((resolve, reject) => {
      const c = net.createConnection(socketPath);
      c.on('connect', () => {
        c.end();
        resolve();
      });
      c.on('error', reject);
    });

    await wrapped.stop();
    expect(wrapped.getStatus()).toBe('stopped');
  });

  it('start() is idempotent — second call returns the same socket and reuses the child', async () => {
    const wrapperBin = path.join(tmpDir, 'wrapper.sh');
    await fs.writeFile(
      wrapperBin,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeBin}" "$@"\n`,
      { mode: 0o755 },
    );
    const mgr = new CodeServerProcessManager({
      binPath: wrapperBin,
      socketPath,
      idleTimeoutMs: 60_000,
    });
    const a = await mgr.start();
    const b = await mgr.start();
    expect(a.socket_path).toBe(b.socket_path);
    await mgr.stop();
  });

  it('auto-stops after the configured idle window', async () => {
    const wrapperBin = path.join(tmpDir, 'wrapper.sh');
    await fs.writeFile(
      wrapperBin,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeBin}" "$@"\n`,
      { mode: 0o755 },
    );
    const mgr = new CodeServerProcessManager({
      binPath: wrapperBin,
      socketPath,
      idleTimeoutMs: 150,
      forceKillTimeoutMs: 1000,
    });
    await mgr.start();
    await waitForFile(socketPath, 5000);
    // Wait past the idle window — manager's setTimeout should fire and stop.
    await waitFor(() => mgr.getStatus() === 'stopped', 3000);
    expect(mgr.getStatus()).toBe('stopped');
  });

  it('touch() resets the idle timer', async () => {
    const wrapperBin = path.join(tmpDir, 'wrapper.sh');
    await fs.writeFile(
      wrapperBin,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeBin}" "$@"\n`,
      { mode: 0o755 },
    );
    const mgr = new CodeServerProcessManager({
      binPath: wrapperBin,
      socketPath,
      idleTimeoutMs: 200,
      forceKillTimeoutMs: 1000,
    });
    await mgr.start();
    await waitForFile(socketPath, 5000);
    // Touch repeatedly so the timer never fires within ~500ms
    const start = Date.now();
    while (Date.now() - start < 500) {
      mgr.touch();
      await sleep(50);
    }
    expect(mgr.getStatus()).not.toBe('stopped');
    await mgr.stop();
  });

  it('stop() is a no-op when not running', async () => {
    const mgr = new CodeServerProcessManager({
      binPath: '/bin/false',
      socketPath,
      idleTimeoutMs: 60_000,
    });
    await expect(mgr.stop()).resolves.toBeUndefined();
  });
});

describe('loadOptionsFromEnv', () => {
  it('uses defaults when no env is set', () => {
    const opts = loadOptionsFromEnv({});
    expect(opts.binPath).toBe(DEFAULT_CODE_SERVER_BIN);
    expect(opts.socketPath).toBe(DEFAULT_CODE_SERVER_SOCKET);
    expect(opts.idleTimeoutMs).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(opts.userDataDir).toBeUndefined();
    expect(opts.extensionsDir).toBeUndefined();
  });

  it('reads overrides from env', () => {
    const opts = loadOptionsFromEnv({
      CODE_SERVER_BIN: '/opt/code-server/bin/code-server',
      CODE_SERVER_SOCKET_PATH: '/tmp/cs.sock',
      CODE_SERVER_IDLE_TIMEOUT_MS: '1000',
      CODE_SERVER_USER_DATA_DIR: '/data/code-server',
      CODE_SERVER_EXTENSIONS_DIR: '/data/code-server/exts',
    });
    expect(opts.binPath).toBe('/opt/code-server/bin/code-server');
    expect(opts.socketPath).toBe('/tmp/cs.sock');
    expect(opts.idleTimeoutMs).toBe(1000);
    expect(opts.userDataDir).toBe('/data/code-server');
    expect(opts.extensionsDir).toBe('/data/code-server/exts');
  });

  it('falls back to default for non-positive idle timeouts', () => {
    expect(loadOptionsFromEnv({ CODE_SERVER_IDLE_TIMEOUT_MS: '0' }).idleTimeoutMs).toBe(
      DEFAULT_IDLE_TIMEOUT_MS,
    );
    expect(loadOptionsFromEnv({ CODE_SERVER_IDLE_TIMEOUT_MS: 'abc' }).idleTimeoutMs).toBe(
      DEFAULT_IDLE_TIMEOUT_MS,
    );
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFile(target: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.stat(target);
      return;
    } catch {
      await sleep(25);
    }
  }
  throw new Error(`timed out waiting for ${target}`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for predicate`);
}
