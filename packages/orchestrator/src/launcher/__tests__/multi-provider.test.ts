import { describe, it, expect, vi } from 'vitest';
import { AgentLauncher } from '../agent-launcher.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';
import {
  DuplicatePluginRegistrationError,
  UnknownProviderError,
} from '../errors.js';
import type {
  AgentLaunchPlugin,
  LaunchIntent,
  LaunchSpec,
  OutputParser,
} from '../types.js';
import type { ProcessFactory } from '../../worker/types.js';

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

function createFakePlugin(
  provider: string,
  kinds: readonly string[],
  overrides: Partial<AgentLaunchPlugin> = {},
): AgentLaunchPlugin {
  return {
    pluginId: `${provider}-fake`,
    provider,
    supportedKinds: kinds,
    buildLaunch: vi.fn<(intent: LaunchIntent) => LaunchSpec>().mockReturnValue({
      command: 'echo',
      args: [provider],
      stdioProfile: 'default',
    }),
    createOutputParser: vi.fn<() => OutputParser>().mockReturnValue({
      processChunk: vi.fn(),
      flush: vi.fn(),
    }),
    ...overrides,
  };
}

describe('AgentLauncher multi-provider dispatch', () => {
  it('routes to the requested provider when multiple plugins claim the same kind', async () => {
    const factory = createMockFactory();
    const launcher = new AgentLauncher(new Map([['default', factory]]));

    const claudePlugin = new ClaudeCodeLaunchPlugin();
    const testAgentPlugin = createFakePlugin('test-agent', ['phase']);

    const claudeBuildSpy = vi.spyOn(claudePlugin, 'buildLaunch');

    launcher.registerPlugin(claudePlugin as unknown as AgentLaunchPlugin);
    launcher.registerPlugin(testAgentPlugin);

    // Route to test-agent
    await launcher.launch({
      intent: {
        kind: 'phase',
        phase: 'plan',
        prompt: 'https://example.com/issues/1',
      },
      cwd: '/tmp',
      provider: 'test-agent',
    });

    expect(testAgentPlugin.buildLaunch).toHaveBeenCalledTimes(1);
    expect(claudeBuildSpy).not.toHaveBeenCalled();

    // Explicit 'claude-code' provider routes to claude
    await launcher.launch({
      intent: {
        kind: 'phase',
        phase: 'plan',
        prompt: 'https://example.com/issues/1',
      },
      cwd: '/tmp',
      provider: 'claude-code',
    });

    expect(claudeBuildSpy).toHaveBeenCalledTimes(1);

    // Omitted provider also routes to claude (DEFAULT_PROVIDER)
    await launcher.launch({
      intent: {
        kind: 'phase',
        phase: 'plan',
        prompt: 'https://example.com/issues/1',
      },
      cwd: '/tmp',
    });

    expect(claudeBuildSpy).toHaveBeenCalledTimes(2);
  });

  it('throws UnknownProviderError with populated availableProviders on missing provider', async () => {
    const factory = createMockFactory();
    const launcher = new AgentLauncher(new Map([['default', factory]]));

    launcher.registerPlugin(new ClaudeCodeLaunchPlugin() as unknown as AgentLaunchPlugin);
    launcher.registerPlugin(createFakePlugin('test-agent', ['phase']));

    let caught: unknown;
    try {
      await launcher.launch({
        intent: {
          kind: 'phase',
          phase: 'plan',
          prompt: 'x',
        },
        cwd: '/tmp',
        provider: 'nonexistent',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UnknownProviderError);
    const err = caught as UnknownProviderError;
    expect(err.provider).toBe('nonexistent');
    expect(err.kind).toBe('phase');
    expect([...err.availableProviders]).toEqual(['claude-code', 'test-agent']);
  });

  it('throws DuplicatePluginRegistrationError when two plugins claim (provider, kind)', () => {
    const factory = createMockFactory();
    const launcher = new AgentLauncher(new Map([['default', factory]]));

    const first = createFakePlugin('test-agent', ['phase'], { pluginId: 'first-fake' });
    const second = createFakePlugin('test-agent', ['phase'], { pluginId: 'second-fake' });

    launcher.registerPlugin(first);

    let caught: unknown;
    try {
      launcher.registerPlugin(second);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DuplicatePluginRegistrationError);
    const err = caught as DuplicatePluginRegistrationError;
    expect(err.provider).toBe('test-agent');
    expect(err.kind).toBe('phase');
    expect(err.existingPluginId).toBe('first-fake');
  });

  it('rejects an empty provider string at registration', () => {
    const factory = createMockFactory();
    const launcher = new AgentLauncher(new Map([['default', factory]]));

    const badPlugin: AgentLaunchPlugin = {
      pluginId: 'bad',
      provider: '',
      supportedKinds: ['phase'],
      buildLaunch: vi.fn(),
      createOutputParser: vi.fn(),
    };

    expect(() => launcher.registerPlugin(badPlugin)).toThrow(
      /must declare a non-empty provider string/,
    );
    expect(() => launcher.registerPlugin(badPlugin)).not.toThrow(
      DuplicatePluginRegistrationError,
    );
  });
});
