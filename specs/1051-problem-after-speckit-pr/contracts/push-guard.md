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
      reason: 'pr-merged' | 'pr-closed' | 'branch-missing';
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
| 5 | `null` | `false` | `refuse { reason: 'branch-missing', prNumber: null }` |
| 6 | `null` | `true` | `allow` (first-push case — Q2 clarification) |

**Order matters**: rows 1–2 short-circuit before row 3 so a merged/closed PR whose branch was deleted still produces `reason: 'pr-merged'` (more diagnostic than `reason: 'branch-missing'`).

**Failure isolation**: if either lookup throws, the whole guard MUST return an `allow` decision. Rationale: a transient `gh` or `git` failure must not block a legitimate push (fail open). The refusal path is the anomaly detector, not the correctness gate — FR-001 (prune) and FR-004 (working-tree scope) are the correctness gates.

**Log side-effects**: the guard itself emits NO logs. The caller is responsible for the `event: 'push-refused'` log line (FR-003a) so the log is at the site that took action, not the site that computed the decision. Rationale: SC-002 asserts exactly one refusal log per refusal, which is easier to prove when the log is emitted from a single caller-side site.

## Test surface

Cases the SC-002 unit test MUST cover (matrix from spec.md § Success Criteria):

- PR merged + branch present → refuse `pr-merged`
- PR closed + branch present → refuse `pr-closed`
- PR merged + branch missing → refuse `pr-merged` (row 1 short-circuits)
- PR open + branch missing → refuse `branch-missing`
- PR open + branch present → allow
- No PR + branch present → allow (first-push case)
- No PR + branch missing → refuse `branch-missing`

Additional failure-isolation cases:

- `findPRForBranchAnyState` throws → allow (no refusal)
- `remoteBranchExists` throws → allow (no refusal)
