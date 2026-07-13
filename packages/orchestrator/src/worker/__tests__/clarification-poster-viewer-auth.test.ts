/**
 * #910 regression coverage for the answer-scanner surface after migrating
 * from REST `getIssueComments()` to GraphQL
 * `getIssueCommentsWithViewerAuth()`. Covers SC-001..SC-005 + SC-009.
 *
 *   - SC-001 App-auth: viewerDidAuthor=true + NONE → trusted self-authored,
 *     integrated >= 1.
 *   - SC-004 Personal-auth: env CLUSTER_GITHUB_USERNAME set, botLogin
 *     matches → trusted via `reason: bot`, no new warns.
 *   - SC-003 Third-party: viewerDidAuthor=false + NONE + stranger login →
 *     untrusted, integrated == 0.
 *   - SC-005 + SC-009 Question-marker regression: a self-authored comment
 *     carrying the questions marker → filtered by isQuestionComment before
 *     parseAnswersFromComments (integrated == 0 on a marker-only fixture).
 *
 * FR-007 permanent regression check — this file makes future #51 reverts
 * fail CI forever.
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

// Use the REAL trust helper for these integration tests — the migration is
// the whole point.
vi.mock('@generacy-ai/workflow-engine', async () => {
  const actual = await vi.importActual<typeof import('@generacy-ai/workflow-engine')>(
    '@generacy-ai/workflow-engine',
  );
  return {
    ...actual,
    tryLoadCommentTrustConfig: vi.fn(() => undefined),
  };
});

const CLARIFICATIONS_MD = `# Clarification Questions
## Status: Pending
## Questions
### Q1: Authentication method
**Context**: The spec mentions user auth but doesn't specify OAuth vs JWT.
**Question**: Which auth?

**Answer**: *Pending*
`;

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

function createMockGithub(comments: Array<Record<string, unknown>>) {
  const getIssueCommentsWithViewerAuth = vi.fn().mockResolvedValue(comments);
  return {
    addIssueComment: vi.fn().mockResolvedValue({ id: 999, body: '' }),
    // REST fallback should never fire on the migrated path — assertion below.
    getIssueComments: vi.fn().mockResolvedValue([]),
    getIssueCommentsWithViewerAuth,
  };
}

function createContext(github: ReturnType<typeof createMockGithub>): WorkerContext {
  return {
    workerId: 'w-1',
    jobId: 'job-1',
    item: {
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
      command: 'process',
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
    },
    startPhase: 'clarify',
    github: github as unknown as WorkerContext['github'],
    logger: createMockLogger(),
    signal: new AbortController().signal,
    checkoutPath: '/tmp/test-checkout',
    issueUrl: 'https://github.com/test-owner/test-repo/issues/42',
    description: 'Test issue',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReaddirSync.mockReturnValue(['42-test-feature']);
  mockReadFileSync.mockReturnValue(CLARIFICATIONS_MD);
});

describe('SC-001 / SC-002 App-auth self-authored path', () => {
  it('trusts a viewerDidAuthor=true + NONE comment (App-identity cluster answer)', async () => {
    const github = createMockGithub([
      {
        id: 1,
        body: 'Q1: OAuth 2.0',
        author: 'random-account',
        authorAssociation: 'NONE',
        viewerDidAuthor: true,
        created_at: '',
        updated_at: '',
      },
    ]);
    const context = createContext(github);
    const logger = createMockLogger();

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBeGreaterThanOrEqual(1);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const written = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(written).toContain('**Answer**: OAuth 2.0');
    // Migrated path must not fall through to REST `getIssueComments`
    // (FR-010 / FR-002 — no silent REST fallback).
    expect(github.getIssueComments).not.toHaveBeenCalled();
    expect(github.getIssueCommentsWithViewerAuth).toHaveBeenCalledOnce();
  });
});

describe('SC-004 Personal-auth path (bot-login match)', () => {
  it('trusts a comment authored by the bot login even when viewerDidAuthor=false', async () => {
    process.env['CLUSTER_GITHUB_USERNAME'] = 'cluster-bot';
    try {
      const github = createMockGithub([
        {
          id: 1,
          body: 'Q1: OAuth 2.0',
          author: 'cluster-bot',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '',
          updated_at: '',
        },
      ]);
      const context = createContext(github);
      const logger = createMockLogger();

      const result = await integrateClarificationAnswers(context, logger);

      expect(result.integrated).toBeGreaterThanOrEqual(1);
      // The bot-login path (decision 1) fires before viewerDidAuthor's warn
      // check — no viewerDidAuthor warn should surface. See #910 SC-006.
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const drift = warnCalls.filter(([first]) => {
        if (typeof first === 'string') return /viewerDidAuthor missing/.test(first);
        if (first && typeof first === 'object') {
          const obj = first as Record<string, unknown>;
          return typeof obj.msg === 'string' && /viewerDidAuthor missing/.test(obj.msg);
        }
        return false;
      });
      expect(drift.length).toBe(0);
    } finally {
      delete process.env['CLUSTER_GITHUB_USERNAME'];
    }
  });
});

describe('SC-003 Third-party path', () => {
  it('rejects viewerDidAuthor=false + NONE + stranger login', async () => {
    const github = createMockGithub([
      {
        id: 1,
        body: 'Q1: attacker attempt',
        author: 'stranger',
        authorAssociation: 'NONE',
        viewerDidAuthor: false,
        created_at: '',
        updated_at: '',
      },
    ]);
    const context = createContext(github);
    const logger = createMockLogger();

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-answers');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe('SC-005 + SC-009 Question-marker regression (FR-007 permanent check)', () => {
  it('excludes a self-authored questions-marker comment from parseAnswersFromComments', async () => {
    // Two self-authored comments:
    // (a) the bot's questions comment carrying the marker — must be filtered
    //     by isQuestionComment BEFORE parseAnswersFromComments.
    // (b) a self-authored answers comment — must reach parseAnswersFromComments
    //     and integrate.
    const marker = clarificationMarker(42);
    const github = createMockGithub([
      {
        id: 1,
        body: `${marker}\n### Q1: Authentication method\nWhich auth?`,
        author: 'cluster-bot',
        authorAssociation: 'NONE',
        viewerDidAuthor: true,
        created_at: '',
        updated_at: '',
      },
      {
        id: 2,
        body: 'Q1: OAuth 2.0',
        author: 'cluster-bot',
        authorAssociation: 'NONE',
        viewerDidAuthor: true,
        created_at: '',
        updated_at: '',
      },
    ]);
    const context = createContext(github);
    const logger = createMockLogger();

    const result = await integrateClarificationAnswers(context, logger);

    // Only comment #2 reaches parseAnswersFromComments; comment #1 (marker)
    // is filtered out by isQuestionComment.
    expect(result.integrated).toBe(1);
    const written = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(written).toContain('**Answer**: OAuth 2.0');
  });

  it('marker-only fixture: integrated == 0 (SC-009 injected-drift permanent check)', async () => {
    // A single self-authored comment carrying ONLY the questions marker —
    // no separate answers comment. If isQuestionComment is ever removed or
    // moved after parseAnswersFromComments (a #51 revert), this test fails
    // because the marker comment would leak in and its `### Q<n>:` heading
    // would be treated as an answer.
    const marker = clarificationMarker(42);
    const github = createMockGithub([
      {
        id: 1,
        body: `${marker}\n### Q1: Authentication method\nWhich auth?\n\nQ1: LEAKED_HEADING_TEXT`,
        author: 'cluster-bot',
        authorAssociation: 'NONE',
        viewerDidAuthor: true,
        created_at: '',
        updated_at: '',
      },
    ]);
    const context = createContext(github);
    const logger = createMockLogger();

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe('FR-007 ordering invariant: isQuestionComment before parseAnswersFromComments (T014)', () => {
  // Regression: makes it impossible to move `isQuestionComment` after
  // `parseAnswersFromComments` OR remove the filter entirely without
  // breaking this test. If the filter is removed, the marker-carrying
  // comment's `Q1: …` line inside the questions block would parse as an
  // answer and `integrated` would be 1 or more.
  //
  // Sibling to the SC-005 marker-only test above. That test uses only
  // marker text; this one uses BOTH a valid `Q<n>:` inline in the marker
  // comment AND a distinct real answer, so the invariant is exercised on
  // the ordering itself — the filter must strip the marker comment before
  // parsing, and the real answer must still integrate.
  it('marker-carrying self-authored comment is filtered out even when it contains a plausible Q1 answer', async () => {
    const marker = clarificationMarker(42);
    const github = createMockGithub([
      {
        // (1) Marker-carrying self-authored comment. If the filter is
        // removed, its body's `Q1: BOGUS_MARKER_ANSWER` would parse as
        // the answer, overwriting the real answer below.
        id: 1,
        body: `${marker}\n### Q1: Authentication\n**Question**: Which auth?\n\nQ1: BOGUS_MARKER_ANSWER`,
        author: 'cluster-bot',
        authorAssociation: 'NONE',
        viewerDidAuthor: true,
        created_at: '2026-07-10T00:00:00Z',
        updated_at: '2026-07-10T00:00:00Z',
      },
      {
        // (2) Distinct self-authored answer comment posted later.
        id: 2,
        body: 'Q1: REAL_ANSWER_OAUTH2',
        author: 'cluster-bot',
        authorAssociation: 'NONE',
        viewerDidAuthor: true,
        created_at: '2026-07-10T00:01:00Z',
        updated_at: '2026-07-10T00:01:00Z',
      },
    ]);
    const context = createContext(github);
    const logger = createMockLogger();

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(1);
    const written = mockWriteFileSync.mock.calls[0]![1] as string;
    // The real answer wins — proves the marker comment was filtered out.
    expect(written).toContain('**Answer**: REAL_ANSWER_OAUTH2');
    expect(written).not.toContain('BOGUS_MARKER_ANSWER');
  });
});

describe('SC-006 no shape-drift warn on healthy self-authored comments', () => {
  it('does NOT emit "viewerDidAuthor missing/non-boolean" when field is populated (true)', async () => {
    const github = createMockGithub([
      {
        id: 1,
        body: 'Q1: OAuth 2.0',
        author: 'cluster',
        authorAssociation: 'NONE',
        viewerDidAuthor: true,
        created_at: '',
        updated_at: '',
      },
    ]);
    const context = createContext(github);
    const logger = createMockLogger();

    await integrateClarificationAnswers(context, logger);

    const engineWarnCalls = (context.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const drift = engineWarnCalls.filter(([first]) => {
      // engine's warn arg is a Record, worker-side pino uses (meta, msg)
      if (typeof first === 'string') return /viewerDidAuthor missing/.test(first);
      if (first && typeof first === 'object') {
        const obj = first as Record<string, unknown>;
        return Object.values(obj).some(
          (v) => typeof v === 'string' && /viewerDidAuthor missing/.test(v),
        );
      }
      return false;
    });
    expect(drift.length).toBe(0);
  });
});
