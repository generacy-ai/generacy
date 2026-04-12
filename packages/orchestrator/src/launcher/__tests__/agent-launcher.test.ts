import { describe, it, expect, vi } from 'vitest';
import { AgentLauncher } from '../agent-launcher.js';
import type {
  AgentLaunchPlugin,
  LaunchRequest,
  LaunchSpec,
  OutputParser,
} from '../types.js';
import type { ProcessFactory, ChildProcessHandle } from '../../worker/types.js';

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

describe('AgentLauncher', () => {
  describe('registerPlugin', () => {
    it('registers a plugin for its supported kinds', () => {
      const factory = createMockFactory();
      const launcher = new AgentLauncher(new Map([['default', factory]]));
      const plugin = createMockPlugin();

      launcher.registerPlugin(plugin);

      // Should be able to launch with the registered kind
      const handle = launcher.launch({
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
    it('throws descriptive error for unknown intent kind', () => {
      const factory = createMockFactory();
      const launcher = new AgentLauncher(new Map([['default', factory]]));

      const plugin = createMockPlugin({ supportedKinds: ['known-a', 'known-b'] });
      launcher.registerPlugin(plugin);

      const request: LaunchRequest = {
        intent: { kind: 'unknown' as any, command: 'x', args: [] },
        cwd: '/tmp',
      };

      expect(() => launcher.launch(request)).toThrow(
        'Unknown intent kind "unknown". Available kinds: known-a, known-b',
      );
    });

    it('throws descriptive error for unknown stdio profile', () => {
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

      expect(() => launcher.launch(request)).toThrow(
        'Unknown stdio profile "nonexistent". Available profiles: default',
      );
    });

    it('merges env with correct precedence: caller > plugin > process.env', () => {
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

      launcher.launch(request);

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

    it('selects correct ProcessFactory by stdioProfile', () => {
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

      launcher.launch({
        intent: { kind: 'test-kind', command: 'echo', args: [] } as any,
        cwd: '/tmp',
      });

      expect(defaultFactory.spawn).not.toHaveBeenCalled();
      expect(interactiveFactory.spawn).toHaveBeenCalledOnce();
    });

    it('defaults to "default" stdio profile when not specified', () => {
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

      launcher.launch({
        intent: { kind: 'test-kind', command: 'echo', args: [] } as any,
        cwd: '/tmp',
      });

      expect(defaultFactory.spawn).toHaveBeenCalledOnce();
    });

    it('propagates AbortSignal to ProcessFactory.spawn()', () => {
      const factory = createMockFactory();
      const launcher = new AgentLauncher(new Map([['default', factory]]));
      const plugin = createMockPlugin();
      launcher.registerPlugin(plugin);

      const abortController = new AbortController();
      launcher.launch({
        intent: { kind: 'test-kind', command: 'echo', args: [] } as any,
        cwd: '/tmp',
        signal: abortController.signal,
      });

      const spawnCall = (factory.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(spawnCall[2].signal).toBe(abortController.signal);
    });

    it('returns LaunchHandle with process, outputParser, and metadata', () => {
      const factory = createMockFactory();
      const launcher = new AgentLauncher(new Map([['default', factory]]));

      const mockParser: OutputParser = { processChunk: vi.fn(), flush: vi.fn() };
      const plugin = createMockPlugin({
        pluginId: 'my-plugin',
        supportedKinds: ['my-kind'],
        createOutputParser: vi.fn().mockReturnValue(mockParser),
      });
      launcher.registerPlugin(plugin);

      const handle = launcher.launch({
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
});
