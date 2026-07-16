/**
 * #958 SC-002 — human quote-reply table test.
 *
 * Runs the four required rows from spec §"Observed B":
 *   1. plain `Q1: A` / `Q2: B`                                 → 2 integrated
 *   2. GitHub "Quote reply" (quoted `> ### Q2:` bounds Q1)     → 2 integrated
 *   3. answer restating the question inline                     → 1+ integrated
 *   4. `**Q1**: A` / `**Q2**: B`                                → 2 integrated
 *
 * Prose and numbered-list forms remain best-effort and are NOT asserted
 * (spec §Out of Scope, SC-002 fine print).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { integrateClarificationAnswers } from '../clarification-poster.js';
import type { WorkerContext, Logger } from '../types.js';

const mockReaddirSync = vi.fn<(path: string) => string[]>();
const mockReadFileSync = vi.fn<(path: string, encoding: string) => string>();
const mockWriteFileSync = vi.fn<(path: string, content: string) => void>();

vi.mock('node:fs', () => ({
  readdirSync: (p: string) => mockReaddirSync(p),
  readFileSync: (p: string, e: string) => mockReadFileSync(p, e),
  writeFileSync: (p: string, c: string) => mockWriteFileSync(p, c),
}));

vi.mock('@generacy-ai/workflow-engine', async () => {
  const actual = await vi.importActual<typeof import('@generacy-ai/workflow-engine')>(
    '@generacy-ai/workflow-engine',
  );
  return { ...actual, tryLoadCommentTrustConfig: vi.fn(() => undefined) };
});

const TWO_QUESTIONS_MD = `# Clarification Questions
## Status: Pending
## Questions
### Q1: One
**Context**: X.
**Question**: A?

**Answer**: *Pending*

### Q2: Two
**Context**: Y.
**Question**: B?

**Answer**: *Pending*
`;

function createLogger(): Logger {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  } as unknown as Logger;
  return logger;
}

function createContext(comments: Array<Record<string, unknown>>): WorkerContext {
  const github = {
    addIssueComment: vi.fn().mockResolvedValue({ id: 999, body: '' }),
    getIssueComments: vi.fn().mockResolvedValue([]),
    getIssueCommentsWithViewerAuth: vi.fn().mockResolvedValue(comments),
  };
  return {
    workerId: 'w-1',
    jobId: 'job-1',
    item: {
      owner: 'owner',
      repo: 'repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
      command: 'process',
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
    },
    startPhase: 'clarify',
    github: github as unknown as WorkerContext['github'],
    logger: createLogger(),
    signal: new AbortController().signal,
    checkoutPath: '/tmp/test-checkout',
    issueUrl: 'https://github.com/owner/repo/issues/42',
    description: 'Test issue',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReaddirSync.mockReturnValue(['42-test-feature']);
  mockReadFileSync.mockReturnValue(TWO_QUESTIONS_MD);
});

interface Row {
  name: string;
  body: string;
  expectedAnswers: Record<number, string>;
}

const ROWS: Row[] = [
  {
    name: 'plain Q1: A / Q2: B',
    body: 'Q1: OAuth\nQ2: JWT',
    expectedAnswers: { 1: 'OAuth', 2: 'JWT' },
  },
  {
    name: 'GitHub Quote reply — quoted Q2 bounds Q1',
    body:
      'Q1: OAuth\n' +
      '\n' +
      '> ### Q2: Two\n' +
      '> **Question**: B?\n' +
      '\n' +
      'Q2: JWT',
    expectedAnswers: { 1: 'OAuth', 2: 'JWT' },
  },
  {
    name: 'inline restatement — quoted question follows answer',
    body:
      'Q1: OAuth\n' +
      '\n' +
      '> **Question**: A?\n' +
      '\n' +
      'Q2: JWT',
    expectedAnswers: { 1: 'OAuth', 2: 'JWT' },
  },
  {
    name: '**Q1**: A / **Q2**: B',
    body: '**Q1**: OAuth\n**Q2**: JWT',
    expectedAnswers: { 1: 'OAuth', 2: 'JWT' },
  },
];

describe('#958 SC-002 — human quote-reply integration table', () => {
  it.each(ROWS)('$name → integrates every answered question', async (row) => {
    const context = createContext([
      {
        id: 1,
        body: row.body,
        // Human — OWNER tier is trusted by the answer-scanner.
        author: 'chris',
        authorAssociation: 'OWNER',
        viewerDidAuthor: false,
        created_at: '',
      },
    ]);
    const logger = createLogger();

    const result = await integrateClarificationAnswers(context, logger);
    const expected = Object.keys(row.expectedAnswers).length;

    expect(result.integrated).toBe(expected);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const written = mockWriteFileSync.mock.calls[0]![1] as string;
    for (const [qnum, ans] of Object.entries(row.expectedAnswers)) {
      // Section-scoped match — the written Answer for Q<n> starts with the
      // expected value.
      expect(written).toMatch(
        new RegExp(`### Q${qnum}:[^]*?\\*\\*Answer\\*\\*: ${ans}`),
      );
    }
  });
});
