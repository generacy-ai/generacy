import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '../types.js';

// Mock node:child_process — promisify(execFile) calls the callback-based version
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Import the mocked module to control it
import { execFile as rawExecFile } from 'node:child_process';

// Import after mock setup
const { checkSiblingReviews } = await import('../sibling-review-checker.js');

interface LinkedPR {
  repo: string;
  number: number;
  branch: string;
  url: string;
}

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Logger;

function makePR(overrides: Partial<LinkedPR> & { repo: string; url: string }): LinkedPR {
  return {
    number: 1,
    branch: 'feature-branch',
    ...overrides,
  };
}

const mockExecFile = rawExecFile as unknown as ReturnType<typeof vi.fn>;

/** Helper: make next execFile call succeed with given stdout */
function mockGhResult(stdout: string) {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, stdout, '');
    },
  );
}

/** Helper: make next execFile call fail with an error */
function mockGhError(message: string) {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(new Error(message), '', '');
    },
  );
}

describe('checkSiblingReviews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns allApproved: true when all linked PRs are APPROVED', async () => {
    mockGhResult(JSON.stringify({ reviewDecision: 'APPROVED' }));
    mockGhResult(JSON.stringify({ reviewDecision: 'APPROVED' }));

    const linkedPRs: LinkedPR[] = [
      makePR({ repo: 'repo-a', number: 10, url: 'https://github.com/org/repo-a/pull/10' }),
      makePR({ repo: 'repo-b', number: 20, url: 'https://github.com/org/repo-b/pull/20' }),
    ];

    const result = await checkSiblingReviews(linkedPRs, mockLogger);

    expect(result.allApproved).toBe(true);
    expect(result.statuses).toHaveLength(2);
    expect(result.statuses[0]).toEqual({
      repo: 'repo-a', number: 10, reviewDecision: 'APPROVED', approved: true,
    });
    expect(result.statuses[1]).toEqual({
      repo: 'repo-b', number: 20, reviewDecision: 'APPROVED', approved: true,
    });
  });

  it('returns allApproved: false when one PR is not approved', async () => {
    mockGhResult(JSON.stringify({ reviewDecision: 'APPROVED' }));
    mockGhResult(JSON.stringify({ reviewDecision: 'CHANGES_REQUESTED' }));

    const linkedPRs: LinkedPR[] = [
      makePR({ repo: 'repo-a', number: 10, url: 'https://github.com/org/repo-a/pull/10' }),
      makePR({ repo: 'repo-b', number: 20, url: 'https://github.com/org/repo-b/pull/20' }),
    ];

    const result = await checkSiblingReviews(linkedPRs, mockLogger);

    expect(result.allApproved).toBe(false);
    expect(result.statuses[0]!.approved).toBe(true);
    expect(result.statuses[1]!.approved).toBe(false);
    expect(result.statuses[1]!.reviewDecision).toBe('CHANGES_REQUESTED');
  });

  it('returns allApproved: true with empty statuses when linkedPRs is empty', async () => {
    const result = await checkSiblingReviews([], mockLogger);

    expect(result.allApproved).toBe(true);
    expect(result.statuses).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns allApproved: true with empty statuses when linkedPRs is undefined', async () => {
    const result = await checkSiblingReviews(undefined, mockLogger);

    expect(result.allApproved).toBe(true);
    expect(result.statuses).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('treats unparseable PR URL as not approved and logs warning', async () => {
    const linkedPRs: LinkedPR[] = [
      makePR({ repo: 'repo-a', number: 5, url: 'https://gitlab.com/org/repo-a/merge_requests/5' }),
    ];

    const result = await checkSiblingReviews(linkedPRs, mockLogger);

    expect(result.allApproved).toBe(false);
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0]).toEqual({
      repo: 'repo-a', number: 5, reviewDecision: 'UNKNOWN', approved: false,
    });
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { url: 'https://gitlab.com/org/repo-a/merge_requests/5' },
      'Could not parse linked PR URL — skipping',
    );
  });

  it('treats gh pr view failure as not approved', async () => {
    mockGhError('command not found: gh');

    const linkedPRs: LinkedPR[] = [
      makePR({ repo: 'repo-a', number: 10, url: 'https://github.com/org/repo-a/pull/10' }),
    ];

    const result = await checkSiblingReviews(linkedPRs, mockLogger);

    expect(result.allApproved).toBe(false);
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0]).toEqual({
      repo: 'repo-a', number: 10, reviewDecision: 'ERROR', approved: false,
    });
  });

  it('handles empty reviewDecision as not approved', async () => {
    mockGhResult(JSON.stringify({ reviewDecision: '' }));

    const linkedPRs: LinkedPR[] = [
      makePR({ repo: 'repo-a', number: 10, url: 'https://github.com/org/repo-a/pull/10' }),
    ];

    const result = await checkSiblingReviews(linkedPRs, mockLogger);

    expect(result.allApproved).toBe(false);
    expect(result.statuses[0]!.reviewDecision).toBe('');
    expect(result.statuses[0]!.approved).toBe(false);
  });

  it('handles malformed JSON output gracefully', async () => {
    mockGhResult('not valid json');

    const linkedPRs: LinkedPR[] = [
      makePR({ repo: 'repo-a', number: 10, url: 'https://github.com/org/repo-a/pull/10' }),
    ];

    const result = await checkSiblingReviews(linkedPRs, mockLogger);

    expect(result.allApproved).toBe(false);
    expect(result.statuses[0]!.reviewDecision).toBe('');
    expect(result.statuses[0]!.approved).toBe(false);
  });
});
