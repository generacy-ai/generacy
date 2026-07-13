# Data Model: `cockpit merge` head-branch deletion

**Issue**: [generacy-ai/generacy#859](https://github.com/generacy-ai/generacy/issues/859)

## Type extensions

### `PullRequestDetail` (extended)

**Location**: `packages/cockpit/src/gh/wrapper.ts:48-61`

```typescript
export interface PullRequestDetail {
  number: number;
  title: string;
  url: string;
  base: string;
  head: string;
  headRepositoryOwner: string | null;   // NEW — Q2→A
  body: string;
  author: { login: string } | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  labels: string[];
  diff: string;
  diffTruncated: boolean;
}
```

**Field semantics**:
- `headRepositoryOwner: string` (non-null) — login of the org/user that owns the head repo. Compare against `issueRef.owner` to determine cross-fork.
- `headRepositoryOwner: null` — head fork has been deleted after the PR was opened. Caller cannot deterministically classify as cross-fork; attempts the delete anyway, and any residual error surfaces as `delete-failed`.

**Validation rules**:
- Source: `headRepositoryOwner.login` from `gh pr view --json headRepositoryOwner` response.
- Wrapper's raw schema accepts `nullable().optional()` — matches gh's behavior for deleted head repos.
- Extract to `string | null`: `detail.data.headRepositoryOwner?.login ?? null` at the wrapper's return-shape assembly.

### `DeleteHeadRefResult` (new)

**Location**: `packages/cockpit/src/gh/wrapper.ts` (near other result types, ~line 63-71).

```typescript
export interface DeleteHeadRefResult {
  outcome: 'deleted' | 'already-gone' | 'delete-failed';
  stderr?: string;   // present only when outcome === 'delete-failed'
}
```

**Field semantics**:
- `outcome: 'deleted'` — HTTP 204 (or gh exit 0). The ref was successfully removed.
- `outcome: 'already-gone'` — HTTP 422 (`"Reference does not exist"`) OR HTTP 404 (repo lookup miss). Ref is not present; nothing to do.
- `outcome: 'delete-failed'` — Any other non-zero exit. `stderr` carries the trimmed gh stderr for operator visibility and the FR-005 stdout suffix.

**Validation rules**:
- `outcome` is a closed enum — every non-zero exit lands in exactly one of the three values.
- `stderr` is populated iff `outcome === 'delete-failed'`.
- No fields other than `outcome` and optional `stderr` — deliberate minimalism (Q3→C-slimmed rationale).

## Interface extension

### `GhWrapper` (extended)

**Location**: `packages/cockpit/src/gh/wrapper.ts:111-142`

```typescript
export interface GhWrapper {
  // …existing methods unchanged…
  mergePullRequest(
    repo: string,
    prNumber: number,
    opts: { squash: true },
  ): Promise<MergeResult>;
  deleteHeadRef(                                 // NEW
    repo: string,
    headRef: string,
  ): Promise<DeleteHeadRefResult>;
  // …existing methods unchanged…
}
```

**Method contract**: `deleteHeadRef(repo, headRef)`:
- **Input**:
  - `repo`: `"owner/name"` format (validated; throws if split fails).
  - `headRef`: raw head branch name (e.g. `feature/x`). Not URL-encoded — `gh api` accepts either form; unencoded is idiomatic.
- **Output**: `DeleteHeadRefResult` (never throws for expected non-happy paths).
- **Throws**: Only on malformed `repo` input. Every gh-side exit maps to a `DeleteHeadRefResult` outcome.

## Consumer contract (`runMerge`)

**Location**: `packages/generacy/src/cli/commands/cockpit/merge.ts:40-184`

**Post-merge invariant**: After a successful `gh.mergePullRequest(...)` on either the vacuous-green branch or the classify-passing branch, `runMerge`:

1. Computes cross-fork status: `isCrossFork = pr.headRepositoryOwner != null && pr.headRepositoryOwner !== issueRef.owner`.
2. If `isCrossFork`: skip `deleteHeadRef`; suffix is `merged (branch delete skipped: cross-fork PR)\n`; emit `logger.info(...)`.
3. Else: call `gh.deleteHeadRef(repo, pr.head)`.
   - `outcome === 'deleted'` → suffix `merged and branch deleted\n`.
   - `outcome === 'already-gone'` → suffix `merged (branch was already deleted)\n`; emit `logger.info(...)`.
   - `outcome === 'delete-failed'` → suffix `merged (branch delete failed: ${stderr})\n`; emit `logger.warn(...)`.
4. Compose final stdout:
   - Vacuous-green branch: prior note `no checks configured and none required — proceeding on completed:validate\n` + suffix.
   - Classify-passing branch: suffix (sole stdout line).
5. Return `{ exitCode: 0, stdout }`.

## Stdout suffix table (canonical)

| Path                  | Suffix (byte-exact, `\n`-terminated)                                     |
|-----------------------|--------------------------------------------------------------------------|
| deleted               | `merged and branch deleted\n`                                            |
| already-gone          | `merged (branch was already deleted)\n`                                  |
| skipped-cross-fork    | `merged (branch delete skipped: cross-fork PR)\n`                        |
| delete-failed         | `merged (branch delete failed: <stderr>)\n`                              |

**Encoding**: ASCII throughout. No non-ASCII characters in any of the four canonical strings.

## Log-line contract

| Outcome              | Level | Msg                              | Bindings                                                   |
|----------------------|-------|----------------------------------|------------------------------------------------------------|
| deleted              | —     | (none; success is silent)        | —                                                          |
| already-gone         | info  | `branch was already deleted`     | `{ pr, headRef }`                                          |
| skipped-cross-fork   | info  | `branch deletion skipped: cross-fork PR` | `{ pr, headRef, headOwner }`                       |
| delete-failed        | warn  | `branch deletion failed`         | `{ pr, repo, headRef, stderr }`                            |

## Relationships

```text
    ┌───────────────────────────────┐
    │ GhWrapper.getPullRequestDetail │──────► PullRequestDetail (+ headRepositoryOwner)
    └───────────────────────────────┘                   │
                                                        │ (read by runMerge)
                                                        ▼
    ┌───────────────────────────────┐         ┌─────────────────────┐
    │  runMerge (merge.ts)          │────────►│ cross-fork pre-check │
    └────────────┬──────────────────┘         └──────────┬──────────┘
                 │ merge succeeds                        │
                 ▼                                       │ not cross-fork
    ┌───────────────────────────────┐                    │
    │ GhWrapper.mergePullRequest    │                    │
    └───────────────────────────────┘                    ▼
                                             ┌─────────────────────┐
                                             │ GhWrapper           │
                                             │ .deleteHeadRef      │
                                             └──────────┬──────────┘
                                                        │
                                                        ▼
                                             DeleteHeadRefResult
                                                { outcome, stderr? }
                                                        │
                                                        ▼
                                             stdout suffix
                                             (canonical string)
```

## Not modeled

- **`MergeResult`** — unchanged. `mergePullRequest`'s output shape stays `{ merged, commitSha? }`; deletion outcome flows through `runMerge`'s `RunMergeResult.stdout`, not through `MergeResult`.
- **Cross-fork classification result** — not a persisted type. It's a one-line boolean computed at the caller from `PullRequestDetail.headRepositoryOwner`.
- **Retry policy** — `deleteHeadRef` is single-shot. The caller does not retry (spec's "Handle gracefully" allows delete-failed to surface without a retry loop; the operator sees the reason and the branch remains available for manual cleanup via GitHub UI).
