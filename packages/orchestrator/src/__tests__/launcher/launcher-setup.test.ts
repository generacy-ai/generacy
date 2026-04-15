import { describe, it, expect, vi } from 'vitest';
import { createAgentLauncher } from '../../launcher/launcher-setup.js';
import type { ProcessFactory } from '../../worker/types.js';
import type { CredhelperClient } from '../../launcher/credhelper-client.js';

function makeFakeFactory(): ProcessFactory {
  return {
    spawn: vi.fn(() => ({
      stdin: null,
      stdout: null,
      stderr: null,
      pid: 1,
      kill: vi.fn(),
      exitPromise: Promise.resolve(0),
    })),
  };
}

describe('createAgentLauncher', () => {
  it('should create an AgentLauncher without credhelperClient when not provided', () => {
    const launcher = createAgentLauncher({
      default: makeFakeFactory(),
      interactive: makeFakeFactory(),
    });
    expect(launcher).toBeDefined();
  });

  it('should create an AgentLauncher with credhelperClient when provided', () => {
    const fakeClient: CredhelperClient = {
      beginSession: vi.fn(),
      endSession: vi.fn(),
    };

    const launcher = createAgentLauncher({
      default: makeFakeFactory(),
      interactive: makeFakeFactory(),
    }, fakeClient);
    expect(launcher).toBeDefined();
  });

  it('should pass credhelperClient to AgentLauncher (credentials interceptor fires)', async () => {
    const fakeClient: CredhelperClient = {
      beginSession: vi.fn().mockResolvedValue({
        sessionDir: '/tmp/session-123',
        expiresAt: new Date(Date.now() + 3600_000),
      }),
      endSession: vi.fn().mockResolvedValue(undefined),
    };

    const fakeFactory = makeFakeFactory();

    const launcher = createAgentLauncher({
      default: fakeFactory,
      interactive: makeFakeFactory(),
    }, fakeClient);

    // Launch with credentials — should trigger the interceptor which calls beginSession
    await launcher.launch({
      intent: { kind: 'shell', command: 'echo hello' } as import('../../launcher/types.js').ShellIntent,
      cwd: '/tmp',
      env: {},
      credentials: { role: 'developer', uid: 1001, gid: 1000 },
    });

    expect(fakeClient.beginSession).toHaveBeenCalledWith('developer', expect.any(String));
  });

  it('should pass undefined when no client provided (no interceptor)', async () => {
    const fakeFactory = makeFakeFactory();

    const launcher = createAgentLauncher({
      default: fakeFactory,
      interactive: makeFakeFactory(),
    });

    // Launch without credentials — should work fine, no interceptor
    const handle = await launcher.launch({
      intent: { kind: 'shell', command: 'echo hello' } as import('../../launcher/types.js').ShellIntent,
      cwd: '/tmp',
      env: {},
    });

    expect(handle.process).toBeDefined();
  });
});
