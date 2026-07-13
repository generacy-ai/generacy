// Contract: CLI internal Scope — post-#801
//
// Location at implementation time:
//   packages/generacy/src/cli/commands/cockpit/shared/scoping.ts
//
// Only `Scope.issues` shape changes; the discriminator and `repos`-branch
// fields are unchanged.

import type { IssueRef } from './resolveEpicIssues.js';

export type Scope =
  | {
      kind: 'epic';
      /** Epic's owner (not children's). */
      owner: string;
      /** Epic's repo (not children's). */
      repo: string;
      /** `${owner}/${repo}` of the epic itself. */
      ownerRepo: string;
      /** Repo-qualified child refs. May span repos other than `ownerRepo`. */
      issues: IssueRef[];
    }
  | {
      kind: 'repos';
      /** Owner/repo list when no epic is scoped. */
      repos: string[];
    };

/**
 * Consumer expectations after #801:
 *
 * - `status.ts` MUST derive the per-row `repo` from each `IssueRef`, not from
 *   `scope.ownerRepo`. The per-repo `gh search` batching still applies but is
 *   keyed by `unique(scope.issues.map(r => r.repo))`.
 *
 * - `watch/poll-loop.ts:reposForScope(scope)` MUST return
 *   `unique(scope.issues.map(r => r.repo))` for epic scope (was: `[scope.ownerRepo]`).
 *
 * - `watch/poll-loop.ts:queryFor(scope, repo)` MUST embed only the numbers
 *   whose `IssueRef.repo === repo`, not the full `scope.issues` set
 *   (otherwise the per-repo query gets polluted with unrelated numbers).
 *
 * - The `epic`-mode JSON envelope (`renderJsonEnvelope`) MUST continue to
 *   carry the epic's own `owner`, `repo`, `issue` — unchanged by #801.
 */
