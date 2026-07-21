/**
 * Release the active-driver claim (#1015).
 *
 * Fully idempotent per R-11:
 *  - Caller holds → delete marker comment + remove label → `released`.
 *  - Different session holds → no-op, return `not-holder` with `currentHolder`.
 *  - No claim → no-op, return `no-claim` (discover already handles orphaned
 *    label cleanup as a side effect).
 *
 * Never returns `claim-conflict` — release is by-session-id only.
 */
import type { GhWrapper } from '@generacy-ai/cockpit';
import type { ReleaseResult } from './payload.js';
import { CLAIM_LABEL, discoverClaim } from './discover.js';

export interface ReleaseArgs {
  gh: GhWrapper;
  scope: { owner: string; repo: string; number: number };
  sessionId: string;
  now: Date;
}

export async function releaseClaim(args: ReleaseArgs): Promise<ReleaseResult> {
  const { gh, scope, sessionId, now } = args;
  const repoRef = `${scope.owner}/${scope.repo}`;

  const discovered = await discoverClaim(
    gh,
    scope.owner,
    scope.repo,
    scope.number,
    now,
  );

  if (discovered.kind === 'no-claim') {
    return { status: 'ok', action: 'no-claim' };
  }

  const holder = discovered.live.payload;
  if (holder.sessionId !== sessionId) {
    return { status: 'ok', action: 'not-holder', currentHolder: holder };
  }

  await gh.deleteIssueComment(repoRef, discovered.live.commentId);
  await gh.removeLabels(repoRef, scope.number, [CLAIM_LABEL]);
  return { status: 'ok', action: 'released', releasedClaim: holder };
}
