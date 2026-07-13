# Data Model: cockpit merge + review-context (G1.3)

## 1. Engine-layer types (additions to `packages/cockpit/src/gh/wrapper.ts`)

### `PullRequestRef`

Compact pointer used by `resolveIssueToPR`. Sufficient for downstream calls that only need the number + URL + state.

```ts
export interface PullRequestRef {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  headRefName: string;
}
```

- `state`: normalized to uppercase. `MERGED` is distinct from `CLOSED` (closed without merging).
- `headRefName`: included so callers can detect protected-branch source PRs without a second round trip.

### `PullRequestDetail`

Full PR payload for `review-context` and merge gating. Wraps the diff text alongside the metadata.

```ts
export interface PullRequestDetail {
  number: number;
  title: string;
  url: string;
  base: string;
  head: string;
  body: string;
  author: { login: string } | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  labels: string[];
  /** Unified diff text. May be truncated; see `diffTruncated`. */
  diff: string;
  /** True iff the diff was capped before being returned. */
  diffTruncated: boolean;
}
```

- `labels` is included even though `merge` could re-derive it from `Issue.labels` — the PR's labels are authoritative for the `completed:validate` check.
- `diff` is text (not structured per-file). 256 KiB cap applied at the engine boundary; engine sets `diffTruncated: true` if truncation occurred.

### `MergeResult`

```ts
export interface MergeResult {
  /** Final state of the PR after the merge call. */
  merged: boolean;
  /** SHA of the resulting commit on `develop`. Present when `merged === true`. */
  commitSha?: string;
}
```

- A successful `gh pr merge --squash` returns text like `! Pull request ... merged ...`; `mergePullRequest` parses the resulting commit SHA via a follow-up `gh pr view --json mergeCommit` rather than scraping stdout.
- On non-zero exit, `mergePullRequest` throws — there is no "soft failure" semantics for merging.

### `RequiredChecksResult`

Result of `getRequiredCheckNames(repo, branch)`. The discriminated `source` field is what lets the caller log the right warning.

```ts
export interface RequiredChecksResult {
  /** Where the list came from. `null` names means "treat every PR check as required." */
  source: 'branch-protection' | 'fallback-pr-checks';
  names: string[] | null;
}
```

### `GhWrapper` interface additions

```ts
export interface GhWrapper {
  // ... existing methods unchanged ...
  resolveIssueToPR(repo: string, issue: number): Promise<PullRequestRef | null>;
  getPullRequest(repo: string, prNumber: number): Promise<PullRequestDetail>;
  mergePullRequest(repo: string, prNumber: number, opts: { squash: true }): Promise<MergeResult>;
  getRequiredCheckNames(repo: string, branch: string): Promise<RequiredChecksResult>;
}
```

- `mergePullRequest`'s `opts` is typed `{ squash: true }` (not `{ squash: boolean }`) — squash is the only supported strategy and the literal type makes accidental `squash: false` calls a type error.

## 2. CLI-layer types (`packages/generacy/src/cli/commands/cockpit/shared/`)

### `FailingCheckPayload` (Q2)

The on-stdout JSON for any red `merge` outcome.

```ts
export type RedReason = 'checks-failing' | 'missing-label' | 'unresolved';

export interface FailingCheck {
  name: string;
  state: 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED' | 'MISSING';
  url?: string;
}

export interface FailingCheckPayload {
  status: 'red';
  reason: RedReason;
  pr: { number: number; url: string } | null;
  failingChecks: FailingCheck[];
}
```

Validation rules:

- `status` is always the literal `"red"` (the green path emits nothing).
- `reason === 'unresolved'` → `pr` MAY be `null` (issue had no PR at all) AND `failingChecks` MUST be `[]`.
- `reason === 'missing-label'` → `pr` MUST be non-null AND `failingChecks` MUST be `[]`.
- `reason === 'checks-failing'` → `pr` MUST be non-null AND `failingChecks` MUST be non-empty.
- `state === 'MISSING'` is the synthetic state for required-by-branch-protection checks not present on the PR's check list (see R3).

### `ReviewContextPayload` (Q5)

The on-stdout JSON for `review-context`.

```ts
export interface ReviewContextPayload {
  pr: {
    number: number;
    title: string;
    url: string;
    base: string;
    head: string;
    body: string;
    author: string | null;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    draft: boolean;
  };
  diff: string;
  diffTruncated: boolean;
  checks: Array<{
    name: string;
    state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
    conclusion?: string;
    url?: string;
  }>;
}
```

- `author` is the login string (or `null` for ghosted authors); compresses `PullRequestDetail.author.login` into a single field for the consumer.
- `diffTruncated` propagates from `PullRequestDetail`. Consumers (e.g. `/code-review`) check this to decide whether to re-fetch.
- Field set is a superset of what FR-009 requires — adding `diffTruncated` is a forward-compatible additive change.

### `ResolveContextInput`

Shared between `merge` and `review-context` — what they need before either branches.

```ts
export interface ResolveContextInput {
  /** GitHub issue number (positional CLI arg). */
  issue: number;
  /** Owner/name pair, e.g. "generacy-ai/generacy". Inferred from cwd if absent. */
  repo: string;
}
```

## 3. Relationships

```
ResolveContextInput
        │
        ▼
GhWrapper.resolveIssueToPR()
        │
        ▼
PullRequestRef ──────────┬──────────────────────────────┐
                         │                              │
                         ▼                              ▼
       GhWrapper.getPullRequest()         GhWrapper.getPullRequestCheckRuns()
                         │                              │
                         ▼                              │
                PullRequestDetail                       │
                         │                              │
                         ├─ merge.ts uses .labels       │
                         │  (check `completed:validate`)│
                         │                              │
                         │      GhWrapper.getRequiredCheckNames()
                         │                              │
                         │                              ▼
                         │                    RequiredChecksResult
                         │                              │
                         ▼                              ▼
        review-context.ts ─→ ReviewContextPayload   merge.ts compares
                                                    required vs. actual,
                                                    builds FailingCheckPayload
                                                    or calls
                                                    GhWrapper.mergePullRequest()
```

## 4. Existing types reused (no changes)

- `Issue` (`packages/cockpit/src/gh/wrapper.ts`) — not used directly by the verbs but reused by `resolveIssueToPR`'s internal lookups.
- `CheckRunSummary` (same file) — `merge` and `review-context` consume this directly.
- `CommandRunner` (`packages/cockpit/src/gh/command-runner.ts`) — engine method tests inject stubs of this.
- `WORKFLOW_LABELS` (`@generacy-ai/workflow-engine`) — source of the `completed:validate` constant.
