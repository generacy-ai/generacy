# Contract: `runMerge` (updated for #853)

**Module**: `packages/generacy/src/cli/commands/cockpit/merge.ts`
**Function**: `runMerge(input: RunMergeInput): Promise<RunMergeResult>`
**Delta reason**: Workflow labels are issue-scoped (#807-Q2 protocol). Reading `completed:validate` from `pr.labels` fails on every real epic. This contract moves the label check to the linked issue, adds a CLOSED-issue guard, and additively threads the issue ref through every red payload.

## Signature

Unchanged.

```ts
export interface RunMergeInput {
  gh: GhWrapper;
  issue: number;
  repo: string;          // "owner/repo"
  logger: Logger;
}

export interface RunMergeResult {
  exitCode: 0 | 1;
  stdout: string;
}

export async function runMerge(input: RunMergeInput): Promise<RunMergeResult>;
```

## Decision tree (happy path)

**Before**:

1. `resolveIssueToPRRef(repo, issue)` → `prRef | null`
   - `null` → `{status:'red', reason:'unresolved', pr:null, failingChecks:[]}`
2. `prRef.state !== 'OPEN'` → `{status:'red', reason:'unresolved', pr:{...}, failingChecks:[]}`
3. `getPullRequestDetail(repo, prRef.number)` → `pr`
4. `pr.labels.includes('completed:validate')` — **REMOVED**
   - Missing → `{status:'red', reason:'missing-label', pr:{...}, failingChecks:[]}`
5. `getRequiredCheckNames + getPullRequestCheckRuns` → `classifyChecks`
   - `!ok` → `{status:'red', reason:'checks-failing', pr:{...}, failingChecks:[...]}`
6. `mergePullRequest({squash: true})` → exit 0

**After**:

1. `resolveIssueToPRRef(repo, issue)` → `prRef | null`
   - `null` → `{status:'red', reason:'unresolved', pr:null, issue:{owner,repo,number}, failingChecks:[]}`
2. `prRef.state !== 'OPEN'` → `{status:'red', reason:'unresolved', pr:{...}, issue:{owner,repo,number}, failingChecks:[]}`
3. `getPullRequestDetail(repo, prRef.number)` → `pr`
4. **NEW** `try { issueState = await gh.fetchIssueState(repo, issue) } catch (err)`
   - Threw → `{status:'red', reason:'unresolved', pr:null, issue:{owner,repo,number}, failingChecks:[]}` (raw gh error to stderr)
5. **NEW** `issueState.state === 'CLOSED'`
   - True → `{status:'red', reason:'unresolved', pr:{...}, issue:{owner,repo,number,state,stateReason}, failingChecks:[]}`
6. **NEW** `issueState.labels.includes('completed:validate')` (ISSUE-scoped)
   - Missing → `{status:'red', reason:'missing-label', pr:{...}, issue:{owner,repo,number}, failingChecks:[]}`
7. `getRequiredCheckNames + getPullRequestCheckRuns` → `classifyChecks`
   - `!ok` → `{status:'red', reason:'checks-failing', pr:{...}, issue:{owner,repo,number}, failingChecks:[...]}`
8. `mergePullRequest({squash: true})` → exit 0

## Invariants

- **I-1 (label source)**: The `completed:validate` check MUST read from `IssueStateResult.labels`, not `PullRequestDetail.labels`. Verified by `merge.test.ts` fixture change (SC-004: no test sets `labels: ['completed:validate']` on a `PullRequestDetail` fixture as a merge precondition).
- **I-2 (ordering, Q1→B)**: The issue-label check MUST run *after* PR resolution (`resolveIssueToPRRef` → OPEN check → `getPullRequestDetail`). Preserves the `missing-label` non-null `pr` invariant that the cockpit plugin's `merge.md` decision table depends on.
- **I-3 (CLOSED-issue guard, Q3→A)**: When `issueState.state === 'CLOSED'`, `runMerge` MUST return a red payload with `issue.state` and `issue.stateReason` populated, and MUST NOT call `mergePullRequest`. Applies regardless of `stateReason` value.
- **I-4 (issue-fetch error, Q2→B)**: If `gh.fetchIssueState` throws, `runMerge` MUST return `{status:'red', reason:'unresolved', pr:null, issue:{owner,repo,number}, failingChecks:[]}`. The raw error MUST be written to stderr (via pino). No new `RedReason` enum value.
- **I-5 (payload ref presence)**: Every red payload emitted by `runMerge` after this PR MUST include `issue: {owner, repo, number}`. The `pr` field is unaffected — non-null on `missing-label`/`checks-failing`, nullable on `unresolved` as before.
- **I-6 (PR-scoped decision tree unchanged)**: Steps 3, 7, 8 (`getPullRequestDetail`, required-checks classification, squash-merge) MUST NOT change behavior. Existing test cases for `checks-failing` and the green path pass without behavioral edits (except for the additive `payload.issue` assertion).
- **I-7 (short-circuit)**: The label check (step 6) MUST run before `getRequiredCheckNames`/`getPullRequestCheckRuns` (step 7). The existing `short-circuits: missing-label is reported before checks are fetched` test locks this in.

## Failure modes

| Condition | Exit code | Payload `reason` | `pr` | `issue` extras |
|---|---|---|---|---|
| `resolveIssueToPRRef` returns `null` | 1 | `unresolved` | `null` | — |
| PR not OPEN | 1 | `unresolved` | `{number, url}` | — |
| `getPullRequestDetail` throws | 1 (uncaught) | (bubbles) | — | (out of scope; separate cleanup) |
| **NEW** `fetchIssueState` throws | 1 | `unresolved` | `null` | — (issue ref only, no state/stateReason) |
| **NEW** issue is CLOSED | 1 | `unresolved` | `{number, url}` | `state`, `stateReason` |
| Issue missing `completed:validate` | 1 | `missing-label` | `{number, url}` | — |
| Required check failing/pending/missing | 1 | `checks-failing` | `{number, url}` | — |
| `mergePullRequest` succeeds | 0 | — | — | — |

Every red row above additively carries `issue: {owner, repo, number}` in the payload (I-5).

## Stderr / logger lines

Existing (unchanged wording):
- `logger.error({ issue, repo }, 'No PR resolved for issue')`
- `logger.error({ issue, repo, pr, state }, 'PR is not OPEN')`
- `logger.warn('required-check set derived from PR check list; token cannot read branch protection')`
- `logger.error({ pr, failing }, 'PR has failing or pending required checks')`
- `logger.info({ pr }, 'PR merged')`

Rewritten (I-1):
- `logger.error({ issue, repo, missingLabel: 'completed:validate' }, 'Issue missing completed:validate label')` — previously named the PR.

New (I-3, I-4):
- `logger.error({ issue, repo, state, stateReason }, 'Issue is CLOSED')` — CLOSED-issue guard.
- `logger.error({ issue, repo, err: <error message> }, 'Failed to fetch issue state')` — `fetchIssueState` catch branch.

## Stdout (green path)

Unchanged: empty string, exit 0. The green path emits no stdout by design (only red outcomes produce JSON payloads).

## Dependencies on `@generacy-ai/cockpit`

- `GhWrapper.resolveIssueToPRRef(repo, issue)` — unchanged.
- `GhWrapper.getPullRequestDetail(repo, prNumber)` — unchanged.
- `GhWrapper.getRequiredCheckNames(repo, branch)` — unchanged.
- `GhWrapper.getPullRequestCheckRuns(repo, prNumber)` — unchanged.
- `GhWrapper.mergePullRequest(repo, prNumber, {squash:true})` — unchanged.
- **`GhWrapper.fetchIssueState(repo, issue)`** — MUST return the updated `IssueStateResult` shape with `stateReason: string | null`. Companion `packages/cockpit` change extends this (see `data-model.md`).

## Test signals

- **SC-001 (FR-007a)**: issue labeled `completed:validate` + PR unlabeled + green PR checks → `mergePullRequest` called once, exit 0, empty stdout. Counterexample to the tests-encode-the-bug pattern.
- **SC-002 (FR-007b)**: issue unlabeled + PR fixture would-be-labeled → red with `payload.reason: 'missing-label'`, `payload.pr` non-null, `payload.issue: {owner:'o', repo:'r', number:7}`. Deleting the fix (reverting to `pr.labels.includes(...)`) makes this test fail.
- **SC-003 (FR-007c)**: `fetchIssueState` returns `state:'CLOSED', stateReason:'completed'` + everything else green → red with `payload.reason: 'unresolved'`, `payload.issue.state: 'CLOSED'`, `payload.issue.stateReason: 'completed'`. `mergePullRequest` not called.
- **Q2→B path**: `fetchIssueState` throws → payload `{status:'red', reason:'unresolved', pr:null, issue:{owner,repo,number}, failingChecks:[]}`; error passed through pino serializer.
- **SC-004 (FR-008)**: no `PullRequestDetail` fixture in `merge.test.ts` uses `labels: ['completed:validate']` as a merge precondition. Meta-test asserts this against every exported fixture.
- **SC-005**: existing `merge.test.ts` cases for `checks-failing`, `unresolved (PR not OPEN)`, `unresolved (PR not found)`, and the `MISSING` synthesis pass with only the additive `expect(payload.issue).toEqual({owner:'o', repo:'r', number:7})` edit.
