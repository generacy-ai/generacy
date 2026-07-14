import { describe, it, expect } from 'vitest';
import { CliSpawner } from '../cli-spawner.js';
import type { Logger, CliSpawnOptions } from '../types.js';
import type { OutputCapture } from '../output-capture.js';
import { RecordingProcessFactory, normalizeSpawnRecords } from '../../test-utils/index.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

/**
 * Argv snapshots per plan.md Acceptance Gate #2 & #3.
 *
 * Two load-bearing cases:
 *   (a) Fixture config with `phases.implement.model='sonnet-4-6'` produces
 *       `--model sonnet-4-6` at the correct position — immediately after
 *       `--verbose`, before `--resume` and the prompt payload.
 *   (b) No-config parity — `--model` absent when the `agents` block is unset
 *       everywhere; byte-identical to the pre-change baseline.
 */

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as unknown as Logger;

function mockCapture(): OutputCapture {
  return {
    processChunk: () => {},
    flush: () => {},
    getOutput: () => [],
    clear: () => {},
  } as unknown as OutputCapture;
}

describe('CliSpawner.spawnPhase — --model argv snapshots', () => {
  it('(a) pushes --model at the correct position when options.model is set', async () => {
    const factory = new RecordingProcessFactory();
    const launcher = new AgentLauncher(new Map([['default', factory]]));
    launcher.registerPlugin(new ClaudeCodeLaunchPlugin());
    const spawner = new CliSpawner(launcher, noopLogger);

    const options: CliSpawnOptions = {
      prompt: 'https://github.com/org/repo/issues/42',
      cwd: '/workspace/repo',
      env: { CLAUDE_CODE_MAX_TURNS: '50', PATH: '/usr/bin' },
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      provider: 'claude-code',
      model: 'sonnet-4-6',
    };

    await spawner.spawnPhase('implement', options, mockCapture());

    expect(normalizeSpawnRecords(factory.calls)).toMatchSnapshot();
  });

  it('(a-bis) --model precedes --resume when resumeSessionId is also set', async () => {
    const factory = new RecordingProcessFactory();
    const launcher = new AgentLauncher(new Map([['default', factory]]));
    launcher.registerPlugin(new ClaudeCodeLaunchPlugin());
    const spawner = new CliSpawner(launcher, noopLogger);

    const options: CliSpawnOptions = {
      prompt: 'https://github.com/org/repo/issues/42',
      cwd: '/workspace/repo',
      env: { CLAUDE_CODE_MAX_TURNS: '50', PATH: '/usr/bin' },
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      resumeSessionId: 'ses-abc-123',
      provider: 'claude-code',
      model: 'opus-4-7',
    };

    await spawner.spawnPhase('plan', options, mockCapture());

    expect(normalizeSpawnRecords(factory.calls)).toMatchSnapshot();
  });

  it('(b) no-config parity — --model absent when options.model is undefined', async () => {
    const factory = new RecordingProcessFactory();
    const launcher = new AgentLauncher(new Map([['default', factory]]));
    launcher.registerPlugin(new ClaudeCodeLaunchPlugin());
    const spawner = new CliSpawner(launcher, noopLogger);

    // NO provider / NO model — the unconfigured baseline.
    const options: CliSpawnOptions = {
      prompt: 'https://github.com/org/repo/issues/42',
      cwd: '/workspace/repo',
      env: { CLAUDE_CODE_MAX_TURNS: '50', PATH: '/usr/bin' },
      timeoutMs: 60_000,
      signal: new AbortController().signal,
    };

    await spawner.spawnPhase('implement', options, mockCapture());

    const records = normalizeSpawnRecords(factory.calls);
    expect(records).toMatchSnapshot();
    // Explicit assertion so the parity invariant is greppable, not just snapshot-hidden.
    for (const call of factory.calls) {
      expect(call.args).not.toContain('--model');
    }
  });
});
