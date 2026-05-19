import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Registry } from '../../cluster/registry.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../cluster/registry.js', () => ({
  readRegistry: vi.fn(() => []),
}));

vi.mock('../../../utils/exec.js', () => ({
  execSafe: vi.fn(() => ({ ok: false, stdout: '', stderr: '' })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { readRegistry } from '../../cluster/registry.js';
import { execSafe } from '../../../utils/exec.js';
import { statusCommand } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = '2026-04-29T00:00:00.000Z';

function makeEntry(overrides: Partial<Registry[0]> = {}): Registry[0] {
  return {
    clusterId: 'cls-1',
    name: 'my-app',
    path: '/projects/my-app',
    composePath: '/projects/my-app/.generacy/docker-compose.yml',
    variant: 'standard',
    channel: 'stable',
    cloudUrl: null,
    lastSeen: now,
    createdAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('statusCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('outputs table format by default', async () => {
    vi.mocked(readRegistry).mockReturnValue([makeEntry()]);
    vi.mocked(execSafe).mockReturnValue({ ok: false, stdout: '', stderr: '' });

    await statusCommand().parseAsync(['status'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0]![0] as string;
    // Table output contains the header
    expect(output).toContain('Name');
    expect(output).toContain('Cluster ID');
    // Not valid JSON
    expect(() => JSON.parse(output)).toThrow();
  });

  it('outputs JSON format with --json flag', async () => {
    vi.mocked(readRegistry).mockReturnValue([makeEntry()]);
    vi.mocked(execSafe).mockReturnValue({ ok: false, stdout: '', stderr: '' });

    await statusCommand().parseAsync(['status', '--json'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe('my-app');
  });

  it('handles empty registry', async () => {
    vi.mocked(readRegistry).mockReturnValue([]);

    await statusCommand().parseAsync(['status'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0]![0] as string;
    expect(output).toBe('No clusters registered.');
  });
});
