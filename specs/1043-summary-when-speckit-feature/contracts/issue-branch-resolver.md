# Contract: `resolveIssueBranch`

**Feature**: `1043-summary-when-speckit-feature` · **Plan**: [../plan.md](../plan.md) · **Data model**: [../data-model.md](../data-model.md)

Pure function that resolves the canonical `<N>-<slug>` branch for a GitHub issue by querying remote state only (Q1-A). One decision tree, five branches, deterministic output.

## Signature

```ts
// packages/workflow-engine/src/actions/builtin/speckit/lib/issue-branch-resolver.ts

import type { GitHubClient } from '../../../github/client/interface.js';
import type { SimpleGit } from 'simple-git';
import type { Logger } from '../../../../types/logger.js';
import type { ResolvedIssueBranch } from './issue-branch-resolver-types.js';

export async function resolveIssueBranch(input: {
  issueNumber: number;
  owner: string;
  repo: string;
  github: GitHubClient;
  git: SimpleGit;
  logger?: Logger;
}): Promise<ResolvedIssueBranch | null>;
```

## Behavior

Two enumeration steps + one PR/branch tiebreak, per `spec.md` §Clarifications Q2-A:

1. **Enumerate open PRs on `<N>-*` branches.** Call `github.listOpenPullRequests(owner, repo)`. Filter to PRs where `pr.head.ref` matches `/^${issueNumber}-/`. Sort by `pr.created_at` ascending.
2. **Enumerate remote branches matching `<N>-*`.** Call `github.listBranches(owner, repo)`. Filter to names matching `/^${issueNumber}-/`. For each, resolve its commit timestamp via `git.raw(['log', '-1', '--format=%ct', 'refs/remotes/origin/<branch>'])`. Sort by timestamp ascending.
3. **Tiebreak — PR-first**:
   - If ≥1 candidate PR: return `{ branchName: oldestPr.head.ref, source: 'oldest-open-pr', anchoringPrNumber: oldestPr.number, candidateBranchCount, candidatePrCount }`.
   - Else if ≥1 candidate branch: return `{ branchName: oldestBranch, source: 'oldest-remote-branch', candidateBranchCount, candidatePrCount: 0 }`.
   - Else: return `null`.

## Decision table

| Candidate PRs (`<N>-*`, open) | Candidate branches (`<N>-*`, remote) | Return |
|---|---|---|
| 0 | 0 | `null` — caller falls back to `buildBranchNameFromPattern()` |
| 0 | ≥1 | `{ branchName: <oldest branch>, source: 'oldest-remote-branch' }` |
| 1 | any | `{ branchName: <that PR's head>, source: 'oldest-open-pr' }` |
| ≥2 | any | `{ branchName: <oldest PR's head>, source: 'oldest-open-pr' }` |

## Error handling

- **`github.listOpenPullRequests` throws** → log `warn` (`event: 'issue-branch-resolver-pr-list-failed'`, `{ issueNumber, error }`), skip step 1, continue to step 2. Callers see behavior equivalent to zero-PR state.
- **`github.listBranches` throws** → log `warn` (`event: 'issue-branch-resolver-branch-list-failed'`, `{ issueNumber, error }`), if step 1 also failed return `null`; otherwise return step 1's result.
- **`git log` fails for a branch's timestamp** → treat that branch as `Infinity` (sorts last); other branches unaffected.
- **Both enumeration calls fail** → return `null`, caller falls back to slug derivation (existing behavior).

**Never throws.** Best-effort resolver; existing slug-derivation path is the guaranteed fallback.

## Determinism guarantees

- Input `(issueNumber, owner, repo)` + remote state → single return value.
- No wall-clock reads. No random. Sort stable by `(createdAt|commitTs)` then `branchName` alphabetical as final tiebreak.
- Filter regex is anchored at start and requires the exact digit sequence: `new RegExp('^' + issueNumber + '-')`. `123` does NOT match `1234-`.

## Test scenarios (mirror `plan.md` §Testing Strategy)

`packages/workflow-engine/tests/actions/speckit/issue-branch-resolver.test.ts` — 5 unit tests:

1. **Zero candidates** — mocked `listOpenPullRequests` + `listBranches` return no `<N>-*` matches. Assert: `null`.
2. **Branch-only, single** — one `<N>-*` branch, no PR. Assert: `{ branchName, source: 'oldest-remote-branch', candidateBranchCount: 1, candidatePrCount: 0 }`.
3. **Branch-only, multiple** — two `<N>-*` branches, no PRs. Assert: oldest by commit timestamp wins.
4. **PR wins over branch-only** — one `<N>-*` branch has an open PR, another doesn't. Assert: PR's branch wins, `source: 'oldest-open-pr'`.
5. **The `#1038` regression** — two `<N>-*` branches (`1038-issue-1038` created earlier, `1038-part-cockpit-remote-gates` created later), each with an open PR (#1039, #1041). Assert: returns `{ branchName: '1038-issue-1038', source: 'oldest-open-pr', anchoringPrNumber: 1039 }`.

## Caller contract

Two callers, both in the `#1043` fix:

### `createFeature` (`packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`)

- Called via the `resolveExistingBranch?: (issueNumber) => Promise<string | null>` callback on `CreateFeatureInput`.
- The callback is a closure that invokes `resolveIssueBranch(...)` and returns `result?.branchName ?? null`.
- If the callback returns a valid `<N>-*` string, `createFeature` uses it as `branchName` and skips `buildBranchNameFromPattern`.
- If the return value fails `FEATURE_NAME_PATTERN` validation, `createFeature` treats it as `null` and logs `warn { event: 'issue-branch-resolver-invalid-return', returned }`.

### `PrManager.ensureDraftPr` (`packages/orchestrator/src/worker/pr-manager.ts`)

- Calls `resolveIssueBranch(...)` directly (constructed inline from `this.github`, `this.owner`, `this.repo`, `this.issueNumber`, and a `simpleGit()` on the current cwd).
- If the result's `branchName !== await this.github.getCurrentBranch()`: emits `workflow-reentry-branch-mismatch` (see [data-model.md](../data-model.md)), then calls `findPRForBranch(canonicalBranch)` to adopt the existing PR instead of opening a new one.
- If the result is `null`: existing behavior — `findPRForBranch(currentBranch)` and (if null) `createPullRequest`.

## Out of scope for this contract

- Non-`<N>-*` branch prefixes (e.g., `main`, `develop`, `epic-*`) — filtered out.
- Closed or merged PRs — only `state: 'open'` counted (per FR-003).
- Deletion of superseded branches — Q2-A says "ignored, not deleted".
- Migration of pre-existing `specs/<N>-*` directories with mismatched slugs.
