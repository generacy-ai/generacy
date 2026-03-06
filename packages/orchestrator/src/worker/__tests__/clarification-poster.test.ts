import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  parseClarifications,
  formatComment,
  postClarifications,
  hasPendingClarifications,
  clarificationMarker,
} from '../clarification-poster.js';
import type { WorkerContext, Logger } from '../types.js';

// ---------------------------------------------------------------------------
// Mock node:fs
// ---------------------------------------------------------------------------
const mockReaddirSync = vi.fn<(path: string) => string[]>();
const mockReadFileSync = vi.fn<(path: string, encoding: string) => string>();

vi.mock('node:fs', () => ({
  readdirSync: (path: string) => mockReaddirSync(path),
  readFileSync: (path: string, encoding: string) => mockReadFileSync(path, encoding),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createMockLogger(): Logger {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  } as unknown as Logger;
  return logger;
}

function createMockGithub() {
  return {
    addIssueComment: vi.fn().mockResolvedValue({ id: 99, body: '' }),
    getIssueComments: vi.fn().mockResolvedValue([]),
  };
}

function createWorkerContext(overrides: Partial<WorkerContext> = {}): WorkerContext {
  const mockGithub = createMockGithub();
  return {
    workerId: 'test-worker-id',
    item: {
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
      command: 'process',
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
    },
    startPhase: 'specify',
    github: mockGithub as unknown as WorkerContext['github'],
    logger: createMockLogger(),
    signal: new AbortController().signal,
    checkoutPath: '/tmp/test-checkout',
    issueUrl: 'https://github.com/test-owner/test-repo/issues/42',
    description: 'Test issue description',
    ...overrides,
  };
}

// Sample clarifications.md content
const SAMPLE_CLARIFICATIONS = `# Clarification Questions

## Status: Pending

## Questions

### Batch 1 — 2026-03-06

### Q1: Authentication method
**Context**: The spec mentions user auth but doesn't specify OAuth vs JWT.
**Question**: Which authentication method should be used?
**Options**:
- A) OAuth 2.0
- B) JWT tokens
- C) Session-based auth

**Answer**: *Pending*

### Q2: Database choice
**Context**: Multiple databases could work for this use case.
**Question**: Should we use PostgreSQL or MongoDB?

**Answer**: *Pending*

### Q3: Answered question
**Context**: This was already clarified.
**Question**: What color scheme?

**Answer**: Use the existing brand colors
`;

// ---------------------------------------------------------------------------
// T001: parseClarifications tests
// ---------------------------------------------------------------------------
describe('parseClarifications', () => {
  it('parses pending questions correctly', () => {
    const questions = parseClarifications(SAMPLE_CLARIFICATIONS);
    expect(questions).toHaveLength(3);

    expect(questions[0]).toMatchObject({
      number: 1,
      topic: 'Authentication method',
      question: 'Which authentication method should be used?',
      answered: false,
    });
    expect(questions[0]!.context).toContain('user auth');
  });

  it('parses answered questions correctly', () => {
    const questions = parseClarifications(SAMPLE_CLARIFICATIONS);
    const answered = questions.find((q) => q.number === 3);
    expect(answered).toBeDefined();
    expect(answered!.answered).toBe(true);
    expect(answered!.answer).toBe('Use the existing brand colors');
  });

  it('handles empty file', () => {
    const questions = parseClarifications('');
    expect(questions).toHaveLength(0);
  });

  it('handles malformed markdown with no question headers', () => {
    const questions = parseClarifications('# Just a title\n\nSome text without questions.');
    expect(questions).toHaveLength(0);
  });

  it('extracts options', () => {
    const questions = parseClarifications(SAMPLE_CLARIFICATIONS);
    const q1 = questions[0]!;
    expect(q1.options).toBeDefined();
    expect(q1.options).toHaveLength(3);
    expect(q1.options![0]).toEqual({ label: 'A', description: 'OAuth 2.0' });
    expect(q1.options![1]).toEqual({ label: 'B', description: 'JWT tokens' });
    expect(q1.options![2]).toEqual({ label: 'C', description: 'Session-based auth' });
  });

  it('does not include options when none are present', () => {
    const questions = parseClarifications(SAMPLE_CLARIFICATIONS);
    const q2 = questions[1]!;
    expect(q2.options).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T002: formatComment tests
// ---------------------------------------------------------------------------
describe('formatComment', () => {
  it('includes HTML marker for dedup', () => {
    const questions = parseClarifications(SAMPLE_CLARIFICATIONS);
    const comment = formatComment(questions, 42);
    expect(comment).toContain('<!-- generacy-clarifications:42 -->');
  });

  it('formats questions with context and options', () => {
    const questions = parseClarifications(SAMPLE_CLARIFICATIONS);
    const comment = formatComment(questions, 42);
    expect(comment).toContain('### Q1: Authentication method');
    expect(comment).toContain('**Context**: The spec mentions user auth');
    expect(comment).toContain('- A) OAuth 2.0');
  });

  it('includes answering instructions template', () => {
    const questions = parseClarifications(SAMPLE_CLARIFICATIONS);
    const comment = formatComment(questions, 42);
    expect(comment).toContain('Q1: your answer here');
    expect(comment).toContain('Q2: your answer here');
  });

  it('only includes pending questions, not answered ones', () => {
    const questions = parseClarifications(SAMPLE_CLARIFICATIONS);
    const comment = formatComment(questions, 42);
    expect(comment).toContain('Q1:');
    expect(comment).toContain('Q2:');
    expect(comment).not.toContain('### Q3:');
  });

  it('returns empty string when no pending questions', () => {
    const questions = [
      { number: 1, topic: 'Done', context: '', question: 'Done?', answered: true, answer: 'Yes' },
    ];
    const comment = formatComment(questions, 42);
    expect(comment).toBe('');
  });
});

// ---------------------------------------------------------------------------
// T003: postClarifications integration tests
// ---------------------------------------------------------------------------
describe('postClarifications', () => {
  let context: WorkerContext;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createWorkerContext();
    logger = createMockLogger();
  });

  it('posts clarification comment when pending questions exist', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);

    const result = await postClarifications(context, logger);

    expect(result.posted).toBe(true);
    expect(result.pendingCount).toBe(2);
    expect(context.github.addIssueComment).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      42,
      expect.stringContaining('<!-- generacy-clarifications:42 -->'),
    );
  });

  it('skips when existing marker comment found (dedup)', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, body: '<!-- generacy-clarifications:42 --> existing comment' },
    ]);

    const result = await postClarifications(context, logger);

    expect(result.posted).toBe(false);
    expect(result.reason).toBe('already-posted');
    expect(context.github.addIssueComment).not.toHaveBeenCalled();
  });

  it('returns no-op when no pending questions', async () => {
    const allAnswered = `### Q1: Done
**Context**: Answered.
**Question**: Already answered?

**Answer**: Yes, done.
`;
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(allAnswered);

    const result = await postClarifications(context, logger);

    expect(result.posted).toBe(false);
    expect(result.reason).toBe('no-pending-questions');
  });

  it('returns file-not-found when specs dir is missing', async () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = await postClarifications(context, logger);

    expect(result.posted).toBe(false);
    expect(result.reason).toBe('file-not-found');
  });

  it('returns file-not-found when clarifications.md does not exist', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = await postClarifications(context, logger);

    expect(result.posted).toBe(false);
    expect(result.reason).toBe('file-not-found');
  });

  it('returns post-failed when GitHub API errors', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.addIssueComment as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('API rate limit'),
    );

    const result = await postClarifications(context, logger);

    expect(result.posted).toBe(false);
    expect(result.reason).toBe('post-failed');
    expect(result.pendingCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T004: hasPendingClarifications tests
// ---------------------------------------------------------------------------
describe('hasPendingClarifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when pending questions exist', () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);

    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(true);
  });

  it('returns false when all questions are answered', () => {
    const allAnswered = `### Q1: Done
**Context**: Answered.
**Question**: Already answered?

**Answer**: Yes, done.
`;
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(allAnswered);

    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(false);
  });

  it('returns false when specs dir does not exist', () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(false);
  });

  it('returns false when no matching spec directory found', () => {
    mockReaddirSync.mockReturnValue(['99-other-issue']);

    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(false);
  });

  it('returns false when clarifications.md does not exist', () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(false);
  });

  it('returns false for empty clarifications file', () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue('');

    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clarificationMarker
// ---------------------------------------------------------------------------
describe('clarificationMarker', () => {
  it('generates correct marker', () => {
    expect(clarificationMarker(316)).toBe('<!-- generacy-clarifications:316 -->');
  });
});
