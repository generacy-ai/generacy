import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { probeControlPlaneSocket } from '../../../src/services/control-plane-probe.js';

describe('probeControlPlaneSocket', () => {
  let tmpDir: string;
  let socketServer: net.Server | null = null;

  function createTmpDir(): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'probe-test-'));
    return tmpDir;
  }

  afterEach(async () => {
    if (socketServer) {
      await new Promise<void>((resolve) => socketServer!.close(() => resolve()));
      socketServer = null;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns true when socket accepts connection', async () => {
    const dir = createTmpDir();
    const socketPath = join(dir, 'test.sock');
    await new Promise<void>((resolve) => {
      socketServer = net.createServer();
      socketServer.listen(socketPath, () => resolve());
    });
    const result = await probeControlPlaneSocket(socketPath, 500);
    expect(result).toBe(true);
  });

  it('returns false when socket file does not exist', async () => {
    const result = await probeControlPlaneSocket('/tmp/nonexistent-probe-test.sock', 500);
    expect(result).toBe(false);
  });

  it('returns false on timeout', async () => {
    const dir = createTmpDir();
    const socketPath = join(dir, 'slow.sock');
    await new Promise<void>((resolve) => {
      socketServer = net.createServer();
      socketServer.listen(socketPath, () => resolve());
    });
    await new Promise<void>((resolve) => {
      socketServer!.close(() => resolve());
      socketServer = null;
    });
    const result = await probeControlPlaneSocket(socketPath, 100);
    expect(result).toBe(false);
  });

  it('returns false on ECONNREFUSED', async () => {
    const dir = createTmpDir();
    const socketPath = join(dir, 'refused.sock');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const result = await probeControlPlaneSocket(socketPath, 500);
    expect(result).toBe(false);
  });
});
