/**
 * #910 SC-008: retry-once + fail-closed behavior for
 * `integrateClarificationAnswers` after migration to
 * `getIssueCommentsWithViewerAuth` (FR-010).
 *
 *   (a) mock throws once then resolves → answers still ingested on the retry,
 *       one `warn` log with "retrying once", NO REST call issued.
 *   (b) mock throws twice → integrated == 0, warn with "failing closed",
 *       NO REST call issued (proves no silent REST fallback).
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

function createContext(github: unknown): WorkerContext {
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
    github: github as WorkerContext['github'],
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

describe('SC-008 retry-once success path', () => {
  it('throws once then resolves — answers still ingested on retry, one retry warn, NO REST call', async () => {
    // #958 FR-003 — a viewerDidAuthor=true comment must carry the engine
    // answer marker to be an answer source. Add the marker to keep this
    // #910 retry regression test passing under the new authorship gate.
    const answerMarker = '<!-- generacy-clarification-answers:1 ts=2026-07-16T00:00:00.000Z -->';
    const successPayload = [
      {
        id: 1,
        body: `${answerMarker}\n\nQ1: OAuth 2.0`,
        author: 'cluster',
        authorAssociation: 'NONE',
        viewerDidAuthor: true,
        created_at: '',
        updated_at: '',
      },
    ];
    const getIssueCommentsWithViewerAuth = vi
      .fn()
      .mockRejectedValueOnce(new Error('graphql transient blip'))
      .mockResolvedValueOnce(successPayload);
    const getIssueComments = vi.fn().mockResolvedValue([]);
    const github = {
      addIssueComment: vi.fn().mockResolvedValue({ id: 999, body: '' }),
      getIssueComments,
      getIssueCommentsWithViewerAuth,
    };
    const context = createContext(github);
    const logger = createMockLogger();

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBeGreaterThanOrEqual(1);
    expect(getIssueCommentsWithViewerAuth).toHaveBeenCalledTimes(2);
    // Critical: no REST fallback.
    expect(getIssueComments).not.toHaveBeenCalled();

    // One "retrying once" warn on the first failure.
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const retryWarns = warnCalls.filter(([, msg]) =>
      typeof msg === 'string' && /retrying once/.test(msg),
    );
    expect(retryWarns.length).toBe(1);
    expect(retryWarns[0]![0]).toEqual(
      expect.objectContaining({ error: expect.stringMatching(/graphql transient blip/) }),
    );

    // No "failing closed" warn because the retry succeeded.
    const failWarns = warnCalls.filter(([, msg]) =>
      typeof msg === 'string' && /failing closed/.test(msg),
    );
    expect(failWarns.length).toBe(0);
  });
});

describe('SC-008 fail-closed path', () => {
  it('throws twice — integrated == 0, fail-closed warn logged, NO REST call issued', async () => {
    const getIssueCommentsWithViewerAuth = vi
      .fn()
      .mockRejectedValueOnce(new Error('graphql failure 1'))
      .mockRejectedValueOnce(new Error('graphql failure 2'));
    const getIssueComments = vi.fn().mockResolvedValue([]);
    const github = {
      addIssueComment: vi.fn().mockResolvedValue({ id: 999, body: '' }),
      getIssueComments,
      getIssueCommentsWithViewerAuth,
    };
    const context = createContext(github);
    const logger = createMockLogger();

    const result = await integrateClarificationAnswers(context, logger);

    expect(result.integrated).toBe(0);
    expect(result.reason).toBe('no-answers');
    expect(getIssueCommentsWithViewerAuth).toHaveBeenCalledTimes(2);
    // Critical: proves no silent REST fallback.
    expect(getIssueComments).not.toHaveBeenCalled();

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const retryWarns = warnCalls.filter(([, msg]) =>
      typeof msg === 'string' && /retrying once/.test(msg),
    );
    expect(retryWarns.length).toBe(1);

    const failWarns = warnCalls.filter(([, msg]) =>
      typeof msg === 'string' && /failing closed/.test(msg),
    );
    expect(failWarns.length).toBe(1);
    expect(failWarns[0]![0]).toEqual(
      expect.objectContaining({ error: expect.stringMatching(/graphql failure 2/) }),
    );
  });
});
