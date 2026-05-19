import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { probeControlPlaneSocket } from '../../../src/services/control-plane-probe.js';

describe('orchestrator control-plane startup detection', () => {
  let tmpDir: string;
  let socketServer: net.Server | null = null;

  function createTmpDir(): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'startup-test-'));
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

  it('detects control-plane socket appearing after delay', async () => {
    const dir = createTmpDir();
    const socketPath = join(dir, 'control.sock');

    // Socket doesn't exist yet
    let result = await probeControlPlaneSocket(socketPath, 200);
    expect(result).toBe(false);

    // Simulate daemon starting after a delay
    await new Promise<void>((resolve) => {
      socketServer = net.createServer();
      socketServer.listen(socketPath, () => resolve());
    });

    result = await probeControlPlaneSocket(socketPath, 200);
    expect(result).toBe(true);
  });

  it('reports false when socket never appears (simulates timeout path)', async () => {
    const dir = createTmpDir();
    const socketPath = join(dir, 'never-exists.sock');

    const result = await probeControlPlaneSocket(socketPath, 200);
    expect(result).toBe(false);
  });

  it('health endpoint would include controlPlaneReady: false when socket missing', async () => {
    // This tests the probe function behavior that feeds the health endpoint
    const result = await probeControlPlaneSocket('/tmp/nonexistent-control-plane-test.sock', 200);
    expect(result).toBe(false);
  });

  it('simulates the startup poll loop pattern', async () => {
    const dir = createTmpDir();
    const socketPath = join(dir, 'poll-test.sock');
    const maxAttempts = 3;
    let found = false;

    // Start server after 200ms (2nd poll iteration should find it)
    setTimeout(() => {
      socketServer = net.createServer();
      socketServer.listen(socketPath);
    }, 150);

    for (let i = 0; i < maxAttempts; i++) {
      found = await probeControlPlaneSocket(socketPath, 200);
      if (found) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(found).toBe(true);
  });
});
