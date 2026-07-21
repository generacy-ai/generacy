import { describe, expect, it } from 'vitest';
import { acquireClaim } from '../acquire.js';
import { discoverClaim, CLAIM_LABEL } from '../discover.js';
import { formatMarker } from '../marker.js';
import type { ClaimPayload } from '../payload.js';
import { ClaimMockGh } from './helpers/mock-gh.js';

const OWNER = 'owner';
const REPO_NAME = 'repo';
const REPO = 'owner/repo';
const ISSUE = 1015;
const NOW = new Date('2026-07-21T14:10:00.000Z');

const OUR_SESSION = 'aaaaaaaaaaaaaaaa';
const OTHER_SESSION = 'bbbbbbbbbbbbbbbb';

function ledgerPath(session: string): string {
  return `.generacy/cockpit/auto-runs/${session}.ledger`;
}

function payloadFor(
  session: string,
  overrides: Partial<ClaimPayload> = {},
): ClaimPayload {
  return {
    version: 1,
    sessionId: session,
    heldSince: '2026-07-21T14:00:00.000Z',
    heartbeatAt: '2026-07-21T14:09:30.000Z',
    ledger: ledgerPath(session),
    scope: `${REPO}#${ISSUE}`,
    ...overrides,
  };
}

describe('acquireClaim', () => {
  it('happy-path acquire: writes = post + label add', async () => {
    const mock = new ClaimMockGh();
    const gh = mock.build();

    const result = await acquireClaim({
      gh,
      scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
      sessionId: OUR_SESSION,
      ledger: ledgerPath(OUR_SESSION),
      takeover: false,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.action).toBe('acquired');
    if (result.action !== 'acquired') return;
    expect(result.claim.sessionId).toBe(OUR_SESSION);
    expect(result.claim.heldSince).toBe(NOW.toISOString());
    expect(result.claim.heartbeatAt).toBe(NOW.toISOString());
    expect(result.commentUrl).toMatch(/#issuecomment-\d+$/);

    expect(
      mock.calls.some((c) => c.method === 'postIssueComment'),
    ).toBe(true);
    expect(
      mock.calls.some(
        (c) =>
          c.method === 'addLabels' &&
          Array.isArray(c.args[2]) &&
          (c.args[2] as string[]).includes(CLAIM_LABEL),
      ),
    ).toBe(true);
    expect(mock.getLabels(REPO, ISSUE)).toContain(CLAIM_LABEL);
  });

  it('refresh: same session → writes = 1 edit; label untouched', async () => {
    const mock = new ClaimMockGh();
    const marker = formatMarker(payloadFor(OUR_SESSION));
    mock.seedComment(REPO, ISSUE, marker);
    mock.seedLabel(REPO, ISSUE, CLAIM_LABEL);
    const gh = mock.build();

    const result = await acquireClaim({
      gh,
      scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
      sessionId: OUR_SESSION,
      ledger: ledgerPath(OUR_SESSION),
      takeover: false,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.action).toBe('refreshed');
    if (result.action !== 'refreshed') return;
    expect(result.claim.heartbeatAt).toBe(NOW.toISOString());
    // heldSince preserved
    expect(result.claim.heldSince).toBe('2026-07-21T14:00:00.000Z');

    const editCalls = mock.calls.filter((c) => c.method === 'editIssueComment');
    expect(editCalls.length).toBe(1);
    const labelWrites = mock.calls.filter(
      (c) => c.method === 'addLabels' || c.method === 'removeLabels',
    );
    expect(labelWrites.length).toBe(0);
  });

  it('takeover happy path: writes = delete + post; displaced populated', async () => {
    const mock = new ClaimMockGh();
    const incumbent = mock.seedComment(REPO, ISSUE, formatMarker(payloadFor(OTHER_SESSION)));
    mock.seedLabel(REPO, ISSUE, CLAIM_LABEL);
    const gh = mock.build();

    const result = await acquireClaim({
      gh,
      scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
      sessionId: OUR_SESSION,
      ledger: ledgerPath(OUR_SESSION),
      takeover: true,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.action).toBe('taken-over');
    if (result.action !== 'taken-over') return;
    expect(result.claim.sessionId).toBe(OUR_SESSION);
    expect(result.displaced.sessionId).toBe(OTHER_SESSION);

    expect(
      mock.calls.some(
        (c) => c.method === 'deleteIssueComment' && c.args[1] === incumbent.id,
      ),
    ).toBe(true);
    expect(
      mock.calls.some((c) => c.method === 'postIssueComment'),
    ).toBe(true);
  });

  it('refuse path: returns claim-conflict with populated holder, no writes', async () => {
    const mock = new ClaimMockGh();
    mock.seedComment(REPO, ISSUE, formatMarker(payloadFor(OTHER_SESSION)));
    mock.seedLabel(REPO, ISSUE, CLAIM_LABEL);
    const gh = mock.build();

    const result = await acquireClaim({
      gh,
      scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
      sessionId: OUR_SESSION,
      ledger: ledgerPath(OUR_SESSION),
      takeover: false,
      now: NOW,
    });

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('claim-conflict');
    expect(result.holder.sessionId).toBe(OTHER_SESSION);
    expect(result.detail).toContain(REPO);
    expect(result.detail).toContain(OTHER_SESSION);
    expect(result.hint).toContain('takeover: true');
    expect(result.hint).toContain('/cockpit:auto');
    expect(result.commentUrl).toMatch(/#issuecomment-\d+$/);
    expect(mock.countWrites()).toBe(0);
  });

  it('stale incumbent treated as no-claim (no takeover needed)', async () => {
    const mock = new ClaimMockGh();
    mock.seedComment(
      REPO,
      ISSUE,
      formatMarker(
        payloadFor(OTHER_SESSION, { heartbeatAt: '2026-07-21T13:55:00.000Z' }),
      ),
    );
    const gh = mock.build();

    const result = await acquireClaim({
      gh,
      scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
      sessionId: OUR_SESSION,
      ledger: ledgerPath(OUR_SESSION),
      takeover: false,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.action).toBe('acquired');
  });

  it('takeover-when-already-holder collapses to refresh (idempotency)', async () => {
    const mock = new ClaimMockGh();
    mock.seedComment(REPO, ISSUE, formatMarker(payloadFor(OUR_SESSION)));
    mock.seedLabel(REPO, ISSUE, CLAIM_LABEL);
    const gh = mock.build();

    const result = await acquireClaim({
      gh,
      scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
      sessionId: OUR_SESSION,
      ledger: ledgerPath(OUR_SESSION),
      takeover: true,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.action).toBe('refreshed');
    // No 'displaced' field
    expect((result as unknown as { displaced?: unknown }).displaced).toBeUndefined();
  });

  it('two-caller acquire race: loser deletes own comment + returns refusal', async () => {
    // Simulate a race: caller A acquires first (posts marker with heldSince=T0),
    // then caller B posts second (heldSince=T1 > T0); oldest-wins tiebreaker →
    // A holds, B refuses.
    const mock = new ClaimMockGh();
    const gh = mock.build();

    // A goes first.
    const nowA = new Date('2026-07-21T14:10:00.000Z');
    const rA = await acquireClaim({
      gh,
      scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
      sessionId: OUR_SESSION,
      ledger: ledgerPath(OUR_SESSION),
      takeover: false,
      now: nowA,
    });
    expect(rA.status).toBe('ok');
    if (rA.status !== 'ok') return;
    expect(rA.action).toBe('acquired');

    // B tries to acquire — same-session pre-check finds A's live claim, refuses.
    const nowB = new Date('2026-07-21T14:10:05.000Z');
    const rB = await acquireClaim({
      gh,
      scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
      sessionId: OTHER_SESSION,
      ledger: ledgerPath(OTHER_SESSION),
      takeover: false,
      now: nowB,
    });
    expect(rB.status).toBe('error');
    if (rB.status !== 'error') return;
    expect(rB.class).toBe('claim-conflict');
    expect(rB.holder.sessionId).toBe(OUR_SESSION);
  });

  it('post-verify race: when verification finds a different winner, delete our comment', async () => {
    // Force the race path: initial discover returns no-claim, but between post
    // and re-discover a competing session's marker appears with an older
    // heldSince. We seed an "older" marker mid-post to simulate this.
    const mock = new ClaimMockGh();

    let posted = false;
    const originalGh = mock.build();
    const gh = {
      ...originalGh,
      postIssueComment: async (repo: string, issue: number, body: string) => {
        // First seed a competitor with older heldSince, then perform the actual post
        // (so re-discover finds two live markers and picks the older).
        if (!posted) {
          posted = true;
          mock.seedComment(
            repo,
            issue,
            formatMarker(
              payloadFor(OTHER_SESSION, {
                heldSince: '2026-07-21T14:00:00.000Z',
                heartbeatAt: '2026-07-21T14:09:59.000Z',
              }),
            ),
          );
        }
        return originalGh.postIssueComment(repo, issue, body);
      },
    } as typeof originalGh;

    const result = await acquireClaim({
      gh,
      scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
      sessionId: OUR_SESSION,
      ledger: ledgerPath(OUR_SESSION),
      // Our heldSince (NOW = 14:10) is later than the competitor's (14:00),
      // so oldest-wins gives the competitor the claim.
      takeover: false,
      now: NOW,
    });

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('claim-conflict');
    expect(result.holder.sessionId).toBe(OTHER_SESSION);

    // Verify we're not left with two markers on the issue (our loser comment was removed).
    const finalDiscover = await discoverClaim(originalGh, OWNER, REPO_NAME, ISSUE, NOW);
    expect(finalDiscover.kind).toBe('held');
    if (finalDiscover.kind !== 'held') return;
    expect(finalDiscover.live.payload.sessionId).toBe(OTHER_SESSION);
  });
});
