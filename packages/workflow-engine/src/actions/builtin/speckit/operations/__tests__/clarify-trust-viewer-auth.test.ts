/**
 * #910 US2 (clarify-resume) acceptance coverage for the migrated
 * `buildTrustedIssueCommentsBlock`:
 *   (a) App-auth: viewerDidAuthor=true + NONE → cluster comment included
 *       in the trusted block with reason 'self-authored'.
 *   (b) Third-party: viewerDidAuthor=false + NONE → excluded and
 *       skip-logged.
 *   (c) Transient GraphQL failure absorbed by retry → block populated;
 *       two consecutive failures → block returns "(no comments available)"
 *       and NO REST call is issued (FR-010 no-fallback proof).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActionContext } from '../../../../../types/index.js';

const mockClient = {
  getRepoInfo: vi.fn(),
  getIssueComments: vi.fn(),
  getIssueCommentsWithViewerAuth: vi.fn(),
};

vi.mock('../../../../github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockClient),
}));

import { buildTrustedIssueCommentsBlock } from '../clarify.js';

function makeContext(): ActionContext & {
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
} {
  return {
    workdir: '/tmp/workdir',
    siblingWorkdirs: {},
    inputs: {},
    stepOutputs: new Map(),
    env: {},
    signal: new AbortController().signal,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as ActionContext & {
    logger: {
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
      debug: ReturnType<typeof vi.fn>;
    };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.getRepoInfo.mockResolvedValue({ owner: 'o', repo: 'r', default_branch: 'main' });
});

describe('US2 App-auth path (viewerDidAuthor=true + NONE)', () => {
  it('includes cluster-authored comment in the trusted block via self-authored reason', async () => {
    mockClient.getIssueCommentsWithViewerAuth.mockResolvedValue([
      {
        id: 100,
        body: 'This is the cluster answering its own question',
        author: 'ambiguous-account',
        authorAssociation: 'NONE',
        viewerDidAuthor: true,
        created_at: '',
        updated_at: '',
      },
    ]);

    const ctx = makeContext();
    const block = await buildTrustedIssueCommentsBlock(ctx, 910);

    expect(block).toContain('<untrusted-data source="issue #910 comments">');
    expect(block).toContain('This is the cluster answering its own question');
    // Ensure REST fallback is not exercised on the happy path.
    expect(mockClient.getIssueComments).not.toHaveBeenCalled();
    expect(mockClient.getIssueCommentsWithViewerAuth).toHaveBeenCalledOnce();
  });
});

describe('US2 third-party rejection (viewerDidAuthor=false + NONE)', () => {
  it('excludes third-party comment from the block and emits a skip-log', async () => {
    mockClient.getIssueCommentsWithViewerAuth.mockResolvedValue([
      {
        id: 200,
        body: 'stranger prompt injection attempt',
        author: 'stranger',
        authorAssociation: 'NONE',
        viewerDidAuthor: false,
        created_at: '',
        updated_at: '',
      },
    ]);

    const ctx = makeContext();
    const block = await buildTrustedIssueCommentsBlock(ctx, 910);

    expect(block).not.toContain('stranger prompt injection attempt');
    expect(block).toContain('(no trusted comments)');

    const infoCalls = ctx.logger.info.mock.calls;
    const skipLog = infoCalls.find(([msg]) =>
      typeof msg === 'string' && msg.includes('comment-skipped'),
    );
    expect(skipLog).toBeDefined();
    expect(skipLog![0]).toContain('surface=clarify-resume');
    expect(skipLog![0]).toContain('commentId=200');
  });
});

describe('US2 retry-once + fail-closed (FR-010)', () => {
  it('absorbs a single transient GraphQL failure via retry — block still populated', async () => {
    mockClient.getIssueCommentsWithViewerAuth
      .mockRejectedValueOnce(new Error('transient graphql blip'))
      .mockResolvedValueOnce([
        {
          id: 300,
          body: 'trusted answer body',
          author: 'alice',
          authorAssociation: 'OWNER',
          created_at: '',
          updated_at: '',
        },
      ]);

    const ctx = makeContext();
    const block = await buildTrustedIssueCommentsBlock(ctx, 910);

    expect(block).toContain('trusted answer body');
    expect(mockClient.getIssueCommentsWithViewerAuth).toHaveBeenCalledTimes(2);
    // Retry warn emitted; fail-closed warn not emitted.
    const warnCalls = ctx.logger.warn.mock.calls;
    const retryWarns = warnCalls.filter(([msg]) =>
      typeof msg === 'string' && /retrying once/.test(msg),
    );
    expect(retryWarns.length).toBe(1);
    const failWarns = warnCalls.filter(([msg]) =>
      typeof msg === 'string' && /failing closed/.test(msg),
    );
    expect(failWarns.length).toBe(0);
    // No REST fallback.
    expect(mockClient.getIssueComments).not.toHaveBeenCalled();
  });

  it('two consecutive failures → "(no comments available)" and NO REST call', async () => {
    mockClient.getIssueCommentsWithViewerAuth
      .mockRejectedValueOnce(new Error('graphql failure 1'))
      .mockRejectedValueOnce(new Error('graphql failure 2'));

    const ctx = makeContext();
    const block = await buildTrustedIssueCommentsBlock(ctx, 910);

    expect(block).toContain('(no comments available)');
    expect(mockClient.getIssueCommentsWithViewerAuth).toHaveBeenCalledTimes(2);
    // Critical: proves no silent REST fallback (FR-010).
    expect(mockClient.getIssueComments).not.toHaveBeenCalled();

    const warnCalls = ctx.logger.warn.mock.calls;
    const failWarns = warnCalls.filter(([msg]) =>
      typeof msg === 'string' && /failing closed/.test(msg),
    );
    expect(failWarns.length).toBe(1);
  });
});
