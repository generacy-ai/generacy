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
  parseAnswersFromComments,
  extractEmbeddedAnswer,
  commentMatchesAnswerPattern,
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
  // #958 — real implementations of the shared pending-answer helpers so the
  // orchestrator code (which imports them) sees non-undefined values.
  PENDING_ANSWER_LITERAL: '*Pending*',
  isPendingAnswerValue: (v: string): boolean => {
    if (typeof v !== 'string') return false;
    const t = v.trim();
    if (t === '') return true;
    if (t === '*Pending*') return true;
    return /^\[[^\]]*\]$/.test(t);
  },
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

  // #958 FR-007 — hasPendingClarifications fails closed. Missing spec dir,
  // missing subdirectory match, and unreadable file all now return TRUE
  // (== pause), not false (== advance). Unknown state must pause on a
  // human gate. Sibling test file: `has-pending-clarifications.test.ts`
  // covers the branches in more detail.
  it('returns true when specs dir does not exist (FR-007 fail-closed)', () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(true);
  });

  it('returns true when no matching spec directory found (FR-007)', () => {
    mockReaddirSync.mockReturnValue(['99-other-issue']);

    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(true);
  });

  it('returns true when clarifications.md does not exist (FR-007)', () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(true);
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

  // #976 SC-001 — cluster-self plain `Q<n>:` reply integrates. Mirrors the
  // different-account case above; the only difference is `viewerDidAuthor: true`.
  // Same-account trust is delegated to `isTrustedCommentAuthor` (self-authored
  // → trusted); no machine marker means no pre-filter exclusion; the answer
  // flows through the same path as a different-account reply.
  it('#976 SC-001 — cluster-self plain `Q<n>:` reply (viewerDidAuthor=true, no marker) integrates', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 1,
        body: 'Q1: OAuth 2.0',
        author: 'cluster-bot',
        authorAssociation: 'NONE',
        viewerDidAuthor: true,
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(1);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: OAuth 2.0');
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

  // #958 FR-004 — heading-format answers now trigger fail-closed skip for
  // humans (per-question). This is a deliberate blast-radius trade to prevent
  // bot self-answer via `### Q<n>:` headings. Cluster-relayed answers use the
  // deterministic cockpit tool which emits `Q<n>:` lines (not headings).
  // Heading-format was never in the SC-002 supported flow list.
  it('#958 FR-004 — heading-format human answer is skipped (fail-closed)', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 1,
        body: `## Clarification Answers

### Q1: Authentication method
**Answer: A** — OAuth 2.0.

### Q2: Database choice
**Answer: B** — Use PostgreSQL.`,
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.parseFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'transition-with-question-headings' }),
      ]),
    );
  });

  it('#958 FR-004 — heading-format on a bot comment + plain `Q<n>:` on human comment: only the human comment integrates', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      // Bot's questions comment carries the questions marker — filtered by
      // the question-marker pre-filter.
      {
        id: 1,
        body: `<!-- generacy-clarifications:42 -->
## Clarification Questions

### Q1: Authentication method
**Question**: Which authentication method?`,
      },
      // Plain-format human answer — integrates via the supported SC-002 flow.
      {
        id: 2,
        body: `Q1: OAuth 2.0\nQ2: PostgreSQL`,
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(2);
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: OAuth 2.0');
    expect(writtenContent).toContain('**Answer**: PostgreSQL');
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

    // #958 — the bot's own comment is filtered by FR-004 (has `### Q<n>:`
    // headings). No answers integrate. reason may be `no-changes` (parser
    // captured candidate answers that were then FR-004-skipped) rather than
    // `no-answers` (parser found none).
    expect(result.integrated).toBe(0);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(['no-answers', 'no-changes']).toContain(result.reason);
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

  // #958 FR-001 — the L488 content-sniff branch was deleted. Authorship
  // (viewerDidAuthor) is the gate, not content. These two former SC-002
  // tests are inverted: a human comment with `**Question**:` or `**Context**:`
  // markup inside a captured answer now integrates through the human /
  // permissive branch, because content is not authorship. The bot self-answer
  // scenario is covered by the T016 authorship gate (clarification-self-answer.test.ts).
  it('#958 FR-001 — captured answer with **Question**: markup on a human comment integrates (content is not authorship)', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    const bodyWithQuestionMarkup = `Q1: Some intro text
**Question**: Which authentication method should be used?
Q2: PostgreSQL`;

    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 501,
        body: bodyWithQuestionMarkup,
        author: 'user',
        // No viewerDidAuthor → permissive human branch. Under #958 this
        // integrates without invoking the deleted L488 sniff.
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    // Both Q1 and Q2 integrate — the content sniff is gone.
    expect(result.integrated).toBe(2);
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain('**Answer**: PostgreSQL');
    // SKIPPED_SUSPICIOUS_ANSWER warn is deleted with the sniff.
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of warnCalls) {
      const payload = call[0] as Record<string, unknown> | undefined;
      expect(payload?.code).not.toBe('SKIPPED_SUSPICIOUS_ANSWER');
    }
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

  it('#958 FR-004 — human comment with ### Q<n>: heading is skipped (fail-closed per-question)', async () => {
    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    // Under #958 the FR-004 detector fires fail-closed: for humans, skip the
    // offending question (parseFailures entry); for cluster-self, abort the
    // whole poll.
    const body = `### Q1: my answer follows
Q1: real answer text`;
    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 8001, body, author: 'user', created_at: '', updated_at: '' },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    // Q1 was skipped (fail-closed) → 0 integrated on this fixture.
    expect(result.integrated).toBe(0);
    expect(result.parseFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          questionNumber: 1,
          reason: 'transition-with-question-headings',
        }),
      ]),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'TRANSITION_WITH_QUESTION_HEADINGS',
        commentId: 8001,
        issueNumber: 42,
        questionNumber: 1,
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
    expect(msg).toBe('Excluded from answer-scanner via machine marker');
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

// ---------------------------------------------------------------------------
// #949 — Cockpit dialect fixtures + tests
// ---------------------------------------------------------------------------
//
// Fixture inventory per specs/949-summary-cockpit-plugin-posts/data-model.md
// §"Fixture inventory". FIXTURE_COCKPIT_MULTI is captured VERBATIM from the
// cockpit-format clarification-answer comment on this repo's issue #949, per
// clarification Q4→A ("MUST — at least one test fixture must be captured
// verbatim from a real cockpit-posted issue comment").

/**
 * FIXTURE_COCKPIT_MULTI — captured verbatim from issue #949's cockpit-format
 * answer comment (`gh issue view 949 --json comments`). Four `### Q<n>` blocks
 * (Q2-Q5), each with an `**Answer:**` line and a `**Rationale:**` line.
 * Multi-question requirement per Q4→A (≥ 2 blocks).
 */
const FIXTURE_COCKPIT_MULTI = `<!-- generacy-cockpit:clarification-answers -->

### Q2
**Answer:** A — The colon-less opener REQUIRES a markdown heading (\`### Q<n>\`, \`## Q<n>\`, \`#### Q<n>\`, etc.). Colon-required forms (\`Q1:\`, \`**Q1**:\`, bare \`Q1:\`) continue to open exactly as they do today.
**Rationale:** Option B would promote a bare line-start \`Q1\` into an opener, which weakens the very FR-005 line-anchoring guard this spec insists on preserving.

### Q3
**Answer:** A — MUST. The implementation must extract a single shared opener pattern; two duplicate copies fail acceptance.
**Rationale:** The defect class under repair *is* pattern drift, and here extraction is mechanically cheap rather than awkward.

### Q4
**Answer:** A — MUST, with two refinements. The fixture MUST be multi-question (≥ 2 \`### Q<n>\` blocks).
**Rationale:** A hand-written fixture pins the implementer's *reading* of the byte-locked contract rather than the contract itself.

### Q5
**Answer:** C — Neither A nor B. FR-004 should not fire for well-formed cockpit answers, so the correct acceptance surface is to pin the negative, not the positive.
**Rationale:** A cockpit answer comment uses \`### Q<n>\` as answer-block delimiters, not question headings.
`;

/**
 * FIXTURE_COCKPIT_SINGLE — single-block cockpit body with rationale.
 * SC-002-adjacent regression (single-Q positive path).
 */
const FIXTURE_COCKPIT_SINGLE = `<!-- generacy-cockpit:clarification-answers -->

### Q1
**Answer:** A — Use the sealed file backend
**Rationale:** It avoids a cloud round-trip.
`;

/** Engine dialect: `### Q1: Topic\\n**Answer: A** — text`. */
const FIXTURE_ENGINE_HEADING = `### Q1: Authentication method
**Answer: A** — OAuth 2.0 is the standard for our stack.`;

/** Engine dialect: `### Q1: Topic\\n**Answer**: A` (colon outside bold). */
const FIXTURE_ENGINE_ANSWER_COLON_OUTSIDE = `### Q1: Authentication method
**Answer**: OAuth 2.0`;

/** Bare human dialect. */
const FIXTURE_BARE_HUMAN = `Q1: answer text`;

/** FR-005 negative — mid-prose reference must NOT capture. */
const FIXTURE_MID_PROSE = `Great — I agree with your framing.
Also — as per Q1: yes I like OAuth.
More prose after.`;

/** Q2→A negative — colon-less form requires heading, bare `Q1\\n...` must not open. */
const FIXTURE_BARE_LINE_START_NO_HEADING = `Q1
**Answer:** X`;

/** FR-002 negative — leaked `**Question**:` inside cockpit-shaped body. */
const FIXTURE_LEAKED_QUESTION = `<!-- generacy-cockpit:clarification-answers -->

### Q1
**Answer:** X
**Question**: leaked bot text that should not be here`;

/** FR-013 — cockpit-shaped body posted by an untrusted author. */
const FIXTURE_COCKPIT_UNTRUSTED_AUTHOR = `<!-- generacy-cockpit:clarification-answers -->

### Q1
**Answer:** A — my drive-by answer
**Rationale:** because I said so`;

/**
 * FIXTURE_COCKPIT_FR004_NEGATIVE — well-formed cockpit body. Data-model
 * permits reusing FIXTURE_COCKPIT_MULTI; we keep a distinct constant for
 * test-intent clarity.
 */
const FIXTURE_COCKPIT_FR004_NEGATIVE = FIXTURE_COCKPIT_MULTI;

/**
 * Clarifications file skeleton with pending Q2..Q5 slots so integration tests
 * against the multi-block cockpit fixture can persist answers to real
 * pending slots.
 */
const SAMPLE_CLARIFICATIONS_949 = `# Clarification Questions

## Status: Pending

## Questions

### Q2: Opener strictness when the colon is absent
**Context**: The colon is optional in cockpit dialect.
**Question**: Which line shapes qualify as openers?

**Answer**: *Pending*

### Q3: Shared regex constant
**Context**: FR-003 stay-in-lockstep language.
**Question**: MUST or SHOULD?

**Answer**: *Pending*

### Q4: Real cockpit-posted comment fixture
**Context**: SC-001 language.
**Question**: MUST or SHOULD?

**Answer**: *Pending*

### Q5: FR-004 residual-race detector
**Context**: Whether FR-004 should fire on cockpit bodies.
**Question**: Dedicated test coverage?

**Answer**: *Pending*
`;

// ---------------------------------------------------------------------------
// T008: multi-question terminator lockstep (LOAD-BEARING per plan Q4→A)
// ---------------------------------------------------------------------------
describe('cockpit dialect: multi-question integration (#949, T008 load-bearing)', () => {
  it('integrates each block independently from the real captured cockpit body', () => {
    const logger = createMockLogger();
    const answers = parseAnswersFromComments(
      [{ id: 1, body: FIXTURE_COCKPIT_MULTI }],
      [2, 3, 4, 5],
      logger,
    );

    // Load-bearing invariant: with a widened opener but stale terminator,
    // Q2's lazy `(.*?)` would swallow Q3/Q4/Q5 into its own body — only
    // ONE block would be captured. Assert all four are present and distinct.
    expect(answers.size).toBe(4);

    expect(answers.get(2)?.answer).toContain('A — The colon-less opener REQUIRES');
    expect(answers.get(2)?.answer).toContain('Rationale: Option B would promote');

    expect(answers.get(3)?.answer).toContain('A — MUST');
    expect(answers.get(3)?.answer).toContain('Rationale: The defect class');

    expect(answers.get(4)?.answer).toContain('A — MUST, with two refinements');
    expect(answers.get(4)?.answer).toContain('Rationale: A hand-written fixture');

    expect(answers.get(5)?.answer).toContain('C — Neither A nor B');
    expect(answers.get(5)?.answer).toContain('Rationale: A cockpit answer comment');
  });
});

// ---------------------------------------------------------------------------
// T009: single-question with rationale (Q1→B join)
// ---------------------------------------------------------------------------
describe('cockpit dialect: single question with rationale (#949, T009)', () => {
  it('joins the **Rationale:** line onto the answer per Q1→B', () => {
    const logger = createMockLogger();
    const answers = parseAnswersFromComments(
      [{ id: 1, body: FIXTURE_COCKPIT_SINGLE }],
      [1],
      logger,
    );

    expect(answers.get(1)?.answer).toBe(
      'A — Use the sealed file backend\nRationale: It avoids a cloud round-trip.',
    );
  });
});

// ---------------------------------------------------------------------------
// T010: single question without rationale
// ---------------------------------------------------------------------------
describe('cockpit dialect: single question without rationale (#949, T010)', () => {
  it('returns just the answer value with no Rationale: suffix', () => {
    const logger = createMockLogger();
    const answers = parseAnswersFromComments(
      [{ id: 1, body: '### Q1\n**Answer:** X' }],
      [1],
      logger,
    );

    expect(answers.get(1)?.answer).toBe('X');
    expect(answers.get(1)?.answer).not.toContain('Rationale:');
  });
});

// ---------------------------------------------------------------------------
// T011-T014: Regression tests for existing dialects (all parallel)
// ---------------------------------------------------------------------------
describe('regression: existing dialects still parse (#949, T011-T014)', () => {
  const logger = createMockLogger();

  it('T011: engine dialect `### Q1: Topic\\n**Answer: X**` still parses (m1 arm)', () => {
    const answers = parseAnswersFromComments(
      [{ id: 1, body: FIXTURE_ENGINE_HEADING }],
      [1],
      logger,
    );
    expect(answers.get(1)?.answer).toBe(
      'A — OAuth 2.0 is the standard for our stack.',
    );
  });

  it('T012: engine dialect `### Q1: Topic\\n**Answer**: X` still parses (m2 arm)', () => {
    const answers = parseAnswersFromComments(
      [{ id: 1, body: FIXTURE_ENGINE_ANSWER_COLON_OUTSIDE }],
      [1],
      logger,
    );
    expect(answers.get(1)?.answer).toBe('OAuth 2.0');
  });

  it('T013: bare human dialect `Q1: answer text` still parses', () => {
    const answers = parseAnswersFromComments(
      [{ id: 1, body: FIXTURE_BARE_HUMAN }],
      [1],
      logger,
    );
    expect(answers.get(1)?.answer).toBe('answer text');
  });

  it('T014: bold-wrapped colon-bearing `**Q1**: A` still parses (contract row 10)', () => {
    const answers = parseAnswersFromComments(
      [{ id: 1, body: '**Q1**: A' }],
      [1],
      logger,
    );
    expect(answers.get(1)?.answer).toBe('A');
  });
});

// ---------------------------------------------------------------------------
// T015-T017: Negative regression tests (all parallel)
// ---------------------------------------------------------------------------
describe('negative regressions (#949, T015-T017)', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('T015 (FR-005): mid-prose `as per Q1: yes` does NOT capture', () => {
    const answers = parseAnswersFromComments(
      [{ id: 1, body: FIXTURE_MID_PROSE }],
      [1],
      logger,
    );
    expect(answers.get(1)).toBeUndefined();
    expect(answers.size).toBe(0);
  });

  it('T016 (Q2→A): bare line-start `Q1\\n**Answer:** X` (no heading, no colon) does NOT open', () => {
    const answers = parseAnswersFromComments(
      [{ id: 1, body: FIXTURE_BARE_LINE_START_NO_HEADING }],
      [1],
      logger,
    );
    expect(answers.get(1)).toBeUndefined();
    expect(answers.size).toBe(0);
  });

  it('T017 (#958 FR-001): cockpit opener with a leaked `**Question**:` line still extracts the clean `**Answer:**` — content is not authorship, no SKIPPED_SUSPICIOUS_ANSWER', () => {
    const answers = parseAnswersFromComments(
      [{ id: 501, body: FIXTURE_LEAKED_QUESTION }],
      [1],
      logger,
    );
    // The `**Question**:` content-sniff was deleted with #958. The block's
    // clean `**Answer:** X` is extracted; the leaked line is simply ignored.
    // Whether such a comment is trusted is decided by authorship in the
    // caller (viewerDidAuthor), not by content markers here.
    expect(answers.get(1)?.answer).toBe('X');
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of warnCalls) {
      const payload = call[0] as Record<string, unknown> | undefined;
      expect(payload?.code).not.toBe('SKIPPED_SUSPICIOUS_ANSWER');
    }
  });
});

// ---------------------------------------------------------------------------
// T018: FR-013 — cockpit-format answer from untrusted author produces explainer
// ---------------------------------------------------------------------------
describe('FR-013: cockpit-format answer from untrusted author produces explainer (#949, T018)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('commentMatchesAnswerPattern returns true for cockpit-shaped body', () => {
    expect(commentMatchesAnswerPattern(FIXTURE_COCKPIT_UNTRUSTED_AUTHOR)).toBe(true);
  });

  it('untrusted-author explainer fires for a cockpit-format body', async () => {
    // Force NONE-authored to be untrusted so the explainer path fires.
    const trustSpy = isTrustedCommentAuthor as unknown as ReturnType<typeof vi.fn>;
    trustSpy.mockImplementation((comment: { authorAssociation?: string }) => {
      if (comment.authorAssociation === 'NONE') {
        return { trusted: false, reason: 'none-untrusted' };
      }
      return { trusted: true, reason: 'owner' };
    });

    mockReaddirSync.mockReturnValue(['42-feature-branch']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS);
    const context = createWorkerContext();
    const logger = createMockLogger();

    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 909,
        body: FIXTURE_COCKPIT_UNTRUSTED_AUTHOR,
        author: 'eve',
        authorAssociation: 'NONE',
        created_at: '',
        updated_at: '',
      },
    ]);

    await integrateClarificationAnswers(context, logger);

    const addIssueComment = context.github.addIssueComment as ReturnType<typeof vi.fn>;
    expect(addIssueComment).toHaveBeenCalled();
    const explainerBody = addIssueComment.mock.calls[0]![3] as string;
    expect(explainerBody).toContain('not applied');
    expect(explainerBody).toContain('association tier');
  });
});

// ---------------------------------------------------------------------------
// T019: FR-004 negative pin — cockpit body must NOT emit
//       TRANSITION_WITH_QUESTION_HEADINGS (LOAD-BEARING for Q5→C)
// ---------------------------------------------------------------------------
describe('FR-004 negative pin (#949 Q5→C, T019 load-bearing)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('well-formed cockpit multi-block body integrates WITHOUT TRANSITION_WITH_QUESTION_HEADINGS', async () => {
    // Ensure trust does not gate this test.
    const trustSpy = isTrustedCommentAuthor as unknown as ReturnType<typeof vi.fn>;
    trustSpy.mockImplementation(() => ({ trusted: true, reason: 'owner' }));

    mockReaddirSync.mockReturnValue(['949-cockpit']);
    mockReadFileSync.mockReturnValue(SAMPLE_CLARIFICATIONS_949);
    const context = createWorkerContext({
      item: {
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 949,
        workflowName: 'speckit-bugfix',
        command: 'process',
        priority: Date.now(),
        enqueuedAt: new Date().toISOString(),
      },
    });
    const logger = createMockLogger();

    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 949001,
        body: FIXTURE_COCKPIT_FR004_NEGATIVE,
        author: 'operator',
        authorAssociation: 'OWNER',
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(4);

    // Load-bearing assertion: if the shared constant is swept over :453
    // (Q5→C violation), this warn would fire on every legitimate cockpit
    // integration — a 100%-rate false positive.
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of warnCalls) {
      const payload = call[0] as Record<string, unknown> | undefined;
      expect(payload?.code).not.toBe('TRANSITION_WITH_QUESTION_HEADINGS');
    }
  });
});

// ---------------------------------------------------------------------------
// T020: extractEmbeddedAnswer unit tests (contract rows 1-6)
// ---------------------------------------------------------------------------
describe('extractEmbeddedAnswer — unit tests per regex-contract.md (#949, T020)', () => {
  it('row 1: m0 + rationale join (Q1→B)', () => {
    const text =
      '\n**Answer:** A — Use the sealed file backend\n**Rationale:** It avoids a cloud round-trip.';
    expect(extractEmbeddedAnswer(text)).toBe(
      'A — Use the sealed file backend\nRationale: It avoids a cloud round-trip.',
    );
  });

  it('row 2: m0 alone — no rationale ⇒ no join', () => {
    expect(extractEmbeddedAnswer('\n**Answer:** X')).toBe('X');
  });

  it('row 3: m1 — engine dialect regression `**Answer: A** — description`', () => {
    expect(extractEmbeddedAnswer('\n**Answer: A** — description')).toBe(
      'A — description',
    );
  });

  it('row 4: m2 — engine dialect regression `**Answer**: A`', () => {
    expect(extractEmbeddedAnswer('\n**Answer**: A')).toBe('A');
  });

  it('row 5: no **Answer markup ⇒ undefined', () => {
    expect(extractEmbeddedAnswer('some other text')).toBeUndefined();
  });

  it('row 6: multi-`**Answer:**` in one block — first match wins per /m mode', () => {
    const text =
      '\n**Answer:** X\n**Rationale:** Y\n**Answer:** Z';
    expect(extractEmbeddedAnswer(text)).toBe('X\nRationale: Y');
  });
});

// ---------------------------------------------------------------------------
// T021: commentMatchesAnswerPattern unit tests (contract rows 1-6)
// ---------------------------------------------------------------------------
describe('commentMatchesAnswerPattern — unit tests per regex-contract.md (#949, T021)', () => {
  it('row 1: cockpit dialect colon-less with heading ⇒ true', () => {
    expect(commentMatchesAnswerPattern('### Q1\n**Answer:** X')).toBe(true);
  });

  it('row 2: engine dialect ⇒ true', () => {
    expect(commentMatchesAnswerPattern('### Q1: Topic\n**Answer**: X')).toBe(true);
  });

  it('row 3: bare human dialect ⇒ true', () => {
    expect(commentMatchesAnswerPattern('Q1: answer')).toBe(true);
  });

  it('row 4: FR-005 mid-prose ⇒ false', () => {
    expect(commentMatchesAnswerPattern('as per Q1: yes')).toBe(false);
  });

  it('row 5: Q2→A bare line-start `Q1\\n...` (no heading, no colon) ⇒ false', () => {
    expect(commentMatchesAnswerPattern('Q1\n**Answer:** X')).toBe(false);
  });

  it('row 6: unrelated comment (baseline) ⇒ false', () => {
    expect(commentMatchesAnswerPattern('Random comment, no question ref.')).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// T022: Invariant — mid-block bare Q<n> is NOT re-opened by terminator
// ---------------------------------------------------------------------------
describe('invariant: terminator lockstep prevents mid-block re-opening (#949, T022)', () => {
  it('mid-block bare `Q1\\n**Answer:** Y` inside a captured block stays inside the body', () => {
    const logger = createMockLogger();
    const body =
      '### Q1\n**Answer:** X\nsome text\nQ1\n**Answer:** Y\n### Q2\n**Answer:** Z';

    const answers = parseAnswersFromComments(
      [{ id: 1, body }],
      [1, 2],
      logger,
    );

    // Two blocks captured (Q1 and Q2). If the terminator's colon-less arm
    // did not also require a heading, the mid-block bare `Q1\n**Answer:** Y`
    // would re-open a new block and overwrite Q1's answer to 'Y'.
    expect(answers.size).toBe(2);
    expect(answers.get(1)?.answer).toBe('X');
    expect(answers.get(1)?.answer).not.toBe('Y');
    expect(answers.get(2)?.answer).toBe('Z');
  });
});

// ---------------------------------------------------------------------------
// T023: Shared-constant invariant — no duplicate inline copies (Q3→A)
// ---------------------------------------------------------------------------
describe('invariant: shared opener constant not duplicated inline (#949, T023)', () => {
  it('distinctive raw-pattern prefix appears exactly twice in clarification-poster.ts', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const testDir = pathDirname(fileURLToPath(import.meta.url));
    const srcPath = pathJoin(testDir, '..', 'clarification-poster.ts');
    const src = fs.readFileSync(srcPath, 'utf8');

    // Distinctive substring shared by both QN_OPENER_PATTERN and
    // QN_OPENER_PATTERN_NONCAPTURING. Present nowhere else — the terminator
    // starts with `(?=(?:\\n(?:(?:#{1,6}` (no `^` alternation).
    // String.raw preserves backslashes so the search string exactly matches
    // the file's `\\n` (two literal characters: backslash + n).
    const needle = String.raw`(?:^|\\n)(?:(?:#{1,6}`;
    const occurrences = src.split(needle).length - 1;
    expect(occurrences).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T024: End-to-end integration test per contract §integrateClarificationAnswers
// ---------------------------------------------------------------------------
describe('integrateClarificationAnswers — cockpit end-to-end (#949, T024)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('integrates 2 cockpit answers with rationale-line joins and no FR-004 warn', async () => {
    // Two-pending-question clarifications file matching the contract example.
    const clarifications = `# Clarifications

### Q1: Rationale-line inclusion
**Answer**: *Pending*

### Q2: Opener strictness
**Answer**: *Pending*
`;
    mockReaddirSync.mockReturnValue(['949-cockpit']);
    mockReadFileSync.mockReturnValue(clarifications);

    const cockpitBody = `<!-- generacy-cockpit:clarification-answers -->

### Q1
**Answer:** A — Use the sealed file backend
**Rationale:** It avoids a cloud round-trip.

### Q2
**Answer:** A
**Rationale:** Heading requirement is safest.`;

    const context = createWorkerContext({
      item: {
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 949,
        workflowName: 'speckit-bugfix',
        command: 'process',
        priority: Date.now(),
        enqueuedAt: new Date().toISOString(),
      },
    });
    const logger = createMockLogger();

    (context.github.getIssueComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 949100,
        body: cockpitBody,
        author: 'operator',
        authorAssociation: 'OWNER',
        created_at: '',
        updated_at: '',
      },
    ]);

    const result = await integrateClarificationAnswers(context, logger);

    // (a) integrated: 2
    expect(result.integrated).toBe(2);

    // (b) persisted file content has both answers with Rationale: joined.
    const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(writtenContent).toContain(
      '**Answer**: A — Use the sealed file backend\nRationale: It avoids a cloud round-trip.',
    );
    expect(writtenContent).toContain(
      '**Answer**: A\nRationale: Heading requirement is safest.',
    );

    // (c) FR-004 warn MUST NOT fire (Q5→C negative pin).
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of warnCalls) {
      const payload = call[0] as Record<string, unknown> | undefined;
      expect(payload?.code).not.toBe('TRANSITION_WITH_QUESTION_HEADINGS');
    }
  });
});
