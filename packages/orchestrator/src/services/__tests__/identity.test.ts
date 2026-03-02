import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { resolveClusterIdentity, filterByAssignee } from '../identity.js';
import type { FilterableIssue } from '../identity.js';

// ==========================================================================
// Mock: node:child_process
// ==========================================================================

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

let execFileCallback: ExecFileCallback = () => {};
let execFileChildListeners: Record<string, (err: Error) => void> = {};

const mockExecFile = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    mockExecFile(...args);
    // The callback is the last argument
    const cb = args[args.length - 1] as ExecFileCallback;
    execFileCallback = cb;
    // Return a mock child process with .on()
    return {
      on: (event: string, handler: (err: Error) => void) => {
        execFileChildListeners[event] = handler;
      },
    };
  },
}));

// ==========================================================================
// Mock: Logger
// ==========================================================================

interface MockLogger {
  info: Mock;
  warn: Mock;
  debug: Mock;
}

function createMockLogger(): MockLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

// ==========================================================================
// Helpers
// ==========================================================================

function makeIssue(number: number, assignees: string[]): FilterableIssue {
  return { number, assignees };
}

// ==========================================================================
// Tests: resolveClusterIdentity
// ==========================================================================

describe('resolveClusterIdentity', () => {
  let logger: MockLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    execFileChildListeners = {};
    logger = createMockLogger();
  });

  it('returns config username when set (no gh call made)', async () => {
    const result = await resolveClusterIdentity('my-user', logger);

    expect(result).toBe('my-user');
    expect(logger.info).toHaveBeenCalledWith(
      { username: 'my-user', source: 'config' },
      expect.stringContaining('my-user'),
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('falls back to gh api /user when config username not set', async () => {
    const promise = resolveClusterIdentity(undefined, logger);

    // Simulate successful gh api /user response
    execFileCallback(null, 'octocat\n', '');

    const result = await promise;

    expect(result).toBe('octocat');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['api', '/user', '--jq', '.login'],
      { timeout: 10_000 },
      expect.any(Function),
    );
    expect(logger.info).toHaveBeenCalledWith(
      { username: 'octocat', source: 'gh-api' },
      expect.stringContaining('octocat'),
    );
  });

  it('returns undefined when both config and gh api fail', async () => {
    const promise = resolveClusterIdentity(undefined, logger);

    // Simulate gh api failure
    execFileCallback(new Error('command failed'), '', 'some error output');

    const result = await promise;

    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Assignee filtering disabled: no cluster identity configured. All issues will be processed.',
    );
  });

  it('returns undefined when gh api returns empty login', async () => {
    const promise = resolveClusterIdentity(undefined, logger);

    // Simulate empty response
    execFileCallback(null, '  \n', '');

    const result = await promise;

    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Assignee filtering disabled: no cluster identity configured. All issues will be processed.',
    );
  });

  describe('error classification', () => {
    it('logs ENOENT error when gh CLI not found', async () => {
      const promise = resolveClusterIdentity(undefined, logger);

      execFileCallback(new Error('ENOENT'), '', '');

      await promise;

      expect(logger.warn).toHaveBeenCalledWith(
        { error: 'ENOENT' },
        expect.stringContaining('gh CLI not found'),
      );
    });

    it('logs ENOENT from spawn error event', async () => {
      const promise = resolveClusterIdentity(undefined, logger);

      // Simulate spawn error (ENOENT from child.on('error'))
      const spawnError = new Error('spawn gh ENOENT');
      (spawnError as NodeJS.ErrnoException).code = 'ENOENT';
      execFileChildListeners['error']?.(spawnError);

      await promise;

      expect(logger.warn).toHaveBeenCalledWith(
        { error: expect.stringContaining('ENOENT') },
        expect.stringContaining('gh CLI not found'),
      );
    });

    it('logs auth error when gh CLI not authenticated', async () => {
      const promise = resolveClusterIdentity(undefined, logger);

      execFileCallback(
        new Error('HTTP 401'),
        '',
        'HTTP 401: Bad credentials',
      );

      await promise;

      expect(logger.warn).toHaveBeenCalledWith(
        { error: expect.stringContaining('401') },
        expect.stringContaining('not authenticated'),
      );
    });

    it('logs auth error for login-related failures', async () => {
      const promise = resolveClusterIdentity(undefined, logger);

      execFileCallback(new Error('not logged in'), '', 'auth login required');

      await promise;

      expect(logger.warn).toHaveBeenCalledWith(
        { error: expect.stringContaining('login') },
        expect.stringContaining('not authenticated'),
      );
    });

    it('logs timeout error when gh api times out', async () => {
      const promise = resolveClusterIdentity(undefined, logger);

      execFileCallback(new Error('TIMEOUT'), '', '');

      await promise;

      expect(logger.warn).toHaveBeenCalledWith(
        { error: expect.stringContaining('TIMEOUT') },
        expect.stringContaining('timed out'),
      );
    });

    it('logs generic error for unknown failures', async () => {
      const promise = resolveClusterIdentity(undefined, logger);

      execFileCallback(
        new Error('unexpected'),
        '',
        'something went wrong',
      );

      await promise;

      expect(logger.warn).toHaveBeenCalledWith(
        { error: 'something went wrong' },
        expect.stringContaining('Failed to resolve cluster identity'),
      );
    });
  });

  it('prefers stderr message over error.message when both present', async () => {
    const promise = resolveClusterIdentity(undefined, logger);

    execFileCallback(
      new Error('generic error'),
      '',
      'detailed stderr message',
    );

    await promise;

    expect(logger.warn).toHaveBeenCalledWith(
      { error: 'detailed stderr message' },
      expect.any(String),
    );
  });

  it('uses error.message when stderr is empty', async () => {
    const promise = resolveClusterIdentity(undefined, logger);

    execFileCallback(new Error('the error message'), '', '');

    await promise;

    expect(logger.warn).toHaveBeenCalledWith(
      { error: 'the error message' },
      expect.any(String),
    );
  });
});

// ==========================================================================
// Tests: filterByAssignee
// ==========================================================================

describe('filterByAssignee', () => {
  let logger: MockLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
  });

  it('returns all issues when clusterGithubUsername is undefined (backward compat)', () => {
    const issues = [
      makeIssue(1, ['alice']),
      makeIssue(2, ['bob']),
      makeIssue(3, []),
    ];

    const result = filterByAssignee(issues, undefined, logger);

    expect(result).toEqual(issues);
    expect(result).toHaveLength(3);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('returns only issues assigned to the specified username', () => {
    const issues = [
      makeIssue(1, ['alice']),
      makeIssue(2, ['bob']),
      makeIssue(3, ['alice', 'bob']),
    ];

    const result = filterByAssignee(issues, 'alice', logger);

    expect(result).toHaveLength(2);
    expect(result.map(i => i.number)).toEqual([1, 3]);
  });

  it('returns empty array when no issues match', () => {
    const issues = [
      makeIssue(1, ['alice']),
      makeIssue(2, ['bob']),
    ];

    const result = filterByAssignee(issues, 'charlie', logger);

    expect(result).toHaveLength(0);
  });

  it('skips unassigned issues (no assignees) with warn log', () => {
    const issues = [
      makeIssue(10, []),
      makeIssue(11, ['alice']),
    ];

    const result = filterByAssignee(issues, 'alice', logger);

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(11);
    expect(logger.warn).toHaveBeenCalledWith(
      { issueNumber: 10 },
      'Skipping issue: no assignees set (assign before labeling)',
    );
  });

  it('warns on multiple assignees but still includes the issue', () => {
    const issues = [
      makeIssue(20, ['alice', 'bob', 'charlie']),
    ];

    const result = filterByAssignee(issues, 'alice', logger);

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(20);
    expect(logger.warn).toHaveBeenCalledWith(
      { issueNumber: 20, assignees: ['alice', 'bob', 'charlie'] },
      'Issue has multiple assignees — may be processed by multiple clusters',
    );
  });

  it('does not warn for single-assignee issues', () => {
    const issues = [makeIssue(30, ['alice'])];

    filterByAssignee(issues, 'alice', logger);

    // warn should not have been called (no multiple assignees, no unassigned)
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs skipped issues at debug level with issue number and assignees', () => {
    const issues = [
      makeIssue(40, ['bob']),
      makeIssue(41, ['charlie', 'dave']),
    ];

    filterByAssignee(issues, 'alice', logger);

    expect(logger.debug).toHaveBeenCalledWith(
      { issueNumber: 40, assignees: ['bob'], clusterUsername: 'alice' },
      'Skipping issue: not assigned to this cluster',
    );
    expect(logger.debug).toHaveBeenCalledWith(
      { issueNumber: 41, assignees: ['charlie', 'dave'], clusterUsername: 'alice' },
      'Skipping issue: not assigned to this cluster',
    );
  });

  it('handles empty issues array', () => {
    const result = filterByAssignee([], 'alice', logger);

    expect(result).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('works when logger.debug is not available', () => {
    const loggerWithoutDebug = {
      info: vi.fn(),
      warn: vi.fn(),
      // debug intentionally omitted
    };

    const issues = [
      makeIssue(50, ['bob']),
      makeIssue(51, ['alice']),
    ];

    const result = filterByAssignee(issues, 'alice', loggerWithoutDebug);

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(51);
    // Should not throw when debug is missing
  });

  it('preserves original issue type (generic constraint)', () => {
    interface ExtendedIssue extends FilterableIssue {
      title: string;
      labels: string[];
    }

    const issues: ExtendedIssue[] = [
      { number: 60, assignees: ['alice'], title: 'Fix bug', labels: ['bug'] },
      { number: 61, assignees: ['bob'], title: 'Add feature', labels: ['feature'] },
    ];

    const result = filterByAssignee(issues, 'alice', logger);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Fix bug');
    expect(result[0].labels).toEqual(['bug']);
  });

  it('handles multiple unassigned issues with individual warnings', () => {
    const issues = [
      makeIssue(70, []),
      makeIssue(71, []),
      makeIssue(72, ['alice']),
    ];

    const result = filterByAssignee(issues, 'alice', logger);

    expect(result).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      { issueNumber: 70 },
      expect.stringContaining('no assignees'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { issueNumber: 71 },
      expect.stringContaining('no assignees'),
    );
  });
});
