# Contract: `push-guard.ts`

## Public surface

```ts
export interface PushGuardInput {
  owner: string;
  repo: string;
  issueNumber: number;
  branch: string;
  github: Pick<GitHubClient, 'findPRForBranchAnyState' | 'getIssue'>;
  git: {
    remoteBranchExists(branch: string): Promise<boolean>;
  };
}

export type PushGuardDecision =
  | { kind: 'allow' }
  | {
      kind: 'refuse';
      reason: 'pr-merged' | 'pr-closed' | 'branch-missing' | 'pr-lookup-failed';
      prNumber: number | null;
      branch: string;
      owner: string;
      repo: string;
      issueNumber: number;
    };

export async function evaluatePushGuard(input: PushGuardInput): Promise<PushGuardDecision>;
```

## Semantics

Runs two independent lookups in parallel:

1. `github.findPRForBranchAnyState(owner, repo, branch)` — returns `PullRequest | null` across all states (open + closed + merged).
2. `git.remoteBranchExists(branch)` — returns `boolean` from `git ls-remote --heads origin <branch>`.

Then applies the decision matrix in **exactly** this order:

| # | PR result | Branch present? | Decision |
|---|-----------|-----------------|----------|
| 1 | `state === 'merged'` | *any* | `refuse { reason: 'pr-merged', prNumber: pr.number }` |
| 2 | `state === 'closed'` | *any* | `refuse { reason: 'pr-closed', prNumber: pr.number }` |
| 3 | `state === 'open'` | `false` | `refuse { reason: 'branch-missing', prNumber: pr.number }` |
| 4 | `state === 'open'` | `true` | `allow` |
| 5 | `null` | `false` | `allow` (first-push case — Q2 clarification; `createFeature`'s local-only branch has not yet been pushed to origin) |
| 6 | `null` | `true` | `allow` (no PR, branch pre-exists) |

**Order matters**: rows 1–2 short-circuit before row 3 so a merged/closed PR whose branch was deleted still produces `reason: 'pr-merged'` (more diagnostic than `reason: 'branch-missing'`).

**Row 5 rationale** (PR #1052 review Finding 1): a brand-new issue's local `<N>-*` branch is created via `git.checkoutLocalBranch()` inside `createFeature`; no push has happened yet. On the very first phase, `pr === null` (no PR ever) and `remoteBranchExists === false` (never pushed). This is not a resurrection attempt — it is the first push of a legitimate new branch. Refusing here would kill every new issue at the phase-loop-entry guard before any phase executes. Row 3 is scoped to `pr.state === 'open'` specifically so that the "open PR + branch deleted" resurrection case still refuses while the first-push case allows.

**Per-lookup failure isolation** (PR #1052 review Finding 4):

- `github.findPRForBranchAnyState` throws → **refuse** with `reason: 'pr-lookup-failed'`, `prNumber: null`. This is the load-bearing lookup: if it fails silently, a rate-limited `gh` call reclassifies as "no PR ever" and the guard allows a merged-PR resurrection push. Refuse-safe is the correct posture for a safety gate when it cannot verify its input.
- `git.remoteBranchExists` throws → treat as `true` (branch present). Rationale: if the PR-state lookup succeeded and reports `merged` or `closed`, rows 1-2 still refuse regardless of the branch-existence outcome. Fail-open on the local-git side does not create a resurrection hole; refusing on ls-remote transient would kill legitimate first-push flows.

The pre-Finding-4 whole-guard `allow` on any lookup failure has been retracted because FR-004 was also retracted (see spec.md § Out of Scope) — the guard is now the sole correctness gate for the resurrection surface, and cannot fail open on its own input.

**Log side-effects**: the guard itself emits NO logs. The caller is responsible for the `event: 'push-refused'` log line (FR-003a) so the log is at the site that took action, not the site that computed the decision. Rationale: SC-002 asserts exactly one refusal log per refusal, which is easier to prove when the log is emitted from a single caller-side site.

## Test surface

Cases the SC-002 unit test MUST cover (matrix from spec.md § Success Criteria):

- PR merged + branch present → refuse `pr-merged`
- PR closed + branch present → refuse `pr-closed`
- PR merged + branch missing → refuse `pr-merged` (row 1 short-circuits)
- PR open + branch missing → refuse `branch-missing`
- PR open + branch present → allow
- No PR + branch present → allow
- No PR + branch missing → allow (first-push case — regression guard for #1052 Finding 1)

Additional per-lookup failure-isolation cases (PR #1052 review Finding 4):

- `findPRForBranchAnyState` throws → refuse `pr-lookup-failed` (prNumber: null)
- `remoteBranchExists` throws → treated as `true`; decision derives from PR-state alone
- Both throw → refuse `pr-lookup-failed` (PR lookup dominates)
