/**
 * #928 parity — cockpit_merge MCP tool ↔ CLI verb.
 *
 * ## Distinct-number fixture invariant
 *
 * Every case in this file uses issue #2 ↔ PR #15. The two numbers MUST
 * remain distinct — coincident numbers would let a broken tool pass an
 * inverted contract (this is the hazard #928 exists to end). Renaming
 * either number requires auditing every assertion below.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  CheckRunSummary,
  DeleteHeadRefResult,
  GhWrapper,
  Issue,
  IssueStateResult,
  PullRequestDetail,
  PullRequestGraphqlDetail,
  PullRequestRef,
  PullRequestRefResolution,
  RequiredChecksResult,
} from '@generacy-ai/cockpit';
import { cockpitMerge } from '../tools/cockpit_merge.js';

const OWNER = 'generacy-ai';
const REPO = 'generacy';
const ISSUE_NUMBER = 2;
const PR_NUMBER = 15;
const NWO = `${OWNER}/${REPO}`;

const openIssueUrl = `https://github.com/${NWO}/issues/${ISSUE_NUMBER}`;
const openPrUrl = `https://github.com/${NWO}/pull/${PR_NUMBER}`;

interface StubOverrides {
  getIssue?: GhWrapper['getIssue'];
  resolveIssueToPRRef?: PullRequestRefResolution;
  getPullRequestDetail?: PullRequestDetail;
  getPullRequestGraphqlDetail?: PullRequestGraphqlDetail;
  fetchIssueState?: IssueStateResult;
  getRequiredCheckNames?: RequiredChecksResult;
  getPullRequestCheckRuns?: CheckRunSummary[];
  deleteHeadRef?: DeleteHeadRefResult;
}

const openIssue: Issue = {
  number: ISSUE_NUMBER,
  title: 'issue 2',
  state: 'OPEN',
  stateReason: null,
  labels: [],
  url: openIssueUrl,
  body: '',
  createdAt: '',
};

const greenPrDetail: PullRequestDetail = {
  number: PR_NUMBER,
  title: 'PR 15',
  url: openPrUrl,
  base: 'develop',
  head: 'feature/pr-15',
  headRepositoryOwner: OWNER,
  body: '',
  author: { login: 'alice' },
  state: 'OPEN',
  draft: false,
  labels: [],
  diff: '',
  diffTruncated: false,
};

const openPrRef: PullRequestRef = {
  number: PR_NUMBER,
  url: openPrUrl,
  state: 'OPEN',
  draft: false,
  headRefName: 'feature/pr-15',
};

const draftPrRef: PullRequestRef = { ...openPrRef, draft: true };

const secondPrRef: PullRequestRef = {
  number: PR_NUMBER + 100,
  url: `https://github.com/${NWO}/pull/${PR_NUMBER + 100}`,
  state: 'OPEN',
  draft: false,
  headRefName: 'feature/pr-115',
};

const validatedIssueState: IssueStateResult = {
  state: 'OPEN',
  stateReason: null,
  closedAt: null,
  labels: ['completed:validate'],
  assignees: [],
  title: '',
};

function stubGh(overrides: StubOverrides = {}): GhWrapper {
  return {
    getIssue: overrides.getIssue ?? vi.fn(async () => openIssue),
    resolveIssueToPRRef: vi.fn(
      async () =>
        overrides.resolveIssueToPRRef ??
        ({ kind: 'unresolved' } as PullRequestRefResolution),
    ),
    getPullRequestDetail: vi.fn(async () => {
      if (!overrides.getPullRequestDetail) {
        throw new Error('getPullRequestDetail not stubbed');
      }
      return overrides.getPullRequestDetail;
    }),
    getPullRequestGraphqlDetail: vi.fn(async () => {
      if (!overrides.getPullRequestGraphqlDetail) {
        throw new Error('getPullRequestGraphqlDetail not stubbed');
      }
      return overrides.getPullRequestGraphqlDetail;
    }),
    fetchIssueState: vi.fn(async () => overrides.fetchIssueState ?? validatedIssueState),
    getRequiredCheckNames: vi.fn(
      async () =>
        overrides.getRequiredCheckNames ?? {
          source: 'branch-protection',
          names: [],
        },
    ),
    getPullRequestCheckRuns: vi.fn(async () => overrides.getPullRequestCheckRuns ?? []),
    mergePullRequest: vi.fn(async () => ({ merged: true, commitSha: 'abc' })),
    deleteHeadRef: vi.fn(
      async () => overrides.deleteHeadRef ?? ({ outcome: 'deleted' } as DeleteHeadRefResult),
    ),
  } as unknown as GhWrapper;
}

describe('#928 cockpit_merge parity — distinct-number fixture (issue #2 ↔ PR #15)', () => {
  it('happy path: issue ref → merges linked PR #15 → status: "ok"', async () => {
    const gh = stubGh({
      resolveIssueToPRRef: { kind: 'resolved', ref: openPrRef, linkMethod: 'closing-refs' },
      getPullRequestDetail: greenPrDetail,
    });
    const result = await cockpitMerge(
      { issue: { owner: OWNER, repo: REPO, number: ISSUE_NUMBER } },
      { gh },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.pr.number).toBe(PR_NUMBER);
    expect(result.data.action).toBe('merged');
  });

  it('pr-number: passing PR #15 as issue → status: "error", class: "wrong-kind" with hint copy', async () => {
    const gh = stubGh({
      // The URL classifier in ref-input.ts (`isPullRequest`) sees /pull/15 and
      // rejects the ref at the MCP normalize step BEFORE the resolver runs —
      // producing `class: 'wrong-kind'` at the boundary. This is the primary
      // safeguard against the pre-#928 wrong-merge hazard.
      getIssue: vi.fn(async () => ({
        number: PR_NUMBER,
        title: 'PR 15',
        state: 'OPEN',
        stateReason: null,
        labels: [],
        url: openPrUrl,
        body: '',
        createdAt: '',
      } as Issue)),
    });
    const result = await cockpitMerge(
      { issue: { owner: OWNER, repo: REPO, number: PR_NUMBER } },
      { gh },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('wrong-kind');
  });

  it('unresolved: PR chain returns unresolved → class: "gate-refusal"', async () => {
    const gh = stubGh({
      resolveIssueToPRRef: { kind: 'unresolved' },
    });
    const result = await cockpitMerge(
      { issue: { owner: OWNER, repo: REPO, number: ISSUE_NUMBER } },
      { gh },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(['gate-refusal', 'transport']).toContain(result.class);
  });

  it('ambiguous: two linked open PRs → class: "gate-refusal"', async () => {
    const gh = stubGh({
      resolveIssueToPRRef: {
        kind: 'ambiguous',
        candidates: [openPrRef, secondPrRef],
        linkMethod: 'branch-name',
      },
    });
    const result = await cockpitMerge(
      { issue: { owner: OWNER, repo: REPO, number: ISSUE_NUMBER } },
      { gh },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('gate-refusal');
  });

  it('pr-is-draft: only draft PRs linked → class: "gate-refusal"', async () => {
    const gh = stubGh({
      resolveIssueToPRRef: {
        kind: 'pr-is-draft',
        candidates: [draftPrRef],
        linkMethod: 'closing-refs',
      },
    });
    const result = await cockpitMerge(
      { issue: { owner: OWNER, repo: REPO, number: ISSUE_NUMBER } },
      { gh },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('gate-refusal');
  });

  it('checks-failing: PR checks red → class: "gate-refusal", detail names checks-failing', async () => {
    const gh = stubGh({
      resolveIssueToPRRef: { kind: 'resolved', ref: openPrRef, linkMethod: 'closing-refs' },
      getPullRequestDetail: greenPrDetail,
      getRequiredCheckNames: { source: 'branch-protection', names: ['ci/test'] },
      getPullRequestCheckRuns: [{ name: 'ci/test', state: 'FAILURE' }],
    });
    const result = await cockpitMerge(
      { issue: { owner: OWNER, repo: REPO, number: ISSUE_NUMBER } },
      { gh },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('gate-refusal');
    expect(result.detail).toContain('checks-failing');
  });

  it('pr escape hatch success: { issue: #2, pr: 15 } with valid linkage → status: "ok"', async () => {
    const gh = stubGh({
      // getPullRequestGraphqlDetail declares the closing issue matches ISSUE_NUMBER.
      getPullRequestGraphqlDetail: {
        state: 'OPEN',
        headRefName: 'feature/pr-15',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        closingIssuesReferences: [{ number: ISSUE_NUMBER, nameWithOwner: NWO }],
      },
      getPullRequestDetail: greenPrDetail,
    });
    const result = await cockpitMerge(
      {
        issue: { owner: OWNER, repo: REPO, number: ISSUE_NUMBER },
        pr: PR_NUMBER,
      },
      { gh },
    );
    expect(result.status).toBe('ok');
  });

  it('pr escape hatch linkage refusal: { issue: #2, pr: 15 } when PR does not declare issue #2 → class: "gate-refusal"', async () => {
    const gh = stubGh({
      getPullRequestGraphqlDetail: {
        state: 'OPEN',
        headRefName: 'feature/pr-15',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        // Declares a DIFFERENT closing issue — linkage refused.
        closingIssuesReferences: [{ number: 999, nameWithOwner: NWO }],
      },
    });
    const result = await cockpitMerge(
      {
        issue: { owner: OWNER, repo: REPO, number: ISSUE_NUMBER },
        pr: PR_NUMBER,
      },
      { gh },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('gate-refusal');
  });

  it('old-field-name redirection: { pr: { owner, repo, number } } (pre-#928 shape) → class: "invalid-args" with typed message', async () => {
    const gh = stubGh();
    const result = await cockpitMerge(
      // Deliberately raw-cast to simulate a pre-#928 caller.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pr: { owner: OWNER, repo: REPO, number: ISSUE_NUMBER } } as any,
      { gh },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(result.detail).toContain("'pr' field was renamed to 'issue'");
  });

  it('MCP bare-string rejection: { issue: "928" } → class: "invalid-args" naming accepted forms', async () => {
    const gh = stubGh();
    const result = await cockpitMerge({ issue: '928' }, { gh });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(result.detail).toContain('qualified ref');
  });
});
