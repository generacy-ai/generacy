# Data Model: Deterministic branch/spec-slug + PR dedup

**Feature**: `1043-summary-when-speckit-feature` · **Plan**: [plan.md](./plan.md) · **Contracts**: [contracts/issue-branch-resolver.md](./contracts/issue-branch-resolver.md)

This fix adds one new resolver function, one new callback signature on an existing input type, and one new structured log payload. No new persistent state (Q1-A: remote git branches are the source of truth). No schema migrations.

## Types added

### `ResolvedIssueBranch`

Result shape of `resolveIssueBranch()`. Discriminated on `source` for observability.

```ts
// packages/workflow-engine/src/actions/builtin/speckit/lib/issue-branch-resolver.ts

export type ResolvedIssueBranch = {
  /** Canonical branch name for the issue — the head ref of the oldest open PR
   *  or, if no open PR exists, the oldest remote branch matching `<N>-*`. */
  branchName: string;

  /** Which lookup rule picked the branch. */
  source: 'oldest-open-pr' | 'oldest-remote-branch';

  /** For `oldest-open-pr`: the PR number that anchored the choice.
   *  For `oldest-remote-branch`: undefined. */
  anchoringPrNumber?: number;

  /** Number of candidate `<N>-*` branches considered (for structured logging). */
  candidateBranchCount: number;

  /** Number of candidate open PRs on `<N>-*` branches considered. */
  candidatePrCount: number;
};
```

**Invariants**:

- `branchName` matches `/^\d+-/` (the resolver enforces the `<N>-` prefix during filtering).
- `source === 'oldest-open-pr'` iff `anchoringPrNumber !== undefined`.
- `candidatePrCount === 0` implies `source === 'oldest-remote-branch'`.
- Function returns `null` (not `ResolvedIssueBranch`) when both `candidateBranchCount === 0` and `candidatePrCount === 0`.

### `ResolveExistingBranchCallback`

New optional field on `CreateFeatureInput` — the injection seam that keeps `feature.ts` git-only.

```ts
// packages/workflow-engine/src/actions/builtin/speckit/types.ts

export type ResolveExistingBranchCallback = (
  issueNumber: number,
) => Promise<string | null>;

export interface CreateFeatureInput {
  description: string;
  number?: number;
  short_name?: string;
  parent_epic_branch?: string;
  cwd?: string;

  /**
   * NEW in #1043: optional callback that returns the canonical branch name
   * for an issue (by querying remote branches + open PRs). When it returns
   * a non-null value, createFeature uses that name and skips slug derivation.
   * When unset or returning null, falls back to buildBranchNameFromPattern().
   */
  resolveExistingBranch?: ResolveExistingBranchCallback;
}
```

**Invariants**:

- Optional. `undefined` preserves pre-#1043 behavior exactly.
- Return value MUST match `/^\d+-[a-z0-9]+(?:-[a-z0-9]+)*$/` (`FEATURE_NAME_PATTERN`) — validated in `createFeature` before use; malformed returns are treated as `null` with a `warn` log.

## Structured log events

Two new event shapes on the existing pino logger. Both non-fatal.

### `event: 'workflow-reentry-branch-reused'`

Emitted by `createFeature()` when the callback returns a non-null value that matches an existing remote branch. **SC-003** assertion target.

```ts
{
  event: 'workflow-reentry-branch-reused',
  issueNumber: number,          // e.g., 1038
  canonicalBranch: string,      // e.g., '1038-issue-1038'
  wouldHaveDerived: string,     // e.g., '1038-part-cockpit-remote-gates'
  source: 'oldest-open-pr' | 'oldest-remote-branch',
  anchoringPrNumber?: number,
}
```

### `event: 'workflow-reentry-branch-mismatch'`

Emitted by `PrManager.ensureDraftPr()` when the resolver reports a canonical branch different from `getCurrentBranch()`. **FR-005** implementation.

```ts
{
  event: 'workflow-reentry-branch-mismatch',
  issueNumber: number,
  currentBranch: string,        // e.g., '1038-part-cockpit-remote-gates'
  canonicalBranch: string,      // e.g., '1038-issue-1038'
  source: 'oldest-open-pr' | 'oldest-remote-branch',
  anchoringPrNumber?: number,
  action: 'adopted' | 'no-op',  // 'adopted' when we successfully adopted the canonical PR
}
```

## Modified types

### `PrManager` — no shape change

`PrManager` gains no new constructor args or public methods. `ensureDraftPr()`'s internals change: it now consults `resolveIssueBranch(...)` before `findPRForBranch(currentBranch)`. The resolver is constructed inline from the `github` / `owner` / `repo` / `issueNumber` fields already on the class.

## Removed / renamed

None. Q4-A guarantees zero changes to `generateConfigurableSlug()` and `buildBranchNameFromPattern()`. Slug-generation stays the fallback path when the callback returns `null`.

## Persistence

**None new.** Per Q1-A, the source of truth is remote git branches (queried on every entry via `gh api /repos/<owner>/<repo>/branches` + `gh pr list --state open`). Zero new Redis keys, zero new files under `.generacy/`, zero new markers on issues or PRs.

## Migration considerations

**No migrations required.** Existing branches and PRs are the input to the resolver — the fix is *read-only* against pre-#1043 remote state. On first re-entry after the fix ships:

- The resolver sees the existing `<N>-*` branch (created by pre-#1043 code).
- Returns it as canonical.
- `createFeature` skips slug re-derivation.
- Behavior converges to Q1-A on the very first invocation with no operator action.

Pre-existing duplicate `specs/<N>-*` directories are **not cleaned up** — `spec.md` §Out of Scope forbids it. Historical branches with mismatched slugs continue on their original names; only *future* re-entries pick a canonical branch.
