/**
 * #958 SC-001 — snappoll#7 replay regression.
 *
 * Setup: cluster (`viewerDidAuthor === true`) posts a 5-question comment
 * carrying the questions marker; no human reply follows. The pre-#958 code
 * "self-answered" its own questions because the L488 sniff misclassified
 * the questions comment as answers.
 *
 * Post-fix assertion: zero integrated answers. The self-authored comment is
 * excluded (lacks the answer marker per FR-003). Even without the marker
 * check, the question-marker pre-filter would drop it — but this test
 * specifically covers the case a self-authored comment without the answers
 * marker cannot become an answer source (authorship, not marker allowlist,
 * is the gate).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  integrateClarificationAnswers,
  clarificationMarker,
} from '../clarification-poster.js';
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

const FIVE_QUESTIONS_MD = `# Clarification Questions
## Status: Pending
## Questions
### Q1: Non-400 error handling
**Context**: The spec defines only \`201\` and \`400\` behavior.
**Question**: How to handle other errors?

**Answer**: *Pending*

### Q2: Rate limiting
**Context**: Missing.
**Question**: Rate limits?

**Answer**: *Pending*

### Q3: Auth method
**Context**: Missing.
**Question**: OAuth or JWT?

**Answer**: *Pending*

### Q4: Retry policy
**Context**: Missing.
**Question**: Retries?

**Answer**: *Pending*

### Q5: Logging level
**Context**: Missing.
**Question**: Verbosity?

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
      owner: 'christrudelpw',
      repo: 'snappoll',
      issueNumber: 7,
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
    issueUrl: 'https://github.com/christrudelpw/snappoll/issues/7',
    description: 'Test issue',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReaddirSync.mockReturnValue(['7-phase-3-core-functionality']);
  mockReadFileSync.mockReturnValue(FIVE_QUESTIONS_MD);
});

describe('#958 SC-001 — snappoll#7 self-answer regression', () => {
  it('cluster-self questions comment + no human reply → zero integrated', async () => {
    const marker = clarificationMarker(7);
    const questionsBody = `${marker}
## Clarification Questions

### Q1: Non-400 error handling
**Context**: The spec defines only \`201\` and \`400\` behavior.
**Question**: How to handle other errors?

### Q2: Rate limiting
**Question**: Rate limits?

### Q3: Auth method
**Question**: OAuth or JWT?

### Q4: Retry policy
**Question**: Retries?

### Q5: Logging level
**Question**: Verbosity?`;

    const context = createContext([
      {
        id: 4988133748,
        body: questionsBody,
        author: 'cluster-bot',
        authorAssociation: 'NONE',
        viewerDidAuthor: true,
        created_at: '2026-07-14T04:19:07Z',
      },
    ]);
    const logger = createLogger();

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    // Regression check: no `**Answer**:` field populated with question
    // restatement. The written file (if any) must not contain any of the
    // question texts as answers.
    expect(mockWriteFileSync.mock.calls).toHaveLength(0);
  });

  it('cluster-self answer WITHOUT engine marker → zero integrated (FR-003)', async () => {
    // Even if the cluster posts a bare `Q1: A` comment (no answer marker),
    // FR-003 requires the marker for viewerDidAuthor=true to be treated as
    // an answer source. This is the load-bearing correction to #910.
    const context = createContext([
      {
        id: 1,
        body: 'Q1: OAuth 2.0\nQ2: 100/min\nQ3: JWT\nQ4: exponential\nQ5: info',
        author: 'cluster-bot',
        authorAssociation: 'NONE',
        viewerDidAuthor: true,
        created_at: '',
      },
    ]);
    const logger = createLogger();

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('cluster-self answer WITH engine marker → integrated (FR-003 accept path)', async () => {
    // Sibling assertion — the marker IS what makes cluster-self answers
    // authoritative. This proves the gate is authorship + marker, not
    // authorship alone (which would still fail the human quote-reply flow)
    // and not marker alone (which would let human-quoted markers waltz in).
    const markerLine = '<!-- generacy-clarification-answers:1 actor=cockpit ts=2026-07-16T00:00:00.000Z -->';
    const context = createContext([
      {
        id: 1,
        body: `${markerLine}\n\n## Answers — batch 1\n\nQ1: OAuth 2.0`,
        author: 'cluster-bot',
        authorAssociation: 'NONE',
        viewerDidAuthor: true,
        created_at: '',
      },
    ]);
    const logger = createLogger();

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(1);
    const written = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(written).toContain('**Answer**: OAuth 2.0');
  });
});
