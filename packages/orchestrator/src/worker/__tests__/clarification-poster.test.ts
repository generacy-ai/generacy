import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  parseClarifications,
  formatComment,
  postClarifications,
  hasPendingClarifications,
  clarificationMarker,
  integrateClarificationAnswers,
  isQuestionComment,
} from '../clarification-poster.js';
import type { WorkerContext, Logger } from '../types.js';

// ---------------------------------------------------------------------------
// Mock node:fs
// ---------------------------------------------------------------------------
const mockReaddirSync = vi.fn<(path: string) => string[]>();
const mockReadFileSync = vi.fn<(path: string, encoding: string) => string>();
const mockWriteFileSync = vi.fn<(path: string, content: string) => void>();

vi.mock('node:fs', () => ({
  readdirSync: (path: string) => mockReaddirSync(path),
  readFileSync: (path: string, encoding: string) => mockReadFileSync(path, encoding),
  writeFileSync: (path: string, content: string) => mockWriteFileSync(path, content),
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

  it('skips when Claude CLI clarify phase already posted (cross-marker dedup)', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 2, body: '<!-- generacy-clarification:batch-1 -->\n## Clarification Questions' },
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

  it('posts clarification comment with zero-padded spec directory', async () => {
    mockReaddirSync.mockReturnValue(['008-fix-something']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);

    const ctx = createWorkerContext({
      item: {
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 8,
        workflowName: 'speckit-bugfix',
        command: 'process',
        priority: Date.now(),
        enqueuedAt: new Date().toISOString(),
      },
    });

    const result = await postClarifications(ctx, logger);

    expect(result.posted).toBe(true);
    expect(result.pendingCount).toBe(2);
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

  it('matches zero-padded spec directory names', () => {
    mockReaddirSync.mockReturnValue(['042-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);

    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(true);
  });

  it('matches triple-zero-padded spec directory for single-digit issue', () => {
    mockReaddirSync.mockReturnValue(['008-fix-something']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);

    expect(hasPendingClarifications('/tmp/checkout', 8)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T005: integrateClarificationAnswers tests
// ---------------------------------------------------------------------------
describe('integrateClarificationAnswers', () => {
  let context: WorkerContext;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createWorkerContext();
    logger = createMockLogger();
  });

  it('integrates answers from GitHub comments into clarifications.md', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, body: 'Q1: A\nQ2: Use PostgreSQL', author: 'user', created_at: '', updated_at: '' },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(2);
    expect(result.reason).toBeUndefined();
    expect(mockWriteFileSync).toHaveBeenCalledOnce();

    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: A');
    expect(writtenContent).toContain('**Answer**: Use PostgreSQL');
    // Already-answered Q3 should remain unchanged
    expect(writtenContent).toContain('**Answer**: Use the existing brand colors');
  });

  it('returns no-spec-dir when spec directory not found', async () => {
    mockReaddirSync.mockReturnValue(['99-other-issue']);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-spec-dir');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('returns no-file when clarifications.md does not exist', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-file');
  });

  it('returns no-pending when all questions already answered', async () => {
    const allAnswered = `### Q1: Done
**Context**: Answered.
**Question**: Already answered?

**Answer**: Yes, done.
`;
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(allAnswered);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-pending');
  });

  it('returns no-answers when no matching answers found in comments', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, body: 'Some unrelated comment', author: 'user', created_at: '', updated_at: '' },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-answers');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('handles partial answers (only some questions answered)', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, body: 'Q1: OAuth 2.0', author: 'user', created_at: '', updated_at: '' },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(1);
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: OAuth 2.0');
    // Q2 should still be pending
    expect(writtenContent).toContain('*Pending*');
  });

  it('uses last answer when multiple comments answer the same question', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, body: 'Q1: First answer', author: 'user', created_at: '', updated_at: '' },
      { id: 2, body: 'Q1: Updated answer', author: 'user', created_at: '', updated_at: '' },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(1);
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: Updated answer');
    expect(writtenContent).not.toContain('First answer');
  });

  it('works with zero-padded spec directories', async () => {
    mockReaddirSync.mockReturnValue(['008-fix-something']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);

    const ctx = createWorkerContext({
      item: {
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 8,
        workflowName: 'speckit-bugfix',
        command: 'continue',
        priority: Date.now(),
        enqueuedAt: new Date().toISOString(),
      },
    });
    (ctx.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, body: 'Q1: A\nQ2: B', author: 'user', created_at: '', updated_at: '' },
    ]);

    const result = await integrateClarificationAnswers(ctx, logger);

    expect(result.integrated).toBe(2);
  });

  it('handles GitHub API failure gracefully', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('API rate limit'),
    );

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-answers');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('integrates answers from heading format (### Q1: Topic + **Answer: X**)', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 1,
        body: `## Clarification Answers

### Q1: Authentication method
**Answer: A** — OAuth 2.0 is the standard for our stack.

We already use OAuth in the existing services.

### Q2: Database choice
**Answer: B** — Use PostgreSQL for consistency with our other services.`,
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(2);
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: A — OAuth 2.0 is the standard for our stack.');
    expect(writtenContent).toContain('**Answer**: B — Use PostgreSQL for consistency with our other services.');
    // No phantom Q2 injected into Q1's section
    expect(writtenContent).not.toContain('**Answer**: *Pending*');
  });

  it('heading-format answers override template instructions text (last wins)', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      // System-posted comment with template instructions
      {
        id: 1,
        body: `<!-- generacy-clarifications:42 -->
## Clarification Questions

### Q1: Authentication method
**Context**: The spec mentions user auth.
**Question**: Which authentication method?

---

**How to answer**: Reply to this issue with your answers in the format:
\`\`\`
Q1: your answer here
Q2: your answer here
\`\`\`
`,
      },
      // User's answer in heading format
      {
        id: 2,
        body: `## Answers

### Q1: Authentication method
**Answer: A** — Use OAuth 2.0.

### Q2: Database choice
**Answer**: PostgreSQL`,
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(2);
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    // Real answers should win, not "your answer here" from template
    expect(writtenContent).toContain('**Answer**: A — Use OAuth 2.0.');
    expect(writtenContent).toContain('**Answer**: PostgreSQL');
    expect(writtenContent).not.toContain('your answer here');
  });

  it('does not treat *Pending* from question comments as real answers', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    // Only the question comment exists — no user answers
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 1,
        body: `### Q1: Authentication method
**Context**: The spec mentions user auth.
**Question**: Which authentication method?

**Answer**: *Pending*

### Q2: Database choice
**Context**: Multiple databases could work.
**Question**: PostgreSQL or MongoDB?

**Answer**: *Pending*`,
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-answers');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T006: isQuestionComment tests
// ---------------------------------------------------------------------------
describe('isQuestionComment', () => {
  it('detects orchestrator-posted clarification comment (marker)', () => {
    expect(isQuestionComment('<!-- generacy-clarifications:42 -->\n## Clarification Questions')).toBe(true);
  });

  it('detects CLI-posted clarification comment (marker)', () => {
    expect(isQuestionComment('<!-- generacy-clarification:batch-1 -->\n## Questions')).toBe(true);
  });

  it('detects stage tracking comment', () => {
    expect(isQuestionComment('<!-- generacy-stage:specification -->\n## Specification Stage')).toBe(true);
  });

  it('detects clarify operation direct posting (plain heading)', () => {
    expect(isQuestionComment('## Clarification Questions\n\nThe following areas need clarification:')).toBe(true);
  });

  it('detects clarify operation direct posting (emoji heading)', () => {
    expect(isQuestionComment('## 🔍 Clarification Questions — Batch 1\n\nThe following questions were identified:')).toBe(true);
  });

  it('detects follow-up clarification questions', () => {
    expect(isQuestionComment('## Follow-up Clarification Questions\n\nAfter reviewing your answers:')).toBe(true);
  });

  it('does not flag simple answer comment', () => {
    expect(isQuestionComment('Q1: A\nQ2: Use PostgreSQL')).toBe(false);
  });

  it('does not flag heading-format answer comment', () => {
    expect(isQuestionComment('## Answers\n\n### Q1: Auth\n**Answer: A** — OAuth')).toBe(false);
  });

  it('does not flag unrelated comment', () => {
    expect(isQuestionComment('This looks great, thanks for the update!')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T007: regression test — bot's own questions comment must not be parsed as answers
// ---------------------------------------------------------------------------
describe('integrateClarificationAnswers — regression: bot self-answer', () => {
  let context: WorkerContext;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createWorkerContext();
    logger = createMockLogger();
  });

  it('does not treat the bot question comment Q headings as answers (#375)', async () => {
    // Reproduce the exact scenario from issue #375:
    // 1. Clarify phase generates questions and posts them to the issue
    // 2. integrateClarificationAnswers fetches comments and sees the questions comment
    // 3. The Q patterns in the questions comment (### Q1: Topic) must NOT be parsed as answers
    mockReaddirSync.mockReturnValue(['375-summary-generacy-init-cli']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);

    const ctx = createWorkerContext({
      item: {
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 375,
        workflowName: 'speckit-feature',
        command: 'process',
        priority: Date.now(),
        enqueuedAt: new Date().toISOString(),
      },
    });

    // The only comment is the bot's clarification questions — no human answers yet
    (ctx.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 1,
        body: `## 🔍 Clarification Questions — Batch 1

The following questions were identified during spec analysis. Please answer to unblock implementation.

---

### Q1: Authentication method
**Context**: The spec mentions user auth but doesn't specify OAuth vs JWT.

**Question**: Which authentication method should be used?

- **A**: OAuth 2.0
- **B**: JWT tokens
- **C**: Session-based auth

---

### Q2: Database choice
**Context**: Multiple databases could work for this use case.

**Question**: Should we use PostgreSQL or MongoDB?

- **A**: PostgreSQL
- **B**: MongoDB

---

*Please reply with answers in format: \`Q1: A\`, \`Q2: B\`, etc.*`,
      },
    ]);

    const result = await integrateClarificationAnswers(ctx, logger);

    // The bot's own comment should be filtered out — no answers to integrate
    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-answers');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('still integrates real answers when bot comment is also present (#375)', async () => {
    mockReaddirSync.mockReturnValue(['375-summary-generacy-init-cli']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);

    const ctx = createWorkerContext({
      item: {
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 375,
        workflowName: 'speckit-feature',
        command: 'process',
        priority: Date.now(),
        enqueuedAt: new Date().toISOString(),
      },
    });

    (ctx.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      // Bot's questions comment
      {
        id: 1,
        body: `## 🔍 Clarification Questions — Batch 1

### Q1: Authentication method
**Context**: The spec mentions user auth.
**Question**: Which authentication method?
- **A**: OAuth 2.0
- **B**: JWT tokens

### Q2: Database choice
**Context**: Multiple databases could work.
**Question**: PostgreSQL or MongoDB?`,
      },
      // Human's actual answers
      {
        id: 2,
        body: 'Q1: A\nQ2: PostgreSQL',
      },
    ]);

    const result = await integrateClarificationAnswers(ctx, logger);

    expect(result.integrated).toBe(2);
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: A');
    expect(writtenContent).toContain('**Answer**: PostgreSQL');
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
