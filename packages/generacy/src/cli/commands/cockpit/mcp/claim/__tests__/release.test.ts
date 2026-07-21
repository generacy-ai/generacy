import { describe, expect, it } from 'vitest';
import { releaseClaim } from '../release.js';
import { CLAIM_LABEL } from '../discover.js';
import { formatMarker } from '../marker.js';
import type { ClaimPayload } from '../payload.js';
import { ClaimMockGh } from './helpers/mock-gh.js';

const OWNER = 'owner';
const REPO_NAME = 'repo';
const REPO = 'owner/repo';
const ISSUE = 1015;
const NOW = new Date('2026-07-21T14:47:00.000Z');

const OUR_SESSION = 'aaaaaaaaaaaaaaaa';
const OTHER_SESSION = 'bbbbbbbbbbbbbbbb';

function payloadFor(session: string, overrides: Partial<ClaimPayload> = {}): ClaimPayload {
  return {
    version: 1,
    sessionId: session,
    heldSince: '2026-07-21T14:00:00.000Z',
    heartbeatAt: '2026-07-21T14:46:00.000Z',
    ledger: `.generacy/cockpit/auto-runs/${session}.ledger`,
    scope: `${REPO}#${ISSUE}`,
    ...overrides,
  };
}

describe('releaseClaim', () => {
  it('release-as-holder → released (2 writes: delete + removeLabel)', async () => {
    const mock = new ClaimMockGh();
    mock.seedComment(REPO, ISSUE, formatMarker(payloadFor(OUR_SESSION)));
    mock.seedLabel(REPO, ISSUE, CLAIM_LABEL);
    const gh = mock.build();

    const result = await releaseClaim({
      gh,
      scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
      sessionId: OUR_SESSION,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.action).toBe('released');
    if (result.action !== 'released') return;
    expect(result.releasedClaim.sessionId).toBe(OUR_SESSION);

    expect(
      mock.calls.some((c) => c.method === 'deleteIssueComment'),
    ).toBe(true);
    expect(
      mock.calls.some(
        (c) =>
          c.method === 'removeLabels' &&
          Array.isArray(c.args[2]) &&
          (c.args[2] as string[]).includes(CLAIM_LABEL),
      ),
    ).toBe(true);
    expect(mock.getLabels(REPO, ISSUE)).not.toContain(CLAIM_LABEL);
    expect(mock.getComments(REPO, ISSUE).length).toBe(0);
  });

  it('release-as-non-holder while claim exists → not-holder, 0 writes on this call', async () => {
    const mock = new ClaimMockGh();
    mock.seedComment(REPO, ISSUE, formatMarker(payloadFor(OTHER_SESSION)));
    mock.seedLabel(REPO, ISSUE, CLAIM_LABEL);
    const gh = mock.build();

    // Snapshot writes before, so we ignore any that discover made (there shouldn't be any).
    const writesBefore = mock.countWrites();
    const result = await releaseClaim({
      gh,
      scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
      sessionId: OUR_SESSION,
      now: NOW,
    });
    const writesAfter = mock.countWrites();

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.action).toBe('not-holder');
    if (result.action !== 'not-holder') return;
    expect(result.currentHolder?.sessionId).toBe(OTHER_SESSION);

    // Discover on a healthy held state does 0 writes; release does 0 more.
    expect(writesAfter - writesBefore).toBe(0);
    // Live comment untouched.
    expect(mock.getComments(REPO, ISSUE).length).toBe(1);
  });

  it('release with no claim → no-claim, 0 writes normally', async () => {
    const mock = new ClaimMockGh();
    const gh = mock.build();

    const result = await releaseClaim({
      gh,
      scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
      sessionId: OUR_SESSION,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.action).toBe('no-claim');
    expect(mock.countWrites()).toBe(0);
  });

  it('release with orphaned label → no-claim + label cleaned up (1 write via discover)', async () => {
    const mock = new ClaimMockGh();
    mock.seedLabel(REPO, ISSUE, CLAIM_LABEL);
    const gh = mock.build();

    const result = await releaseClaim({
      gh,
      scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
      sessionId: OUR_SESSION,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.action).toBe('no-claim');
    expect(mock.getLabels(REPO, ISSUE)).not.toContain(CLAIM_LABEL);
  });

  it('delete failure surfaces (transport propagates)', async () => {
    const mock = new ClaimMockGh();
    mock.seedComment(REPO, ISSUE, formatMarker(payloadFor(OUR_SESSION)));
    mock.seedLabel(REPO, ISSUE, CLAIM_LABEL);
    mock.failure.deleteIssueComment = () => new Error('gh 500 transient');
    const gh = mock.build();

    await expect(
      releaseClaim({
        gh,
        scope: { owner: OWNER, repo: REPO_NAME, number: ISSUE },
        sessionId: OUR_SESSION,
        now: NOW,
      }),
    ).rejects.toThrow(/gh 500 transient/);
  });
});
