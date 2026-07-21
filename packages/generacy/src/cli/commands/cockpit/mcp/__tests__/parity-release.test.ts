import { describe, expect, it } from 'vitest';
import { FakeGh, makeIssue, makePr } from '../../__tests__/helpers/fake-gh.js';
import { cockpitRelease } from '../tools/cockpit_release.js';
import { ClaimMockGh } from '../claim/__tests__/helpers/mock-gh.js';
import { formatMarker } from '../claim/marker.js';
import { CLAIM_LABEL } from '../claim/discover.js';
import type { ClaimPayload } from '../claim/payload.js';

const NOW = new Date('2026-07-21T14:47:00.000Z');
const SESSION_A = '9e5c8a0d755e40b3';
const SESSION_B = 'ab12cd34ef56789a';
const OWNER = 'generacy-ai';
const REPO_NAME = 'generacy';
const NUMBER = 1015;
const NWO = `${OWNER}/${REPO_NAME}`;

function payloadFor(session: string, overrides: Partial<ClaimPayload> = {}): ClaimPayload {
  return {
    version: 1,
    sessionId: session,
    heldSince: '2026-07-21T14:00:00.000Z',
    heartbeatAt: '2026-07-21T14:46:00.000Z',
    ledger: `.generacy/cockpit/auto-runs/${session}.ledger`,
    scope: `${NWO}#${NUMBER}`,
    ...overrides,
  };
}

function ghWithIssueKind(kind: 'issue' | 'pr', claimMock: ClaimMockGh): FakeGh {
  const gh = new FakeGh({});
  const claimGh = claimMock.build();
  (gh as unknown as Record<string, unknown>).getIssue = async (
    repo: string,
    number: number,
  ) => {
    return kind === 'pr'
      ? makePr({ number, ...({} as never) })
      : makeIssue({ number, url: `https://github.com/${repo}/issues/${number}` });
  };
  (gh as unknown as Record<string, unknown>).fetchIssueLabels =
    claimGh.fetchIssueLabels.bind(claimGh);
  (gh as unknown as Record<string, unknown>).fetchIssueComments =
    claimGh.fetchIssueComments.bind(claimGh);
  (gh as unknown as Record<string, unknown>).deleteIssueComment =
    claimGh.deleteIssueComment.bind(claimGh);
  (gh as unknown as Record<string, unknown>).removeLabels =
    claimGh.removeLabels.bind(claimGh);
  return gh;
}

describe('cockpit_release parity (#1015)', () => {
  it('missing sessionId → invalid-args', async () => {
    const result = await cockpitRelease(
      {
        scope: { owner: OWNER, repo: REPO_NAME, number: NUMBER },
      } as never,
      {},
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('PR scope → wrong-kind', async () => {
    const claim = new ClaimMockGh();
    const gh = ghWithIssueKind('pr', claim);
    const result = await cockpitRelease(
      {
        scope: { owner: OWNER, repo: REPO_NAME, number: NUMBER },
        sessionId: SESSION_A,
      },
      { gh, now: () => NOW },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('wrong-kind');
  });

  it('happy released: caller holds → action: released', async () => {
    const claim = new ClaimMockGh();
    claim.seedComment(NWO, NUMBER, formatMarker(payloadFor(SESSION_A)));
    claim.seedLabel(NWO, NUMBER, CLAIM_LABEL);
    const gh = ghWithIssueKind('issue', claim);

    const result = await cockpitRelease(
      {
        scope: { owner: OWNER, repo: REPO_NAME, number: NUMBER },
        sessionId: SESSION_A,
      },
      { gh, now: () => NOW },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.action).toBe('released');
    expect(result.data.releasedClaim?.sessionId).toBe(SESSION_A);
  });

  it('not-holder returned as success (never error)', async () => {
    const claim = new ClaimMockGh();
    claim.seedComment(NWO, NUMBER, formatMarker(payloadFor(SESSION_B)));
    claim.seedLabel(NWO, NUMBER, CLAIM_LABEL);
    const gh = ghWithIssueKind('issue', claim);

    const result = await cockpitRelease(
      {
        scope: { owner: OWNER, repo: REPO_NAME, number: NUMBER },
        sessionId: SESSION_A,
      },
      { gh, now: () => NOW },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.action).toBe('not-holder');
    expect(result.data.currentHolder?.sessionId).toBe(SESSION_B);
  });

  it('no-claim returned as success', async () => {
    const claim = new ClaimMockGh();
    const gh = ghWithIssueKind('issue', claim);

    const result = await cockpitRelease(
      {
        scope: { owner: OWNER, repo: REPO_NAME, number: NUMBER },
        sessionId: SESSION_A,
      },
      { gh, now: () => NOW },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.action).toBe('no-claim');
  });
});
