/**
 * Integration tests for ClaudeCodePlugin.
 *
 * These tests require Docker to be available on the host system.
 * They can be skipped in CI environments without Docker access
 * by setting SKIP_DOCKER_TESTS=true.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Logger } from 'pino';
import Docker from 'dockerode';
import { ClaudeCodePlugin } from '../../src/plugin/claude-code-plugin.js';
import type { ContainerConfig } from '../../src/types.js';

// Skip tests if Docker is not available or SKIP_DOCKER_TESTS is set
const skipDockerTests = process.env.SKIP_DOCKER_TESTS === 'true';

// Check if Docker is available
async function isDockerAvailable(): Promise<boolean> {
  try {
    const docker = new Docker();
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

// Create a mock logger for tests
const createMockLogger = (): Logger =>
  ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }) as unknown as Logger;

// Test configuration
const TEST_IMAGE = 'alpine:latest';
const TEST_CONFIG: ContainerConfig = {
  image: TEST_IMAGE,
  workdir: '/workspace',
  env: { TEST_VAR: 'test-value' },
  mounts: [],
  network: 'bridge',
};

describe.skipIf(skipDockerTests)('ClaudeCodePlugin Integration Tests', () => {
  let plugin: ClaudeCodePlugin;
  let dockerAvailable: boolean;

  beforeAll(async () => {
    dockerAvailable = await isDockerAvailable();

    if (dockerAvailable) {
      // Pull test image
      const docker = new Docker();
      try {
        await new Promise<void>((resolve, reject) => {
          docker.pull(TEST_IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
            if (err) {
              reject(err);
              return;
            }
            docker.modem.followProgress(stream, (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
        });
      } catch {
        // Image might already exist
      }

      plugin = new ClaudeCodePlugin({
        logger: createMockLogger(),
        defaultContainerConfig: TEST_CONFIG,
      });
    }
  });

  afterAll(async () => {
    if (plugin) {
      await plugin.dispose();
    }
  });

  describe.skipIf(!dockerAvailable)('with Docker', () => {
    describe('startSession', () => {
      it('should start a session and create container', async () => {
        const session = await plugin.startSession(TEST_CONFIG);

        expect(session.id).toBeDefined();
        expect(session.status).toBe('running');

        await plugin.endSession(session.id);
      });

      it('should handle invalid container config', async () => {
        const invalidConfig = {
          ...TEST_CONFIG,
          image: 'nonexistent-image:never',
        };

        await expect(plugin.startSession(invalidConfig)).rejects.toThrow();
      });
    });

    describe('session lifecycle', () => {
      it('should manage session state transitions', async () => {
        const session = await plugin.startSession(TEST_CONFIG);

        expect(session.status).toBe('running');
        expect(plugin.hasSession(session.id)).toBe(true);

        await plugin.endSession(session.id);

        expect(plugin.hasSession(session.id)).toBe(false);
      });

      it('should cleanup multiple sessions', async () => {
        const session1 = await plugin.startSession(TEST_CONFIG);
        const session2 = await plugin.startSession(TEST_CONFIG);

        expect(plugin.getSessionCount().active).toBe(2);

        await plugin.endSession(session1.id);
        await plugin.endSession(session2.id);

        expect(plugin.getSessionCount().active).toBe(0);
      });
    });

    describe('dispose', () => {
      it('should cleanup all resources on dispose', async () => {
        const tempPlugin = new ClaudeCodePlugin({
          logger: createMockLogger(),
          defaultContainerConfig: TEST_CONFIG,
        });

        await tempPlugin.startSession(TEST_CONFIG);
        await tempPlugin.startSession(TEST_CONFIG);

        expect(tempPlugin.getSessionCount().active).toBe(2);

        await tempPlugin.dispose();

        expect(tempPlugin.isDisposed()).toBe(true);
      });

      it('should reject operations after dispose', async () => {
        const tempPlugin = new ClaudeCodePlugin({
          logger: createMockLogger(),
          defaultContainerConfig: TEST_CONFIG,
        });

        await tempPlugin.dispose();

        await expect(tempPlugin.startSession(TEST_CONFIG)).rejects.toThrow(
          'Plugin has been disposed'
        );
      });
    });
  });
});

describe('ClaudeCodePlugin Unit Tests (No Docker)', () => {
  it('should create plugin instance', () => {
    const plugin = new ClaudeCodePlugin({
      logger: createMockLogger(),
    });

    expect(plugin).toBeDefined();
    expect(plugin.isPluginDisposed()).toBe(false);
  });

  it('should accept custom docker options', () => {
    const plugin = new ClaudeCodePlugin({
      docker: { socketPath: '/var/run/docker.sock' },
      logger: createMockLogger(),
    });

    expect(plugin).toBeDefined();
  });

  it('should accept default options', () => {
    const plugin = new ClaudeCodePlugin({
      logger: createMockLogger(),
      sessionTimeoutMs: 60000,
      maxSessions: 5,
      defaultInvokeOptions: {
        timeout: 30000,
        mode: 'test',
      },
    });

    expect(plugin).toBeDefined();
  });

  it('should track session counts', async () => {
    const plugin = new ClaudeCodePlugin({
      logger: createMockLogger(),
    });

    expect(plugin.getSessionCount()).toEqual({ active: 0, total: 0 });
  });

  it('should list sessions', () => {
    const plugin = new ClaudeCodePlugin({
      logger: createMockLogger(),
    });

    expect(plugin.listSessions()).toEqual([]);
  });
});
