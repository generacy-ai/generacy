/**
 * Integration tests for author-trust gating in the clarify answer-scanner
 * surface (#842). Covers FR-004, FR-013, SC-001, SC-003, SC-005, SC-007,
 * SC-009 (answer-scanner pinned).
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

// Use the REAL trust helper for these integration tests (per FR-004 spec).
// Override wrapUntrustedData only — it's unused here — to avoid pulling the
// whole module chain if the mock resolver misbehaves.
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

function createMockGithub(overrides: Record<string, unknown> = {}) {
  // #910: alias both getIssueComments (REST) and
  // getIssueCommentsWithViewerAuth (GraphQL) to a single vi.fn so existing
  // fixtures that mock `getIssueComments` continue to feed
  // `integrateClarificationAnswers`, which now uses the GraphQL variant.
  const getIssueComments =
    (overrides as { getIssueComments?: ReturnType<typeof vi.fn> }).getIssueComments
    ?? vi.fn().mockResolvedValue([]);
  return {
    addIssueComment: vi.fn().mockResolvedValue({ id: 999, body: '' }),
    getIssueComments,
    getIssueCommentsWithViewerAuth: getIssueComments,
    ...overrides,
    // ensure the alias survives spread if overrides only touched getIssueComments
    ...(overrides.getIssueComments ? { getIssueCommentsWithViewerAuth: overrides.getIssueComments } : {}),
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

describe('answer-scanner trust gating (FR-004, SC-001, SC-003)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReaddirSync.mockReturnValue(['42-test-feature']);
    mockReadFileSync.mockReturnValue(CLARIFICATIONS_MD);
  });

  it('drops NONE-authored Q<N>: answer from integration', async () => {
    const github = createMockGithub({
      getIssueComments: vi.fn().mockResolvedValue([
        {
          id: 1,
          body: 'Q1: OAuth 2.0',
          author: 'attacker',
          authorAssociation: 'NONE',
          created_at: '',
          updated_at: '',
        },
      ]),
    });
    const context = createContext(github);
    const logger = createMockLogger();

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-answers');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('emits exactly one FR-010 skip-log per skipped comment, with no body substring (SC-003)', async () => {
    const github = createMockGithub({
      getIssueComments: vi.fn().mockResolvedValue([
        {
          id: 12345,
          body: 'Q1: SECRET_PAYLOAD_SHOULD_NOT_BE_LOGGED',
          author: 'eve',
          authorAssociation: 'NONE',
          created_at: '',
          updated_at: '',
        },
      ]),
    });
    const context = createContext(github);
    const logger = createMockLogger();

    await integrateClarificationAnswers(context, logger);

    // Find skip-log entries.
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const skipLogs = infoCalls.filter(([first]) =>
      typeof first === 'object' && first !== null && (first as Record<string, unknown>).event === 'comment-skipped',
    );
    expect(skipLogs.length).toBe(1);

    const [meta] = skipLogs[0]!;
    const m = meta as Record<string, unknown>;
    expect(m.surface).toBe('answer-scanner');
    expect(m.commentId).toBe(12345);
    expect(m.author).toBe('eve');
    expect(m.authorAssociation).toBe('NONE');
    expect(m.reason).toBe('none-untrusted');
    // Body must not appear anywhere in the log record.
    expect(m.body).toBeUndefined();
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain('SECRET_PAYLOAD_SHOULD_NOT_BE_LOGGED');
  });

  it.each([
    ['OWNER', 'owner'],
    ['MEMBER', 'member'],
    ['COLLABORATOR', 'collaborator'],
  ])('passes %s answer through unmodified (SC-005)', async (tier) => {
    const github = createMockGithub({
      getIssueComments: vi.fn().mockResolvedValue([
        {
          id: 1,
          body: 'Q1: OAuth 2.0',
          author: 'alice',
          authorAssociation: tier,
          created_at: '',
          updated_at: '',
        },
      ]),
    });
    const context = createContext(github);
    const logger = createMockLogger();

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(1);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const written = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(written).toContain('**Answer**: OAuth 2.0');
  });

  it('passes bot-login answer through (identity chain via env)', async () => {
    process.env['CLUSTER_GITHUB_USERNAME'] = 'cluster-bot';
    try {
      const github = createMockGithub({
        getIssueComments: vi.fn().mockResolvedValue([
          {
            id: 1,
            body: 'Q1: OAuth 2.0',
            author: 'cluster-bot',
            authorAssociation: 'NONE',
            created_at: '',
            updated_at: '',
          },
        ]),
      });
      const context = createContext(github);
      const logger = createMockLogger();
      const result = await integrateClarificationAnswers(context, logger);
      expect(result.integrated).toBe(1);
    } finally {
      delete process.env['CLUSTER_GITHUB_USERNAME'];
    }
  });
});

describe('SC-009: widen-config does not affect answer-scanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReaddirSync.mockReturnValue(['42-test-feature']);
    mockReadFileSync.mockReturnValue(CLARIFICATIONS_MD);
  });

  it('does NOT trust CONTRIBUTOR on answer-scanner even with widen config', async () => {
    // Override the config loader to return a widen config for CONTRIBUTOR.
    const { tryLoadCommentTrustConfig } = await import('@generacy-ai/workflow-engine');
    (tryLoadCommentTrustConfig as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      widen: { tiers: ['CONTRIBUTOR'], logins: [] },
    });

    const github = createMockGithub({
      getIssueComments: vi.fn().mockResolvedValue([
        {
          id: 1,
          body: 'Q1: attempted answer',
          author: 'contrib',
          authorAssociation: 'CONTRIBUTOR',
          created_at: '',
          updated_at: '',
        },
      ]),
    });
    const context = createContext(github);
    const logger = createMockLogger();
    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-answers');
  });
});

describe('FR-013 / SC-007: bot explainer comment on Q<N>: skips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReaddirSync.mockReturnValue(['42-test-feature']);
    mockReadFileSync.mockReturnValue(CLARIFICATIONS_MD);
  });

  it('posts exactly one bot explainer comment for a NONE-authored Q<N>: answer', async () => {
    const github = createMockGithub({
      getIssueComments: vi.fn().mockResolvedValue([
        {
          id: 555,
          body: 'Q1: SECRET_BODY_NOT_TO_BE_ECHOED',
          author: 'eve',
          authorAssociation: 'NONE',
          created_at: '',
          updated_at: '',
        },
      ]),
    });
    const context = createContext(github);
    const logger = createMockLogger();

    await integrateClarificationAnswers(context, logger);

    const addIssueComment = github.addIssueComment as ReturnType<typeof vi.fn>;
    expect(addIssueComment).toHaveBeenCalledOnce();
    const [, , , body] = addIssueComment.mock.calls[0]!;
    // Marker present.
    expect(body).toContain('<!-- generacy-untrusted-answer:555 -->');
    // Author + tier called out.
    expect(body).toContain('@eve');
    expect(body).toContain('NONE');
    // Body substring NOT echoed (SC-007).
    expect(body).not.toContain('SECRET_BODY_NOT_TO_BE_ECHOED');
  });

  it('does NOT re-post if a comment with the same marker already exists (idempotence)', async () => {
    const alreadyMarker = '<!-- generacy-untrusted-answer:555 -->';
    const github = createMockGithub({
      getIssueComments: vi.fn().mockResolvedValue([
        {
          id: 555,
          body: 'Q1: attacker answer',
          author: 'eve',
          authorAssociation: 'NONE',
          created_at: '',
          updated_at: '',
        },
        // Pre-existing bot explainer.
        {
          id: 998,
          body: `${alreadyMarker}\n> Answers from @eve were not applied ...`,
          author: 'cluster-bot',
          authorAssociation: 'OWNER',
          created_at: '',
          updated_at: '',
        },
      ]),
    });
    const context = createContext(github);
    const logger = createMockLogger();

    await integrateClarificationAnswers(context, logger);

    expect(github.addIssueComment as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('does NOT post bot explainer for generic drive-by (no Q<N>: match)', async () => {
    const github = createMockGithub({
      getIssueComments: vi.fn().mockResolvedValue([
        {
          id: 777,
          body: 'just a hello world drive-by comment',
          author: 'eve',
          authorAssociation: 'NONE',
          created_at: '',
          updated_at: '',
        },
      ]),
    });
    const context = createContext(github);
    const logger = createMockLogger();
    await integrateClarificationAnswers(context, logger);

    expect(github.addIssueComment as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

    // But it still logs the skip (log-only for generic drive-bys).
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const skipLogs = infoCalls.filter(([first]) =>
      typeof first === 'object' && first !== null && (first as Record<string, unknown>).event === 'comment-skipped',
    );
    expect(skipLogs.length).toBe(1);
  });
});
