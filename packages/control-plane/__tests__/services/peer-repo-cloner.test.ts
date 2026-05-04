import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { setRelayPushEvent } from '../../src/relay-events.js';

// ---------------------------------------------------------------------------
// Mock child_process.spawn — vi.hoisted ensures the variable is available
// when the hoisted vi.mock factory runs.
// ---------------------------------------------------------------------------
class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  exitOk(): void {
    this.emit('close', 0);
  }

  exitFail(stderrMsg: string): void {
    this.stderr.emit('data', Buffer.from(stderrMsg));
    this.emit('close', 1);
  }
}

const { spawnMock } = vi.hoisted(() => {
  const spawnMock = vi.fn();
  return { spawnMock };
});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

// ---------------------------------------------------------------------------
// Mock fs/promises — stat controls idempotency checks
// ---------------------------------------------------------------------------
const { statMock } = vi.hoisted(() => {
  const statMock = vi.fn();
  return { statMock };
});

vi.mock('node:fs/promises', () => ({
  default: {
    stat: (...args: unknown[]) => statMock(...args),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are installed)
// ---------------------------------------------------------------------------
import { clonePeerRepos } from '../../src/services/peer-repo-cloner.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('clonePeerRepos', () => {
  let pushEvents: Array<{ channel: string; payload: unknown }>;
  const workspacesDir = '/tmp/test-workspaces';

  beforeEach(() => {
    pushEvents = [];
    setRelayPushEvent((channel, payload) => {
      pushEvents.push({ channel, payload });
    });

    // Default: stat rejects (directory does not exist)
    statMock.mockRejectedValue(new Error('ENOENT'));

    // Default: spawn returns a process that exits OK on next tick
    spawnMock.mockImplementation(() => {
      const proc = new MockChildProcess();
      process.nextTick(() => proc.exitOk());
      return proc;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Clear the relay push event to avoid leaking between tests
    setRelayPushEvent((() => {}) as any);
  });

  // -------------------------------------------------------------------------
  // Empty repos
  // -------------------------------------------------------------------------
  it('emits "no peer repos" event and returns [] when repos is empty', async () => {
    const results = await clonePeerRepos({ repos: [], workspacesDir });

    expect(results).toEqual([]);
    expect(pushEvents).toHaveLength(1);
    expect(pushEvents[0]).toEqual({
      channel: 'cluster.bootstrap',
      payload: { status: 'done', message: 'no peer repos' },
    });
  });

  // -------------------------------------------------------------------------
  // Successful clone
  // -------------------------------------------------------------------------
  it('clones a repo successfully and emits cloning then done events', async () => {
    const repo = 'https://github.com/org/my-repo.git';

    const results = await clonePeerRepos({ repos: [repo], workspacesDir });

    expect(results).toEqual([{ repo, status: 'done' }]);

    // Verify spawn was called with git clone
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args[0]).toBe('clone');
    expect(args[1]).toBe(repo); // no token, URL unchanged
    expect(args[2]).toBe(`${workspacesDir}/my-repo`);
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);

    // Verify relay events emitted in order
    expect(pushEvents).toHaveLength(2);
    expect(pushEvents[0]).toEqual({
      channel: 'cluster.bootstrap',
      payload: { repo, status: 'cloning' },
    });
    expect(pushEvents[1]).toEqual({
      channel: 'cluster.bootstrap',
      payload: { repo, status: 'done' },
    });
  });

  // -------------------------------------------------------------------------
  // Token-based auth URL
  // -------------------------------------------------------------------------
  it('builds x-access-token auth URL when token is provided', async () => {
    const repo = 'https://github.com/org/private-repo.git';
    const token = 'ghs_faketoken123';

    await clonePeerRepos({ repos: [repo], token, workspacesDir });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const cloneUrl = spawnMock.mock.calls[0][1][1] as string;
    expect(cloneUrl).toContain('x-access-token');
    expect(cloneUrl).toContain(token);
    expect(cloneUrl).toContain('github.com');
    // Verify the URL structure: https://x-access-token:<token>@github.com/...
    const parsed = new URL(cloneUrl);
    expect(parsed.username).toBe('x-access-token');
    expect(parsed.password).toBe(token);
  });

  // -------------------------------------------------------------------------
  // Idempotency: skip existing directory
  // -------------------------------------------------------------------------
  it('skips clone and returns skipped when directory already exists', async () => {
    const repo = 'https://github.com/org/existing-repo.git';

    // stat succeeds and indicates a directory
    statMock.mockResolvedValue({ isDirectory: () => true });

    const results = await clonePeerRepos({ repos: [repo], workspacesDir });

    expect(results).toEqual([{ repo, status: 'skipped' }]);

    // git clone should NOT have been spawned
    expect(spawnMock).not.toHaveBeenCalled();

    // Should emit done (not cloning)
    expect(pushEvents).toHaveLength(1);
    expect(pushEvents[0]).toEqual({
      channel: 'cluster.bootstrap',
      payload: { repo, status: 'done' },
    });
  });

  // -------------------------------------------------------------------------
  // Failed clone
  // -------------------------------------------------------------------------
  it('reports failed clone with error message', async () => {
    const repo = 'https://github.com/org/bad-repo.git';
    const errorMsg = 'fatal: repository not found';

    spawnMock.mockImplementation(() => {
      const proc = new MockChildProcess();
      process.nextTick(() => proc.exitFail(errorMsg));
      return proc;
    });

    const results = await clonePeerRepos({ repos: [repo], workspacesDir });

    expect(results).toEqual([
      { repo, status: 'failed', message: errorMsg },
    ]);

    // Verify relay events: cloning, then failed
    expect(pushEvents).toHaveLength(2);
    expect(pushEvents[0]).toEqual({
      channel: 'cluster.bootstrap',
      payload: { repo, status: 'cloning' },
    });
    expect(pushEvents[1]).toEqual({
      channel: 'cluster.bootstrap',
      payload: { repo, status: 'failed', message: errorMsg },
    });
  });

  // -------------------------------------------------------------------------
  // Multiple repos sequentially
  // -------------------------------------------------------------------------
  it('handles multiple repos sequentially', async () => {
    const repos = [
      'https://github.com/org/repo-a.git',
      'https://github.com/org/repo-b',
      'https://github.com/org/repo-c.git',
    ];

    // repo-b already exists, others don't
    statMock.mockImplementation((targetDir: string) => {
      if (targetDir === `${workspacesDir}/repo-b`) {
        return Promise.resolve({ isDirectory: () => true });
      }
      return Promise.reject(new Error('ENOENT'));
    });

    // repo-c fails
    let callCount = 0;
    spawnMock.mockImplementation(() => {
      callCount++;
      const proc = new MockChildProcess();
      if (callCount === 1) {
        // repo-a succeeds
        process.nextTick(() => proc.exitOk());
      } else {
        // repo-c fails (repo-b was skipped, so this is the 2nd spawn)
        process.nextTick(() => proc.exitFail('permission denied'));
      }
      return proc;
    });

    const results = await clonePeerRepos({ repos, workspacesDir });

    expect(results).toEqual([
      { repo: repos[0], status: 'done' },
      { repo: repos[1], status: 'skipped' },
      { repo: repos[2], status: 'failed', message: 'permission denied' },
    ]);

    // spawn called only twice (repo-b skipped)
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Verify all relay events in order
    expect(pushEvents).toEqual([
      // repo-a
      { channel: 'cluster.bootstrap', payload: { repo: repos[0], status: 'cloning' } },
      { channel: 'cluster.bootstrap', payload: { repo: repos[0], status: 'done' } },
      // repo-b (skipped, emits done)
      { channel: 'cluster.bootstrap', payload: { repo: repos[1], status: 'done' } },
      // repo-c
      { channel: 'cluster.bootstrap', payload: { repo: repos[2], status: 'cloning' } },
      { channel: 'cluster.bootstrap', payload: { repo: repos[2], status: 'failed', message: 'permission denied' } },
    ]);
  });

  // -------------------------------------------------------------------------
  // Repo name extraction (strips .git suffix)
  // -------------------------------------------------------------------------
  it('strips .git suffix when extracting repo name for target directory', async () => {
    const repo = 'https://github.com/org/my-project.git';

    await clonePeerRepos({ repos: [repo], workspacesDir });

    const targetDir = spawnMock.mock.calls[0][1][2] as string;
    expect(targetDir).toBe(`${workspacesDir}/my-project`);
  });

  it('handles repo URL without .git suffix', async () => {
    const repo = 'https://github.com/org/my-project';

    await clonePeerRepos({ repos: [repo], workspacesDir });

    const targetDir = spawnMock.mock.calls[0][1][2] as string;
    expect(targetDir).toBe(`${workspacesDir}/my-project`);
  });
});
