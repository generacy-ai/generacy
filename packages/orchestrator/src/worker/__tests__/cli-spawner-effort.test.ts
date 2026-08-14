/**
 * #1096 review Finding 5 — CliSpawner effort threading and spawn-time
 * `agent.effort.dropped` warning coverage.
 *
 * Pins two invariants that no other test currently locks down:
 *   1. `options.effort` flows onto the outbound `PhaseIntent.effort` (and
 *      thus onto `--effort <level>` argv) when set.
 *   2. `spawnPhase` emits exactly one `agent.effort.dropped` `warn` line
 *      when `effort` is set but the resolved provider has no CLI mechanism
 *      for delivering it, and emits no such warning otherwise.
 *
 * A refactor dropping the conditional spread in `PhaseIntent` construction
 * or removing the `warnIfEffortDropped` call at spawn time would fail these
 * tests. Sibling coverage exists CLI-side (packages/generacy warnings.test),
 * but nothing was pinning the spawn-time surface until #1096.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CliSpawner } from '../cli-spawner.js';
import type {
  ProcessFactory,
  ChildProcessHandle,
  Logger,
  CliSpawnOptions,
} from '../types.js';
import type { OutputCapture } from '../output-capture.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

function createMockProcess(exitCode = 0, exitDelay = 5) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let resolveExit: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((r) => { resolveExit = r; });
  const handle: ChildProcessHandle = {
    stdin: null,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 12345,
    kill: vi.fn((sig?: string) => {
      if (sig === 'SIGTERM' || sig === 'SIGKILL') resolveExit(exitCode);
      return true;
    }),
    exitPromise,
  };
  if (exitDelay >= 0) setTimeout(() => resolveExit(exitCode), exitDelay);
  return handle;
}

function createMockCapture(): OutputCapture {
  return {
    processChunk: () => undefined,
    flush: () => undefined,
    getOutput: () => [],
    clear: () => undefined,
  } as unknown as OutputCapture;
}

function makeLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();
  const logger = { info, warn, error, debug, child: () => logger } as unknown as Logger;
  return { logger, spies: { info, warn, error, debug } };
}

function defaultOptions(overrides: Partial<CliSpawnOptions> = {}): CliSpawnOptions {
  return {
    prompt: 'https://github.com/org/repo/issues/1',
    cwd: '/tmp/repo',
    env: { PATH: '/usr/bin' },
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('CliSpawner — effort threading + agent.effort.dropped warning (#1096 Finding 5)', () => {
  beforeEach(() => {
    // Reset the plugin's cached probe so per-test overrides take effect.
    ClaudeCodeLaunchPlugin._setHasEffortMechanismForTests(undefined);
  });

  it('threads options.effort → PhaseIntent.effort → argv --effort <level>', async () => {
    // Force the plugin to report support so no warning fires and the flag
    // gets appended.
    ClaudeCodeLaunchPlugin._setHasEffortMechanismForTests(true);
    const spawnFn = vi.fn().mockReturnValue(createMockProcess(0, 5));
    const factory: ProcessFactory = { spawn: spawnFn } as unknown as ProcessFactory;
    const launcher = new AgentLauncher(new Map([['default', factory]]));
    launcher.registerPlugin(new ClaudeCodeLaunchPlugin());
    const { logger, spies } = makeLogger();
    const spawner = new CliSpawner(launcher, logger, 50);

    await spawner.spawnPhase(
      'implement',
      defaultOptions({ provider: 'claude-code', effort: 'high' }),
      createMockCapture(),
    );

    const spawnArgs = spawnFn.mock.calls[0]![1] as string[];
    const effortIndex = spawnArgs.indexOf('--effort');
    expect(effortIndex).toBeGreaterThan(-1);
    expect(spawnArgs[effortIndex + 1]).toBe('high');

    // No drop warning should be emitted when the mechanism is present.
    const dropCalls = spies.warn.mock.calls.filter(
      (c) => (c[1] as string) === 'agent.effort.dropped',
    );
    expect(dropCalls.length).toBe(0);
  });

  it('omits --effort when options.effort is undefined (no warning either)', async () => {
    ClaudeCodeLaunchPlugin._setHasEffortMechanismForTests(true);
    const spawnFn = vi.fn().mockReturnValue(createMockProcess(0, 5));
    const factory: ProcessFactory = { spawn: spawnFn } as unknown as ProcessFactory;
    const launcher = new AgentLauncher(new Map([['default', factory]]));
    launcher.registerPlugin(new ClaudeCodeLaunchPlugin());
    const { logger, spies } = makeLogger();
    const spawner = new CliSpawner(launcher, logger, 50);

    await spawner.spawnPhase(
      'implement',
      defaultOptions({ provider: 'claude-code' }),
      createMockCapture(),
    );

    const spawnArgs = spawnFn.mock.calls[0]![1] as string[];
    expect(spawnArgs).not.toContain('--effort');
    const dropCalls = spies.warn.mock.calls.filter(
      (c) => (c[1] as string) === 'agent.effort.dropped',
    );
    expect(dropCalls.length).toBe(0);
  });

  it('emits exactly one agent.effort.dropped warn when the provider has no CLI mechanism', async () => {
    // Force the plugin to report NO effort mechanism — mimics a container CLI
    // that predates or has removed `--effort`. Under this state we must emit
    // the warning; whether the flag is still appended is orthogonal to what
    // this test pins (it verifies the warning surface, not the argv).
    ClaudeCodeLaunchPlugin._setHasEffortMechanismForTests(false);
    const spawnFn = vi.fn().mockReturnValue(createMockProcess(0, 5));
    const factory: ProcessFactory = { spawn: spawnFn } as unknown as ProcessFactory;
    const launcher = new AgentLauncher(new Map([['default', factory]]));
    launcher.registerPlugin(new ClaudeCodeLaunchPlugin());
    const { logger, spies } = makeLogger();
    const spawner = new CliSpawner(launcher, logger, 50);

    await spawner.spawnPhase(
      'implement',
      defaultOptions({ provider: 'claude-code', effort: 'high' }),
      createMockCapture(),
    );

    const dropCalls = spies.warn.mock.calls.filter(
      (c) => (c[1] as string) === 'agent.effort.dropped',
    );
    expect(dropCalls.length).toBe(1);
    const payload = dropCalls[0]![0] as Record<string, unknown>;
    expect(payload.provider).toBe('claude-code');
    expect(payload.effort).toBe('high');
    expect(payload.reason).toBe('no-cli-mechanism');
    expect(payload.phase).toBe('implement');
  });

  it('emits agent.effort.dropped warn for an unknown provider (probe misses)', async () => {
    const spawnFn = vi.fn().mockReturnValue(createMockProcess(0, 5));
    const factory: ProcessFactory = { spawn: spawnFn } as unknown as ProcessFactory;
    const launcher = new AgentLauncher(new Map([['default', factory]]));
    launcher.registerPlugin(new ClaudeCodeLaunchPlugin());
    const { logger, spies } = makeLogger();
    const spawner = new CliSpawner(launcher, logger, 50);

    // No probe entry for `stub-provider` → warning fires regardless of the
    // Claude plugin's cached probe result.
    await spawner.spawnPhase(
      'implement',
      defaultOptions({ provider: 'stub-provider', effort: 'medium' }),
      createMockCapture(),
    ).catch(() => undefined);

    const dropCalls = spies.warn.mock.calls.filter(
      (c) => (c[1] as string) === 'agent.effort.dropped',
    );
    expect(dropCalls.length).toBe(1);
    const payload = dropCalls[0]![0] as Record<string, unknown>;
    expect(payload.provider).toBe('stub-provider');
    expect(payload.effort).toBe('medium');
  });
});
