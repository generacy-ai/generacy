import { describe, expect, it } from 'vitest';
import { FakeGh, makeIssue, makePr } from '../../__tests__/helpers/fake-gh.js';
import { cockpitClaim } from '../tools/cockpit_claim.js';
import { ClaimMockGh } from '../claim/__tests__/helpers/mock-gh.js';
import { formatMarker } from '../claim/marker.js';
import { CLAIM_LABEL } from '../claim/discover.js';
import type { ClaimPayload } from '../claim/payload.js';

const NOW = new Date('2026-07-21T14:10:00.000Z');
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
    heartbeatAt: '2026-07-21T14:09:30.000Z',
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
  // Delegate the claim-relevant methods to the ClaimMockGh state.
  (gh as unknown as Record<string, unknown>).fetchIssueLabels =
    claimGh.fetchIssueLabels.bind(claimGh);
  (gh as unknown as Record<string, unknown>).fetchIssueComments =
    claimGh.fetchIssueComments.bind(claimGh);
  (gh as unknown as Record<string, unknown>).postIssueComment =
    claimGh.postIssueComment.bind(claimGh);
  (gh as unknown as Record<string, unknown>).editIssueComment =
    claimGh.editIssueComment.bind(claimGh);
  (gh as unknown as Record<string, unknown>).deleteIssueComment =
    claimGh.deleteIssueComment.bind(claimGh);
  (gh as unknown as Record<string, unknown>).addLabels = claimGh.addLabels.bind(claimGh);
  (gh as unknown as Record<string, unknown>).removeLabels =
    claimGh.removeLabels.bind(claimGh);
  return gh;
}

describe('cockpit_claim parity (#1015)', () => {
  it('happy-path acquire returns ok envelope with action + claim + commentUrl', async () => {
    const claim = new ClaimMockGh();
    const gh = ghWithIssueKind('issue', claim);
    const result = await cockpitClaim(
      {
        scope: { owner: OWNER, repo: REPO_NAME, number: NUMBER },
        sessionId: SESSION_A,
        ledger: '.generacy/cockpit/auto-runs/a.ledger',
        takeover: false,
      },
      { gh, now: () => NOW },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.action).toBe('acquired');
    expect(result.data.claim.sessionId).toBe(SESSION_A);
    expect(result.data.commentUrl).toMatch(/#issuecomment-\d+$/);
  });

  it('missing sessionId → class: invalid-args', async () => {
    const result = await cockpitClaim(
      {
        scope: { owner: OWNER, repo: REPO_NAME, number: NUMBER },
        ledger: '.ledger',
      } as never,
      {},
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('malformed sessionId (non-hex) → class: invalid-args', async () => {
    const result = await cockpitClaim(
      {
        scope: { owner: OWNER, repo: REPO_NAME, number: NUMBER },
        sessionId: 'NOT-HEX',
        ledger: '.ledger',
      } as never,
      {},
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('takeover non-boolean → class: invalid-args', async () => {
    const result = await cockpitClaim(
      {
        scope: { owner: OWNER, repo: REPO_NAME, number: NUMBER },
        sessionId: SESSION_A,
        ledger: '.ledger',
        takeover: 'yes',
      } as never,
      {},
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('unqualified string scope → class: invalid-args (via normalizeIssueRef)', async () => {
    const result = await cockpitClaim(
      {
        scope: 'not-a-ref-form',
        sessionId: SESSION_A,
        ledger: '.ledger',
      } as never,
      {},
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('scope resolves to a PR → class: wrong-kind', async () => {
    const claim = new ClaimMockGh();
    const gh = ghWithIssueKind('pr', claim);
    const result = await cockpitClaim(
      {
        scope: { owner: OWNER, repo: REPO_NAME, number: NUMBER },
        sessionId: SESSION_A,
        ledger: '.ledger',
        takeover: false,
      },
      { gh, now: () => NOW },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('wrong-kind');
  });

  it('claim-conflict returns exact detail + hint templates + populated holder', async () => {
    const claim = new ClaimMockGh();
    claim.seedComment(NWO, NUMBER, formatMarker(payloadFor(SESSION_B)));
    claim.seedLabel(NWO, NUMBER, CLAIM_LABEL);
    const gh = ghWithIssueKind('issue', claim);

    const result = await cockpitClaim(
      {
        scope: { owner: OWNER, repo: REPO_NAME, number: NUMBER },
        sessionId: SESSION_A,
        ledger: '.generacy/cockpit/auto-runs/a.ledger',
        takeover: false,
      },
      { gh, now: () => NOW },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('claim-conflict');
    const refusal = result as unknown as {
      detail: string;
      hint: string;
      holder: ClaimPayload;
      commentUrl: string;
    };
    // Exact templates per contracts/refusal-payload.md
    expect(refusal.detail).toBe(
      `scope ${NWO}#${NUMBER} is already claimed by session ${SESSION_B}` +
        ` (heartbeat 2026-07-21T14:09:30.000Z, ledger .generacy/cockpit/auto-runs/${SESSION_B}.ledger)`,
    );
    expect(refusal.hint).toBe(
      'retry with takeover: true, run /cockpit:auto ... --takeover, or accept the auto skill gate',
    );
    expect(refusal.holder.sessionId).toBe(SESSION_B);
    expect(refusal.commentUrl).toMatch(/#issuecomment-\d+$/);
  });

  it('takeover=true via MCP arg accepts and returns taken-over', async () => {
    const claim = new ClaimMockGh();
    claim.seedComment(NWO, NUMBER, formatMarker(payloadFor(SESSION_B)));
    claim.seedLabel(NWO, NUMBER, CLAIM_LABEL);
    const gh = ghWithIssueKind('issue', claim);

    const result = await cockpitClaim(
      {
        scope: { owner: OWNER, repo: REPO_NAME, number: NUMBER },
        sessionId: SESSION_A,
        ledger: '.generacy/cockpit/auto-runs/a.ledger',
        takeover: true,
      },
      { gh, now: () => NOW },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.action).toBe('taken-over');
    expect(result.data.displaced?.sessionId).toBe(SESSION_B);
  });
});
