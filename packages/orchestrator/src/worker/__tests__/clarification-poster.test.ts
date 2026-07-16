import { fileURLToPath } from 'node:url';
import { dirname as pathDirname, join as pathJoin } from 'node:path';
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
import {
  CLARIFICATION_QUESTION_MARKERS,
  commentCarriesQuestionMarker,
} from '../clarification-markers.js';
import { isTrustedCommentAuthor } from '@generacy-ai/workflow-engine';
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

// Author-trust helpers (#842). Default stubs pass every comment through as
// trusted so pre-existing test fixtures (comments without authorAssociation)
// still exercise the intended behaviors. Individual tests can override.
vi.mock('@generacy-ai/workflow-engine', () => ({
  isTrustedCommentAuthor: vi.fn(() => ({ trusted: true, reason: 'owner' })),
  tryLoadCommentTrustConfig: vi.fn(() => undefined),
  wrapUntrustedData: vi.fn((content: string) => content),
}));

// Marker predicate module — real implementation preserved via importOriginal,
// but `commentCarriesQuestionMarker` is a spy so we can verify FR-109
// delegation from `isQuestionComment`.
vi.mock('../clarification-markers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../clarification-markers.js')>();
  return {
    ...actual,
    commentCarriesQuestionMarker: vi.fn(actual.commentCarriesQuestionMarker),
  };
});

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
  // #910: `integrateClarificationAnswers` now calls
  // `getIssueCommentsWithViewerAuth` (GraphQL). `postClarifications` still
  // calls `getIssueComments` (REST) for dedup. Alias both mocks to the same
  // vi.fn so existing tests that call `getIssueComments.mockResolvedValue()`
  // continue to set the fixture for both call sites.
  const getIssueComments = vi.fn().mockResolvedValue([]);
  return {
    addIssueComment: vi.fn().mockResolvedValue({ id: 99, body: '' }),
    getIssueComments,
    getIssueCommentsWithViewerAuth: getIssueComments,
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

  // Regression: hard-wrapped option descriptions ended the options block at the
  // first continuation line, truncating that option mid-sentence and dropping
  // every option after it. Shape taken from specs/787-epic-generacy-ai-tetrad.
  it('keeps hard-wrapped option descriptions whole and parses later options', () => {
    const questions = parseClarifications(`### Q1: Epic scoping flag
**Context**: Neither verb has a documented way to discover which epic to
scope to.
**Question**: How should \`watch\` and \`status\` determine which issues to
include?
**Options**:
- A: Require an \`--epic\` flag on both verbs. Single-epic only;
  multiple invocations for multiple epics.
- B: Auto-discover every epic from manifests, scope to the union of all
  manifest-listed issues. No flag needed.
- C: Take no epic argument; emit every open issue.

**Answer**: *Pending*
`);

    const options = questions[0]!.options!;
    expect(options.map((o) => o.label)).toEqual(['A', 'B', 'C']);
    expect(options[0]!.description).toContain('multiple invocations for multiple epics.');
    expect(options[1]!.description).toContain('No flag needed.');
  });

  // Regression: an option carrying indented sub-bullets truncated identically.
  // Shape taken from specs/916-found-during-cockpit-v1.
  it('keeps indented sub-bullets attached to their option', () => {
    const questions = parseClarifications(`### Q4: Shortened description content
**Question**: What content shape should the shortened descriptions take?
**Options**:
- A: **Terse cause only, keep issue ref**. Examples:
  - \`blocked:stuck-feedback-loop\`: \`PR-feedback loop paused.\`
  - \`blocked:stuck-validate-fix\`: \`Validate-fix paused (#892).\`
- B: **Cause only, no directive**. Slightly terser.
- C: **Cause + issue ref only**. Very short.

**Answer**: *Pending*
`);

    const options = questions[0]!.options!;
    expect(options.map((o) => o.label)).toEqual(['A', 'B', 'C']);
    expect(options[0]!.description).toContain('blocked:stuck-validate-fix');
    expect(options[2]!.description).toBe('**Cause + issue ref only**. Very short.');
  });

  it('parses options separated by blank lines', () => {
    const questions = parseClarifications(`### Q1: Topic
**Question**: Which?
**Options**:
- A) First option

- B) Second option

**Answer**: *Pending*
`);

    const options = questions[0]!.options!;
    expect(options).toEqual([
      { label: 'A', description: 'First option' },
      { label: 'B', description: 'Second option' },
    ]);
  });

  it('does not absorb the Answer line into the last option', () => {
    const questions = parseClarifications(`### Q1: Topic
**Question**: Which?
**Options**:
- A) Only option
**Answer**: Use A
`);

    expect(questions[0]!.options).toEqual([{ label: 'A', description: 'Only option' }]);
    expect(questions[0]!.answered).toBe(true);
    expect(questions[0]!.answer).toBe('Use A');
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

  it('detects clarification-stage tracking comment', () => {
    // #909: marker set narrowed to the clarification family — only
    // `<!-- generacy-stage:clarification` (and its `-batch-N` variants)
    // indicate a question comment. Non-clarification stage markers
    // (specification/planning/implementation) are a different family and
    // are covered by the "does not flag" case below.
    expect(isQuestionComment('<!-- generacy-stage:clarification -->\n## Clarification')).toBe(true);
    expect(isQuestionComment('<!-- generacy-stage:clarification-batch-1 -->\n### Q1: Topic')).toBe(true);
  });

  it('does not flag non-clarification stage tracking comment (#909 narrowing)', () => {
    expect(isQuestionComment('<!-- generacy-stage:specification -->\n## Specification Stage')).toBe(false);
    expect(isQuestionComment('<!-- generacy-stage:planning -->\n## Planning Stage')).toBe(false);
    expect(isQuestionComment('<!-- generacy-stage:implementation -->\n## Implementation Stage')).toBe(false);
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

  it('does not flag answer comment with "Answers to Clarification Questions" heading (#433)', () => {
    expect(isQuestionComment('## Answers to Clarification Questions\n\n### Q1: A — OAuth\n\nExplanation...')).toBe(false);
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
// T008: regression test — "Answers to Clarification Questions" heading (#433)
// ---------------------------------------------------------------------------
describe('integrateClarificationAnswers — regression: answer heading false positive (#433)', () => {
  let context: WorkerContext;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createWorkerContext();
    logger = createMockLogger();
  });

  it('picks up answers from comment titled "Answers to Clarification Questions"', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      // Bot's questions comment (should be filtered)
      {
        id: 1,
        body: `<!-- generacy-clarifications:42 -->\n## Clarification Questions\n\n### Q1: Authentication method\n**Question**: Which?`,
      },
      // User's answer with "Answers to Clarification Questions" heading (should NOT be filtered)
      {
        id: 2,
        body: `## Answers to Clarification Questions\n\nQ1: A\nQ2: Use PostgreSQL`,
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(2);
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: A');
    expect(writtenContent).toContain('**Answer**: Use PostgreSQL');
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

// ---------------------------------------------------------------------------
// T002: isQuestionComment — markup co-occurrence (FR-001)
// ---------------------------------------------------------------------------
describe('isQuestionComment — markup co-occurrence (FR-001)', () => {
  it('detects marker-absent comment with all three markups (Q/Context/Options) in section', () => {
    const body = `### Q1: Auth strategy
**Context**: The spec is ambiguous.
**Question**: Which flow?
**Options**:
- A) OAuth
- B) JWT`;
    expect(isQuestionComment(body)).toBe(true);
  });

  it('detects marker-absent comment with **Question**: only', () => {
    const body = `### Q1: Auth strategy
**Question**: Which flow?`;
    expect(isQuestionComment(body)).toBe(true);
  });

  it('detects marker-absent comment with **Context**: only', () => {
    const body = `### Q1: Auth strategy
**Context**: Spec ambiguity here.`;
    expect(isQuestionComment(body)).toBe(true);
  });

  it('detects marker-absent comment with **Options**: only', () => {
    const body = `### Q1: Auth strategy
**Options**:
- A) OAuth
- B) JWT`;
    expect(isQuestionComment(body)).toBe(true);
  });

  it('does NOT flag comment where markup lives outside any ### Q<n>: section (negative)', () => {
    // Markup appears in prose before any ### Q<n>: heading, and no such heading is present.
    const body = `Here is what the bot asked earlier: it said **Question**: what flow? And **Context**: yes.
But I'm just replying casually — no headings here.`;
    expect(isQuestionComment(body)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T003 / T004: integrateClarificationAnswers regression fixtures (FR-006, FR-007)
// (extends the existing describe block)
// ---------------------------------------------------------------------------
describe('integrateClarificationAnswers — questions comment must not be self-answered (FR-006, FR-007)', () => {
  let context: WorkerContext;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createWorkerContext();
    logger = createMockLogger();
  });

  it('FR-006: well-formed bot questions comment (with marker) integrates 0 answers', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);

    // Build a body verbatim from formatComment (contains marker + full markup shape).
    const questions = parseClarifications(SAMPLE_CLARIFICATIONS);
    const botBody = formatComment(questions, 42);

    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, body: botBody, author: 'bot', created_at: '', updated_at: '' },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('FR-007: variant questions comment (no marker, no ## heading, only ### Q<n>: + markup) integrates 0 answers and gate stays active', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);

    // The exact agency#374 failure mode: no dedup marker, no `## Clarification Questions`
    // heading, only per-question `### Q<n>:` headings with **Context** / **Question** markup.
    const variantBody = `### Q1: Authentication method
**Context**: The spec mentions user auth.
**Question**: Which authentication method should be used?

### Q2: Database choice
**Context**: Multiple databases could work.
**Question**: PostgreSQL or MongoDB?`;

    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 7, body: variantBody, author: 'bot', created_at: '', updated_at: '' },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    // Gate must stay active — hasPendingClarifications reads the SAME clarifications.md
    // (mockReadFileSync returns SAMPLE_CLARIFICATIONS unchanged, so pending remains).
    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T005: parseAnswersFromComments — line anchoring (FR-005, FR-008)
// ---------------------------------------------------------------------------
describe('parseAnswersFromComments — line anchoring (FR-005, FR-008)', () => {
  let context: WorkerContext;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createWorkerContext();
    logger = createMockLogger();
  });

  it('captures Q1: A at line start (positive)', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 10, body: 'Q1: A', author: 'user', created_at: '', updated_at: '' },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(1);
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: A');
  });

  it('does NOT capture mid-prose "as per Q1: yes" (negative)', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 11,
        body: 'Great — I agree with your framing, as per Q1: yes I like OAuth.',
        author: 'user',
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-answers');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('captures Q1 at line start but skips mid-prose "as per Q2: no" (mixed)', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 12,
        body: `Q1: A
some context prose
as per Q2: no I don't want that`,
        author: 'user',
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    // Only Q1 should be captured; the mid-prose "as per Q2:" must NOT anchor.
    expect(result.integrated).toBe(1);
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: A');
    // Q2 must remain *Pending* (was pending in the fixture).
    expect(writtenContent).toContain('### Q2: Database choice');
    // Grab the Q2 section after the write.
    const q2SectionStart = writtenContent.indexOf('### Q2:');
    const q2SectionEnd = writtenContent.indexOf('### Q3:');
    const q2Section = writtenContent.slice(q2SectionStart, q2SectionEnd);
    expect(q2Section).toContain('*Pending*');
    expect(q2Section).not.toContain("no I don't want that");
  });
});

// ---------------------------------------------------------------------------
// T006: parseAnswersFromComments — suspicious answer skip (FR-002, US2)
// ---------------------------------------------------------------------------
describe('parseAnswersFromComments — suspicious answer skip (FR-002, US2)', () => {
  let context: WorkerContext;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createWorkerContext();
    logger = createMockLogger();
  });

  it('skips captured answer containing **Question**: markup and warns SKIPPED_SUSPICIOUS_ANSWER', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    // Craft a comment whose body looks like it slipped past isQuestionComment
    // (no marker, no ## heading, no ### Q<n>: heading — so the section-scoped
    // FR-001 rule can't fire), but whose captured Q1 answer text contains
    // `**Question**:` markup — a signal the bot's question body is being read
    // back as an answer.
    const bodyWithQuestionMarkup = `Q1: Some intro text
**Question**: Which authentication method should be used?
Q2: PostgreSQL`;

    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 501,
        body: bodyWithQuestionMarkup,
        author: 'user',
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    // Q2 clean → integrates. Q1 tainted → skipped.
    expect(result.integrated).toBe(1);
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: PostgreSQL');

    // Q1 must remain pending.
    const q1SectionStart = writtenContent.indexOf('### Q1:');
    const q1SectionEnd = writtenContent.indexOf('### Q2:');
    const q1Section = writtenContent.slice(q1SectionStart, q1SectionEnd);
    expect(q1Section).toContain('*Pending*');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'SKIPPED_SUSPICIOUS_ANSWER',
        commentId: 501,
        questionNumber: 1,
        excerpt: expect.any(String),
      }),
      expect.stringContaining('Skipped suspicious clarification answer'),
    );
  });

  it('skips captured answer containing **Context**: markup and warns SKIPPED_SUSPICIOUS_ANSWER', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    const bodyWithContextMarkup = `Q1: Some text
**Context**: The spec mentions user auth but doesn't specify.`;

    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 502,
        body: bodyWithContextMarkup,
        author: 'user',
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'SKIPPED_SUSPICIOUS_ANSWER',
        commentId: 502,
        questionNumber: 1,
      }),
      expect.stringContaining('Skipped suspicious clarification answer'),
    );
  });

  it('does NOT warn when the answer is a clean human answer', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 503,
        body: 'Q1: OAuth 2.0 works for us\nQ2: PostgreSQL',
        author: 'user',
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(2);
    // No SKIPPED_SUSPICIOUS_ANSWER warn should fire on clean answers.
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of warnCalls) {
      const payload = call[0] as Record<string, unknown> | undefined;
      expect(payload?.code).not.toBe('SKIPPED_SUSPICIOUS_ANSWER');
    }
  });
});

// ---------------------------------------------------------------------------
// T007: integrateClarificationAnswers — residual race warn (FR-004)
// ---------------------------------------------------------------------------
describe('integrateClarificationAnswers — residual race warn (FR-004)', () => {
  let context: WorkerContext;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createWorkerContext();
    logger = createMockLogger();
  });

  it('warns TRANSITION_WITH_QUESTION_HEADINGS when a real answer transitions from a comment with ### Q<n>: heading', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    // Comment has ### Q1: heading (per data-model, sourceHadQuestionHeadings=true)
    // but no markup, so it passes FR-001 and FR-002. Yet integration happens.
    const body = `### Q1: my answer follows
Q1: real answer text`;
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 8001, body, author: 'user', created_at: '', updated_at: '' },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'TRANSITION_WITH_QUESTION_HEADINGS',
        commentId: 8001,
        issueNumber: 42,
        questionNumber: 1,
        answer: expect.any(String),
      }),
      expect.stringContaining('question headings'),
    );
  });

  it('does NOT warn on a normal human answer without ### Q<n>: heading', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 8002, body: 'Q1: OAuth 2.0\nQ2: PostgreSQL', author: 'user', created_at: '', updated_at: '' },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(2);
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of warnCalls) {
      const payload = call[0] as Record<string, unknown> | undefined;
      expect(payload?.code).not.toBe('TRANSITION_WITH_QUESTION_HEADINGS');
    }
  });

  it('does NOT warn when the question is already answered (no transition happens)', async () => {
    // Fixture where Q3 is already answered. Provide a comment with ### Q3: heading
    // + Q3: answer — the .replace() should NOT change content because Q3's
    // **Answer**: is not *Pending*.
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 8003,
        body: `### Q3: my re-answer
Q3: some overridden text`,
        author: 'user',
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    // Q3 is already answered in the fixture — pendingNumbers excludes 3,
    // so parseAnswersFromComments does not integrate it. No transition, no warn.
    expect(result.integrated).toBe(0);
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of warnCalls) {
      const payload = call[0] as Record<string, unknown> | undefined;
      expect(payload?.code).not.toBe('TRANSITION_WITH_QUESTION_HEADINGS');
    }
  });
});

// ---------------------------------------------------------------------------
// #909 — Marker-based exclusion in clarification answer-scanner
// ---------------------------------------------------------------------------

const SNAPPOLL_4_FIXTURE_BODY = `<!-- generacy-stage:clarification-batch-1 -->

## ❓ Clarification Questions — Batch 1

The following questions were identified during spec analysis.

### Q1: Authentication method
Which authentication method should be used? OAuth vs JWT vs session-based.

### Q2: Database choice
Multiple databases could work — PostgreSQL vs MongoDB.
`;

const SAMPLE_CLARIFICATIONS_909 = `# Clarification Questions

## Status: Pending

## Questions

### Q1: Authentication method
**Context**: The spec mentions user auth but doesn't specify OAuth vs JWT.
**Question**: Which authentication method should be used?

**Answer**: *Pending*

### Q2: Database choice
**Context**: Multiple databases could work for this use case.
**Question**: Should we use PostgreSQL or MongoDB?

**Answer**: *Pending*
`;

// ---------------------------------------------------------------------------
// T006: parseAnswersFromComments — marker exclusion (SC-001..SC-004, SC-008)
// ---------------------------------------------------------------------------
describe('parseAnswersFromComments — marker exclusion (#909)', () => {
  let context: WorkerContext;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createWorkerContext();
    logger = createMockLogger();
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS_909);
  });

  it('returns no answers for the snappoll#4 engine-authored questions comment (SC-001)', async () => {
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 4938943909,
        body: SNAPPOLL_4_FIXTURE_BODY,
        author: 'generacy-ai[bot]',
        authorAssociation: 'NONE',
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-answers');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it.each([
    ['OWNER'],
    ['MEMBER'],
    ['CONTRIBUTOR'],
  ])(
    'returns no answers for the snappoll#4 fixture even when authorAssociation is %s (SC-002 at parser level)',
    async (tier) => {
      (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 4938943909,
          body: SNAPPOLL_4_FIXTURE_BODY,
          author: 'generacy-ai[bot]',
          authorAssociation: tier,
          created_at: '',
          updated_at: '',
        },
      ]);

      const result = await integrateClarificationAnswers(context, logger);

      expect(result.integrated).toBe(0);
      expect(result.reason).toBe('no-answers');
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    },
  );

  it('integrates trusted `Q1: A\\nQ2: B` with no marker (SC-003)', async () => {
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 2,
        body: 'Q1: A\nQ2: B',
        author: 'human',
        authorAssociation: 'OWNER',
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(2);
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: A');
    expect(writtenContent).toContain('**Answer**: B');
  });

  it('integrates answers when a human quotes the questions comment with `> ` (SC-004 / US4)', async () => {
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 3,
        body: '> <!-- generacy-stage:clarification -->\n> ### Q1: Topic\n\nQ1: A\nQ2: B',
        author: 'human',
        authorAssociation: 'OWNER',
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(2);
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: A');
    expect(writtenContent).toContain('**Answer**: B');
  });

  it('emits exactly one FR-107 debug log per excluded comment, with no body field (SC-008)', async () => {
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 4938943909,
        body: SNAPPOLL_4_FIXTURE_BODY,
        author: 'generacy-ai[bot]',
        authorAssociation: 'NONE',
        created_at: '',
        updated_at: '',
      },
    ]);

    await integrateClarificationAnswers(context, logger);

    const debugCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls;
    const markerLogs = debugCalls.filter(
      ([first]) =>
        typeof first === 'object' &&
        first !== null &&
        (first as Record<string, unknown>).event ===
          'clarification-answer-scanner-marker-excluded',
    );
    expect(markerLogs).toHaveLength(1);

    const [meta, msg] = markerLogs[0]!;
    const m = meta as Record<string, unknown>;
    expect(m.commentId).toBe(4938943909);
    expect(m.author).toBe('generacy-ai[bot]');
    expect(m.markerPrefix).toBe('<!-- generacy-stage:clarification');
    expect(m.issueNumber).toBe(42);
    expect(m.body).toBeUndefined();
    expect(m.content).toBeUndefined();
    expect(m.text).toBeUndefined();
    expect(msg).toBe('Excluded from answer-scanner via question marker');
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain('Authentication method');
    expect(serialized).not.toContain('Database choice');
  });
});

// ---------------------------------------------------------------------------
// T007: integrateClarificationAnswers — marker exclusion + trust independence
// ---------------------------------------------------------------------------
describe('integrateClarificationAnswers — marker exclusion + trust independence (#909, FR-110)', () => {
  let context: WorkerContext;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createWorkerContext();
    logger = createMockLogger();
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS_909);
  });

  it('runs the trust check on the marker-filtered scanCandidates set, not on raw comments (FR-102)', async () => {
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 4938943909,
        body: SNAPPOLL_4_FIXTURE_BODY,
        author: 'generacy-ai[bot]',
        authorAssociation: 'NONE',
        created_at: '',
        updated_at: '',
      },
      {
        id: 100,
        body: 'Q1: A\nQ2: B',
        author: 'alice',
        authorAssociation: 'OWNER',
        created_at: '',
        updated_at: '',
      },
    ]);

    await integrateClarificationAnswers(context, logger);

    const trustSpy = isTrustedCommentAuthor as unknown as ReturnType<typeof vi.fn>;
    // The engine questions comment (id 4938943909) must NEVER reach the trust check.
    for (const call of trustSpy.mock.calls) {
      const comment = call[0] as { id: number };
      expect(comment.id).not.toBe(4938943909);
    }
    // The human answer (id 100) must have been evaluated.
    const seenIds = trustSpy.mock.calls.map((c) => (c[0] as { id: number }).id);
    expect(seenIds).toContain(100);
  });

  it('does not post an untrusted-answer explainer for the engine-authored questions comment (FR-103)', async () => {
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 4938943909,
        body: SNAPPOLL_4_FIXTURE_BODY,
        author: 'generacy-ai[bot]',
        authorAssociation: 'NONE',
        created_at: '',
        updated_at: '',
      },
    ]);

    await integrateClarificationAnswers(context, logger);

    const addIssueComment = context.github.addIssueComment as ReturnType<typeof vi.fn>;
    for (const call of addIssueComment.mock.calls) {
      const body = call[3] as string;
      expect(body).not.toContain('not applied');
      expect(body).not.toContain('association tier');
    }
  });

  it('integrated remains 0 and no explainer is posted even when trust says the bot IS trusted (#910 guard)', async () => {
    // Simulate what #910 will do to the cluster: the bot's own identity becomes
    // trusted on the answer-scanner surface. Without marker exclusion, the
    // trust check would wave the engine questions comment through to the
    // parser and it would silently self-answer.
    const trustSpy = isTrustedCommentAuthor as unknown as ReturnType<typeof vi.fn>;
    trustSpy.mockImplementation(() => ({ trusted: true, reason: 'owner' }));

    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 4938943909,
        body: SNAPPOLL_4_FIXTURE_BODY,
        author: 'generacy-ai[bot]',
        authorAssociation: 'OWNER',
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-answers');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    const addIssueComment = context.github.addIssueComment as ReturnType<typeof vi.fn>;
    for (const call of addIssueComment.mock.calls) {
      const body = call[3] as string;
      expect(body).not.toContain('not applied');
      expect(body).not.toContain('association tier');
    }
  });
});

// ---------------------------------------------------------------------------
// T008: untrusted-answer explainer copy (SC-005, SC-006, FR-104)
// ---------------------------------------------------------------------------
describe('untrusted-answer explainer copy (#909)', () => {
  let context: WorkerContext;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createWorkerContext();
    logger = createMockLogger();
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS_909);

    // Force NONE-authored to be untrusted so the explainer path fires.
    const trustSpy = isTrustedCommentAuthor as unknown as ReturnType<typeof vi.fn>;
    trustSpy.mockImplementation((comment: { authorAssociation?: string }) => {
      if (comment.authorAssociation === 'NONE') {
        return { trusted: false, reason: 'none-untrusted' };
      }
      return { trusted: true, reason: 'owner' };
    });
  });

  it('body names the re-post remediation in the `Q1: <answer>` format (SC-006)', async () => {
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 555,
        body: 'Q1: my answer',
        author: 'eve',
        authorAssociation: 'NONE',
        created_at: '',
        updated_at: '',
      },
    ]);

    await integrateClarificationAnswers(context, logger);

    const addIssueComment = context.github.addIssueComment as ReturnType<typeof vi.fn>;
    expect(addIssueComment).toHaveBeenCalled();
    const body = addIssueComment.mock.calls[0]![3] as string;
    expect(body).toContain('re-post the answers themselves');
    expect(body).toContain('`Q1: <answer>`');
    expect(body).toContain('OWNER/MEMBER/COLLABORATOR');
  });

  it('body contains zero /confirm/i matches (SC-005)', async () => {
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 556,
        body: 'Q1: some drive-by answer',
        author: 'mallory',
        authorAssociation: 'NONE',
        created_at: '',
        updated_at: '',
      },
    ]);

    await integrateClarificationAnswers(context, logger);

    const addIssueComment = context.github.addIssueComment as ReturnType<typeof vi.fn>;
    const body = addIssueComment.mock.calls[0]![3] as string;
    expect(body).not.toMatch(/confirm/i);
  });
});

// ---------------------------------------------------------------------------
// T009: SC-007 — no hardcoded markers outside clarification-markers.ts
// ---------------------------------------------------------------------------
describe('SC-007 — no hardcoded question markers outside clarification-markers.ts (#909)', () => {
  // (file, prefix) pairs allowed to contain the marker. Any occurrence
  // elsewhere in the worker directory fails the test.
  //
  // Rationale: `MARKER_PREFIX` and `cliMarkerPrefix` in clarification-poster.ts
  // are posting-marker constants for `postClarifications`'s own dedup surface —
  // a distinct concern from answer-scanning. See plan.md §"Files NOT changing".
  const ALLOWLIST: readonly { file: string; prefix: string; reason: string }[] = [
    {
      file: 'clarification-poster.ts',
      prefix: '<!-- generacy-clarifications:',
      reason: 'posting-marker constant (MARKER_PREFIX) + JSDoc reference',
    },
    {
      file: 'clarification-poster.ts',
      prefix: '<!-- generacy-clarification:',
      reason: 'CLI posting-marker constant (cliMarkerPrefix) + JSDoc reference',
    },
  ] as const;

  it('fails if any of the four question-marker prefixes leak into a worker file (except allowlist)', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const testDir = pathDirname(fileURLToPath(import.meta.url));
    const workerDir = pathJoin(testDir, '..');

    const files = fs
      .readdirSync(workerDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.ts'))
      .map((d) => d.name)
      .filter((n) => n !== 'clarification-markers.ts');

    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(pathJoin(workerDir, file), 'utf8');
      for (const prefix of CLARIFICATION_QUESTION_MARKERS) {
        if (!content.includes(prefix)) continue;
        const allowed = ALLOWLIST.some(
          (entry) => entry.file === file && entry.prefix === prefix,
        );
        if (!allowed) {
          violations.push(`${file}: hardcoded marker ${JSON.stringify(prefix)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T010: isQuestionComment delegates to commentCarriesQuestionMarker (FR-109)
// ---------------------------------------------------------------------------
describe('isQuestionComment — FR-109 delegation to commentCarriesQuestionMarker (#909)', () => {
  it('calls commentCarriesQuestionMarker when a marker is present', () => {
    const spy = commentCarriesQuestionMarker as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const result = isQuestionComment('<!-- generacy-clarifications:42 -->\n');

    expect(result).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it('calls commentCarriesQuestionMarker even when the body is a non-marker (content-shape branch fallback)', () => {
    const spy = commentCarriesQuestionMarker as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    isQuestionComment('Q1: A\nQ2: B');

    // Marker branch runs first (returns false), then content-shape branches
    // run. The delegation must have been consulted.
    expect(spy).toHaveBeenCalled();
  });
});
