import { describe, expect, it } from 'vitest';
import { discoverClaim, CLAIM_LABEL } from '../discover.js';
import { formatMarker } from '../marker.js';
import type { ClaimPayload } from '../payload.js';
import { ClaimMockGh } from './helpers/mock-gh.js';

const NOW = new Date('2026-07-21T14:10:00.000Z');
const REPO = 'owner/repo';
const OWNER = 'owner';
const REPO_NAME = 'repo';
const ISSUE = 1015;

function livePayload(overrides: Partial<ClaimPayload> = {}): ClaimPayload {
  return {
    version: 1,
    sessionId: 'aaaaaaaaaaaaaaaa',
    heldSince: '2026-07-21T14:05:00.000Z',
    heartbeatAt: '2026-07-21T14:09:30.000Z',
    ledger: '.generacy/cockpit/auto-runs/x.ledger',
    scope: `${REPO}#${ISSUE}`,
    ...overrides,
  };
}

describe('discoverClaim', () => {
  it('no comments and no label → no-claim (no writes)', async () => {
    const mock = new ClaimMockGh();
    const gh = mock.build();
    const result = await discoverClaim(gh, OWNER, REPO_NAME, ISSUE, NOW);
    expect(result.kind).toBe('no-claim');
    expect(mock.countWrites()).toBe(0);
  });

  it('orphaned label with no marker comments → no-claim + label removed', async () => {
    const mock = new ClaimMockGh();
    mock.seedLabel(REPO, ISSUE, CLAIM_LABEL);
    const gh = mock.build();
    const result = await discoverClaim(gh, OWNER, REPO_NAME, ISSUE, NOW);
    expect(result.kind).toBe('no-claim');
    expect(mock.getLabels(REPO, ISSUE)).not.toContain(CLAIM_LABEL);
    expect(
      mock.calls.some((c) => c.method === 'removeLabels'),
    ).toBe(true);
  });

  it('single live claim → held with correct commentId + url', async () => {
    const mock = new ClaimMockGh();
    const seeded = mock.seedComment(REPO, ISSUE, formatMarker(livePayload()));
    mock.seedLabel(REPO, ISSUE, CLAIM_LABEL);
    const gh = mock.build();
    const result = await discoverClaim(gh, OWNER, REPO_NAME, ISSUE, NOW);
    expect(result.kind).toBe('held');
    if (result.kind !== 'held') return;
    expect(result.live.commentId).toBe(seeded.id);
    expect(result.live.commentUrl).toBe(seeded.url);
    expect(result.live.payload.sessionId).toBe('aaaaaaaaaaaaaaaa');
    expect(result.orphanedLabelPresent).toBe(false);
  });

  it('single stale claim (heartbeat > 10 min old) → no-claim + stale comment deleted', async () => {
    const mock = new ClaimMockGh();
    const stale = mock.seedComment(
      REPO,
      ISSUE,
      formatMarker(livePayload({ heartbeatAt: '2026-07-21T13:59:00.000Z' })),
    );
    const gh = mock.build();
    const result = await discoverClaim(gh, OWNER, REPO_NAME, ISSUE, NOW);
    expect(result.kind).toBe('no-claim');
    expect(
      mock.calls.some(
        (c) => c.method === 'deleteIssueComment' && c.args[1] === stale.id,
      ),
    ).toBe(true);
    expect(mock.getComments(REPO, ISSUE).length).toBe(0);
  });

  it('two live claims → oldest heldSince wins; younger deleted', async () => {
    const mock = new ClaimMockGh();
    const winner = mock.seedComment(
      REPO,
      ISSUE,
      formatMarker(
        livePayload({
          sessionId: 'bbbbbbbbbbbbbbbb',
          heldSince: '2026-07-21T14:03:00.000Z',
        }),
      ),
    );
    const loser = mock.seedComment(
      REPO,
      ISSUE,
      formatMarker(
        livePayload({
          sessionId: 'cccccccccccccccc',
          heldSince: '2026-07-21T14:04:00.000Z',
        }),
      ),
    );
    const gh = mock.build();
    const result = await discoverClaim(gh, OWNER, REPO_NAME, ISSUE, NOW);
    expect(result.kind).toBe('held');
    if (result.kind !== 'held') return;
    expect(result.live.commentId).toBe(winner.id);
    expect(result.live.payload.sessionId).toBe('bbbbbbbbbbbbbbbb');
    expect(
      mock.calls.some(
        (c) => c.method === 'deleteIssueComment' && c.args[1] === loser.id,
      ),
    ).toBe(true);
  });

  it('malformed marker comment → skipped (not fatal)', async () => {
    const mock = new ClaimMockGh();
    mock.seedComment(
      REPO,
      ISSUE,
      '<!-- cockpit:claim v1 -->\n```json\n{ not json }\n```',
    );
    const gh = mock.build();
    const result = await discoverClaim(gh, OWNER, REPO_NAME, ISSUE, NOW);
    expect(result.kind).toBe('no-claim');
  });

  it('delete failure during best-effort cleanup does not throw', async () => {
    const mock = new ClaimMockGh();
    mock.seedComment(
      REPO,
      ISSUE,
      formatMarker(livePayload({ heartbeatAt: '2026-07-21T13:58:00.000Z' })),
    );
    mock.failure.deleteIssueComment = () => new Error('gh network glitch');
    const gh = mock.build();
    const result = await discoverClaim(gh, OWNER, REPO_NAME, ISSUE, NOW);
    expect(result.kind).toBe('no-claim');
  });

  it('label present alongside live claim → orphanedLabelPresent: false', async () => {
    const mock = new ClaimMockGh();
    mock.seedComment(REPO, ISSUE, formatMarker(livePayload()));
    mock.seedLabel(REPO, ISSUE, CLAIM_LABEL);
    const gh = mock.build();
    const result = await discoverClaim(gh, OWNER, REPO_NAME, ISSUE, NOW);
    expect(result.kind).toBe('held');
    if (result.kind !== 'held') return;
    expect(result.orphanedLabelPresent).toBe(false);
  });

  it('label missing alongside live claim → orphanedLabelPresent: true', async () => {
    const mock = new ClaimMockGh();
    mock.seedComment(REPO, ISSUE, formatMarker(livePayload()));
    const gh = mock.build();
    const result = await discoverClaim(gh, OWNER, REPO_NAME, ISSUE, NOW);
    expect(result.kind).toBe('held');
    if (result.kind !== 'held') return;
    expect(result.orphanedLabelPresent).toBe(true);
  });
});
