import { describe, it, expect } from 'vitest';
import { CliSpawner } from '../cli-spawner.js';
import type { Logger, CliSpawnOptions } from '../types.js';
import type { OutputCapture } from '../output-capture.js';
import { RecordingProcessFactory, normalizeSpawnRecords } from '../../test-utils/index.js';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Snapshot tests
// ---------------------------------------------------------------------------
describe('CliSpawner.spawnPhase — spawn snapshots', () => {
  it('captures basic spawnPhase without session resume', async () => {
    const factory = new RecordingProcessFactory();
    const spawner = new CliSpawner(factory, noopLogger);

    const options: CliSpawnOptions = {
      prompt: 'https://github.com/org/repo/issues/42',
      cwd: '/workspace/repo',
      env: { CLAUDE_CODE_MAX_TURNS: '50', PATH: '/usr/bin' },
      timeoutMs: 60_000,
      signal: new AbortController().signal,
    };

    await spawner.spawnPhase('implement', options, mockCapture());

    expect(normalizeSpawnRecords(factory.calls)).toMatchSnapshot();
  });

  it('captures spawnPhase with resumeSessionId', async () => {
    const factory = new RecordingProcessFactory();
    const spawner = new CliSpawner(factory, noopLogger);

    const options: CliSpawnOptions = {
      prompt: 'https://github.com/org/repo/issues/42',
      cwd: '/workspace/repo',
      env: { CLAUDE_CODE_MAX_TURNS: '50', PATH: '/usr/bin' },
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      resumeSessionId: 'ses-abc-123',
    };

    await spawner.spawnPhase('plan', options, mockCapture());

    expect(normalizeSpawnRecords(factory.calls)).toMatchSnapshot();
  });
});
