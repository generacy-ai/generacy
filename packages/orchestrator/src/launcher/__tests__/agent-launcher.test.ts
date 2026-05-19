import { describe, it, expect, vi } from 'vitest';
import { AgentLauncher } from '../agent-launcher.js';
import { CredhelperUnavailableError } from '../credhelper-errors.js';
import type { CredhelperClient, BeginSessionResult } from '../credhelper-client.js';
import type {
  AgentLaunchPlugin,
  LaunchRequest,
  LaunchSpec,
  OutputParser,
} from '../types.js';
import type { ProcessFactory } from '../../worker/types.js';

function createMockPlugin(overrides: Partial<AgentLaunchPlugin> = {}): AgentLaunchPlugin {
  return {
    pluginId: 'test-plugin',
    supportedKinds: ['test-kind'],
    buildLaunch: vi.fn<(intent: any) => LaunchSpec>().mockReturnValue({
      command: 'echo',
      args: ['hello'],
      env: { PLUGIN_VAR: 'plugin-value' },
      stdioProfile: 'default',
    }),
    createOutputParser: vi.fn<() => OutputParser>().mockReturnValue({
      processChunk: vi.fn(),
      flush: vi.fn(),
    }),
    ...overrides,
  };
}

function createMockFactory(): ProcessFactory {
  return {
    spawn: vi.fn<ProcessFactory['spawn']>().mockReturnValue({
      stdin: null,
      stdout: null,
      stderr: null,
      pid: 1234,
      kill: vi.fn().mockReturnValue(true),
      exitPromise: Promise.resolve(0),
    }),
  };
}

function createMockCredhelperClient(overrides: Partial<CredhelperClient> = {}): CredhelperClient {
  return {
    beginSession: vi.fn<CredhelperClient['beginSession']>().mockResolvedValue({
      sessionDir: '/run/generacy-credhelper/sessions/test-session',
      expiresAt: new Date('2026-04-13T15:30:00.000Z'),
    }),
    endSession: vi.fn<CredhelperClient['endSession']>().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('AgentLauncher', () => {
  describe('registerPlugin', () => {
    it('registers a plugin for its supported kinds', async () => {
      const factory = createMockFactory();
      const launcher = new AgentLauncher(new Map([['default', factory]]));
      const plugin = createMockPlugin();

      launcher.registerPlugin(plugin);

      // Should be able to launch with the registered kind
      const handle = await launcher.launch({
        intent: { kind: 'test-kind', command: 'echo', args: ['hi'] } as any,
        cwd: '/tmp',
      });
      expect(handle).toBeDefined();
    });

    it('throws on duplicate kind registration', () => {
      const factory = createMockFactory();
      const launcher = new AgentLauncher(new Map([['default', factory]]));

      const plugin1 = createMockPlugin({ pluginId: 'plugin-1', supportedKinds: ['shared-kind'] });
      const plugin2 = createMockPlugin({ pluginId: 'plugin-2', supportedKinds: ['shared-kind'] });

      launcher.registerPlugin(plugin1);

      expect(() => launcher.registerPlugin(plugin2)).toThrow(
        'Intent kind "shared-kind" already registered by plugin "plugin-1"',
      );
    });
  });

  describe('launch', () => {
    it('throws descriptive error for unknown intent kind', async () => {
      const factory = createMockFactory();
      const launcher = new AgentLauncher(new Map([['default', factory]]));

      const plugin = createMockPlugin({ supportedKinds: ['known-a', 'known-b'] });
      launcher.registerPlugin(plugin);

      const request: LaunchRequest = {
        intent: { kind: 'unknown' as any, command: 'x', args: [] },
        cwd: '/tmp',
      };

      await expect(launcher.launch(request)).rejects.toThrow(
        'Unknown intent kind "unknown". Available kinds: known-a, known-b',
      );
    });

    it('throws descriptive error for unknown stdio profile', async () => {
      const factory = createMockFactory();
      const launcher = new AgentLauncher(new Map([['default', factory]]));

      const plugin = createMockPlugin({
        buildLaunch: vi.fn().mockReturnValue({
          command: 'echo',
          args: [],
          stdioProfile: 'nonexistent',
        }),
      });
      launcher.registerPlugin(plugin);

      const request: LaunchRequest = {
        intent: { kind: 'test-kind', command: 'echo', args: [] } as any,
        cwd: '/tmp',
      };

      await expect(launcher.launch(request)).rejects.toThrow(
        'Unknown stdio profile "nonexistent". Available profiles: default',
      );
    });

    it('merges env with correct precedence: caller > plugin > process.env', async () => {
      const factory = createMockFactory();
      const launcher = new AgentLauncher(new Map([['default', factory]]));

      const plugin = createMockPlugin({
        buildLaunch: vi.fn().mockReturnValue({
          command: 'echo',
          args: [],
          env: { SHARED: 'plugin', PLUGIN_ONLY: 'from-plugin' },
          stdioProfile: 'default',
        }),
      });
      launcher.registerPlugin(plugin);

      const request: LaunchRequest = {
        intent: { kind: 'test-kind', command: 'echo', args: [] } as any,
        cwd: '/tmp',
        env: { SHARED: 'caller', CALLER_ONLY: 'from-caller' },
      };

      await launcher.launch(request);

      const spawnCall = (factory.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      const passedEnv = spawnCall[2].env as Record<string, string>;

      // Caller env overrides plugin env
      expect(passedEnv['SHARED']).toBe('caller');
      // Plugin env is present
      expect(passedEnv['PLUGIN_ONLY']).toBe('from-plugin');
      // Caller env is present
      expect(passedEnv['CALLER_ONLY']).toBe('from-caller');
      // process.env is included (PATH should be there)
      expect(passedEnv['PATH']).toBeDefined();
    });

    it('selects correct ProcessFactory by stdioProfile', async () => {
      const defaultFactory = createMockFactory();
      const interactiveFactory = createMockFactory();
      const launcher = new AgentLauncher(
        new Map([
          ['default', defaultFactory],
          ['interactive', interactiveFactory],
        ]),
      );

      const plugin = createMockPlugin({
        buildLaunch: vi.fn().mockReturnValue({
          command: 'echo',
          args: [],
          stdioProfile: 'interactive',
        }),
      });
      launcher.registerPlugin(plugin);

      await launcher.launch({
        intent: { kind: 'test-kind', command: 'echo', args: [] } as any,
        cwd: '/tmp',
      });

      expect(defaultFactory.spawn).not.toHaveBeenCalled();
      expect(interactiveFactory.spawn).toHaveBeenCalledOnce();
    });

    it('defaults to "default" stdio profile when not specified', async () => {
      const defaultFactory = createMockFactory();
      const launcher = new AgentLauncher(new Map([['default', defaultFactory]]));

      const plugin = createMockPlugin({
        buildLaunch: vi.fn().mockReturnValue({
          command: 'echo',
          args: [],
          // No stdioProfile specified
        }),
      });
      launcher.registerPlugin(plugin);

      await launcher.launch({
        intent: { kind: 'test-kind', command: 'echo', args: [] } as any,
        cwd: '/tmp',
      });

      expect(defaultFactory.spawn).toHaveBeenCalledOnce();
    });

    it('propagates AbortSignal to ProcessFactory.spawn()', async () => {
      const factory = createMockFactory();
      const launcher = new AgentLauncher(new Map([['default', factory]]));
      const plugin = createMockPlugin();
      launcher.registerPlugin(plugin);

      const abortController = new AbortController();
      await launcher.launch({
        intent: { kind: 'test-kind', command: 'echo', args: [] } as any,
        cwd: '/tmp',
        signal: abortController.signal,
      });

      const spawnCall = (factory.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(spawnCall[2].signal).toBe(abortController.signal);
    });

    it('returns LaunchHandle with process, outputParser, and metadata', async () => {
      const factory = createMockFactory();
      const launcher = new AgentLauncher(new Map([['default', factory]]));

      const mockParser: OutputParser = { processChunk: vi.fn(), flush: vi.fn() };
      const plugin = createMockPlugin({
        pluginId: 'my-plugin',
        supportedKinds: ['my-kind'],
        createOutputParser: vi.fn().mockReturnValue(mockParser),
      });
      launcher.registerPlugin(plugin);

      const handle = await launcher.launch({
        intent: { kind: 'my-kind', command: 'echo', args: [] } as any,
        cwd: '/tmp',
      });

      expect(handle.process).toBeDefined();
      expect(handle.process.pid).toBe(1234);
      expect(handle.outputParser).toBe(mockParser);
      expect(handle.metadata).toEqual({
        pluginId: 'my-plugin',
        intentKind: 'my-kind',
      });
    });
  });

  describe('launch with credentials', () => {
    it('applies credentials interceptor when request.credentials is set', async () => {
      const factory = createMockFactory();
      const client = createMockCredhelperClient();
      const launcher = new AgentLauncher(new Map([['default', factory]]), client);
      const plugin = createMockPlugin();
      launcher.registerPlugin(plugin);

      await launcher.launch({
        intent: { kind: 'test-kind', command: 'echo', args: [] } as any,
        cwd: '/tmp',
        credentials: { role: 'developer', uid: 1001, gid: 1001 },
      });

      // beginSession was called
      expect(client.beginSession).toHaveBeenCalledOnce();
      const [role] = (client.beginSession as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(role).toBe('developer');

      // spawn was called with wrapped command and uid/gid
      const spawnCall = (factory.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(spawnCall[0]).toBe('sh'); // wrapped command
      expect(spawnCall[1][0]).toBe('-c'); // sh -c
      expect(spawnCall[2].uid).toBe(1001);
      expect(spawnCall[2].gid).toBe(1001);

      // session env vars are merged
      const passedEnv = spawnCall[2].env as Record<string, string>;
      expect(passedEnv['GENERACY_SESSION_DIR']).toBe('/run/generacy-credhelper/sessions/test-session');
      expect(passedEnv['GIT_CONFIG_GLOBAL']).toBe('/run/generacy-credhelper/sessions/test-session/git/config');
      expect(passedEnv['GOOGLE_APPLICATION_CREDENTIALS']).toBe('/run/generacy-credhelper/sessions/test-session/gcp/external-account.json');
      expect(passedEnv['DOCKER_HOST']).toBe('unix:///run/generacy-credhelper/sessions/test-session/docker.sock');
    });

    it('does not call credhelper when credentials are absent', async () => {
      const factory = createMockFactory();
      const client = createMockCredhelperClient();
      const launcher = new AgentLauncher(new Map([['default', factory]]), client);
      const plugin = createMockPlugin();
      launcher.registerPlugin(plugin);

      await launcher.launch({
        intent: { kind: 'test-kind', command: 'echo', args: [] } as any,
        cwd: '/tmp',
        // no credentials
      });

      expect(client.beginSession).not.toHaveBeenCalled();
      expect(client.endSession).not.toHaveBeenCalled();

      // spawn was called with original command (not wrapped)
      const spawnCall = (factory.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(spawnCall[0]).toBe('echo');
    });

    it('throws CredhelperUnavailableError when credentials set but no client provided', async () => {
      const factory = createMockFactory();
      // No credhelperClient passed to constructor
      const launcher = new AgentLauncher(new Map([['default', factory]]));
      const plugin = createMockPlugin();
      launcher.registerPlugin(plugin);

      await expect(
        launcher.launch({
          intent: { kind: 'test-kind', command: 'echo', args: [] } as any,
          cwd: '/tmp',
          credentials: { role: 'developer', uid: 1001, gid: 1001 },
        }),
      ).rejects.toThrow(CredhelperUnavailableError);
    });

    it('registers endSession cleanup on exitPromise', async () => {
      const factory = createMockFactory();
      const client = createMockCredhelperClient();
      const launcher = new AgentLauncher(new Map([['default', factory]]), client);
      const plugin = createMockPlugin();
      launcher.registerPlugin(plugin);

      await launcher.launch({
        intent: { kind: 'test-kind', command: 'echo', args: [] } as any,
        cwd: '/tmp',
        credentials: { role: 'developer', uid: 1001, gid: 1001 },
      });

      // exitPromise resolves with 0 (from mock factory) — wait for microtask
      await new Promise((resolve) => setTimeout(resolve, 10));

      // endSession should have been called after process exit
      expect(client.endSession).toHaveBeenCalledOnce();
    });

    it('returns async LaunchHandle (Promise)', async () => {
      const factory = createMockFactory();
      const launcher = new AgentLauncher(new Map([['default', factory]]));
      const plugin = createMockPlugin();
      launcher.registerPlugin(plugin);

      const result = launcher.launch({
        intent: { kind: 'test-kind', command: 'echo', args: [] } as any,
        cwd: '/tmp',
      });

      // launch() returns a Promise
      expect(result).toBeInstanceOf(Promise);
      const handle = await result;
      expect(handle.process).toBeDefined();
    });
  });
});
