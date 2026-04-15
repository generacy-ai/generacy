import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationSpawner } from '../../conversation/conversation-spawner.js';
import type { AgentLauncher } from '../../launcher/agent-launcher.js';

function makeFakeProcess() {
  return {
    stdin: null,
    stdout: null,
    stderr: null,
    pid: 42,
    kill: vi.fn(),
    exitPromise: Promise.resolve(0),
  };
}

function makeFakeLauncher() {
  const launchMock = vi.fn().mockResolvedValue({
    process: makeFakeProcess(),
    outputParser: undefined,
    metadata: { pluginId: 'test', intentKind: 'conversation-turn' },
  });
  return {
    launch: launchMock,
    registerPlugin: vi.fn(),
  } as unknown as AgentLauncher & { launch: ReturnType<typeof vi.fn> };
}

describe('ConversationSpawner credentials', () => {
  let launcher: ReturnType<typeof makeFakeLauncher>;

  beforeEach(() => {
    launcher = makeFakeLauncher();
  });

  it('should include credentials in launch request when credentialRole is set', async () => {
    const spawner = new ConversationSpawner(launcher, 5000, 'developer');

    await spawner.spawnTurn({
      cwd: '/tmp',
      message: 'Hello',
      skipPermissions: true,
    });

    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          role: 'developer',
          uid: expect.any(Number),
          gid: expect.any(Number),
        }),
      }),
    );
  });

  it('should omit credentials in launch request when credentialRole is undefined', async () => {
    const spawner = new ConversationSpawner(launcher, 5000);

    await spawner.spawnTurn({
      cwd: '/tmp',
      message: 'Hello',
      skipPermissions: true,
    });

    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: undefined,
      }),
    );
  });
});
