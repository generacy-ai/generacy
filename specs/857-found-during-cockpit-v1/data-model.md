# Data Model: #857

Type-only changes across `packages/cockpit` and `packages/generacy`. No new persisted state, no new relay payloads.

## Type deltas

### `ChecksRollup` — `packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts`

**Before**:
```ts
export type ChecksRollup = 'pending' | 'success' | 'failure';
```

**After**:
```ts
export type ChecksRollup = 'pending' | 'success' | 'failure' | 'none' | 'error';
```

**Semantics**:

| Value       | Producer                                                                 | Meaning                                                             |
|-------------|--------------------------------------------------------------------------|---------------------------------------------------------------------|
| `'pending'` | `rollup(checks)` — non-empty list with at least one non-terminal state   | CI is running or partially reported; check again later              |
| `'success'` | `rollup(checks)` — non-empty list, all states are terminal-success       | All reported checks passed                                          |
| `'failure'` | `rollup(checks)` — any state is `FAILURE` or `CANCELLED`                 | At least one reported check failed                                  |
| `'none'`    | `rollup([])` — wrapper returned empty list (no checks reported)          | Repo has no CI on this ref (legitimate steady state)                |
| `'error'`   | Consumer catch-block — wrapper threw a real error                        | gh call failed (auth, network, malformed JSON); observability gap   |

**Invariants**:
- `'none'` is inherently non-actionable (`actionable.ts` treats it as such via the `checksRollup === 'failure'` filter).
- `'error'` is inherently non-actionable (a gh failure is not a red PR).
- Transitions to/from `'none'` (e.g., `none → success` when a repo adds CI mid-watch) emit a `pr-checks` diff event via the existing `!==` semantics (`diff.ts:113`).
- Transitions to/from `'error'` also emit `pr-checks` events (honest noise about a real observability gap).
- `'none'` and `'error'` never appear in `rollup()`'s return value together — `rollup([])` is `'none'`; `rollup()` never throws.

### `StatusRow.checks` — `packages/generacy/src/cli/commands/cockpit/status/row.ts`

**Before**:
```ts
checks: 'pending' | 'success' | 'failure' | 'none';
```

**After**:
```ts
checks: 'pending' | 'success' | 'failure' | 'none' | 'error';
```

**Semantics**: identical to `ChecksRollup` — `StatusRow.checks` is populated from `rollup(checkRuns)` when the wrapper resolves, or `'error'` when it throws. Renderers (`renderTable`, `renderJsonEnvelope`) use `String.padEnd`, so widening is source-compatible.

### `CheckRunSummary` — `packages/cockpit/src/gh/wrapper.ts`

**Unchanged** from post-#855:
```ts
export interface CheckRunSummary {
  name: string;
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
  url?: string;
}
```

The no-checks case is expressed by returning `[]` from `getPullRequestCheckRuns`, not by adding a new sentinel to `CheckRunSummary.state`. The `CheckRunSummary[]` shape is unchanged.

### `RunMergeResult` — `packages/generacy/src/cli/commands/cockpit/merge.ts`

**Unchanged** shape:
```ts
export interface RunMergeResult {
  exitCode: 0 | 1;
  stdout: string;
}
```

**Behavioral change**: on the vacuous-green path, `stdout` now carries the FR-003 note (`no checks configured and none required — proceeding on completed:validate\n`) instead of the empty string. Existing red path (`exitCode: 1`, `stdout: <JSON envelope>`) is unchanged.

**Invariants after fix**:
- `exitCode === 0` iff the merge succeeded.
- `stdout.length > 0 && exitCode === 0` → vacuous-green path fired; `stdout` is the FR-003 note (single line, terminating newline).
- `stdout.length > 0 && exitCode === 1` → red path; `stdout` is a JSON envelope from `serializeFailingCheckJson(...)`.
- `stdout.length === 0 && exitCode === 0` → non-vacuous green (checks reported and passed, or checks reported and required set matched); pre-existing behavior.

### `FailingCheck.state` — `packages/generacy/src/cli/commands/cockpit/shared/required-checks.ts`

**Unchanged**:
```ts
export type FailingCheckState =
  | 'FAILURE'
  | 'PENDING'
  | 'NEUTRAL'
  | 'SKIPPED'
  | 'CANCELLED'
  | 'MISSING';
```

The `'MISSING'` state (already handled at `required-checks.ts:44-46`) is the exact vocabulary for the "required-set-non-empty + contexts-absent" red-path case: `classifyChecks` emits one `FailingCheck { name, state: 'MISSING' }` per required context absent from the empty actual list. The red-payload emitted by `runMerge` names each missing context by its `name` — the operator sees exactly which required contexts are absent.

## Validation rules

No new Zod schemas. Existing schemas (`CheckRunRawSchema`, `BranchProtectionRawSchema` in `packages/cockpit/src/gh/wrapper.ts`) are unchanged.

Detection of the "no checks reported" case is a runtime substring test (`stderr.toLowerCase().includes('no checks reported')`) — not a schema. See `contracts/get-pull-request-check-runs.md` for the exact condition.

## Relationships

```
   ┌─────────────────────────────────────────┐
   │ getPullRequestCheckRuns(repo, prNumber) │
   └─────────────────────────────────────────┘
                    │
       ┌────────────┴─────────────┐
       │                          │
       ▼ resolves []              ▼ throws Error
 ┌───────────────┐         ┌────────────────┐
 │ empty result  │         │ wrapper warn   │
 │ (no checks    │         │ + rethrow      │
 │  on branch)   │         └────────────────┘
 └───────────────┘                  │
       │                            │
       ├── consumed by rollup()     ├── consumed by status catch → 'error'
       │        │                   │
       │        ▼                   ├── consumed by poll-loop catch → 'error'
       │   'none'                   │
       │        │                   └── consumed by merge (throw bubbles as before)
       │        ▼
       │   ChecksRollup ─────────► actionable.ts (never actionable)
       │        │                   diff.ts       (emits pr-checks on transition)
       │        ▼
       └── consumed by merge:
            noRequired?
              yes → vacuous green + FR-003 note + merge
              no  → classifyChecks emits MISSING per required → red payload
```

## Test fixture shapes

### `no-checks-reported` gh stderr fixture

```
no checks reported on the '002-phase-1-foundation-part' branch
```

Exit code: `1`. Stdout: empty. Used in `gh-wrapper.test.ts` for the new positive test.

### CI-less + `completed:validate` fixture for `merge.test.ts`

```ts
const gh = fakeGh({
  resolveIssueToPRRef: { number: 16, url: 'https://github.com/x/y/pull/16', state: 'OPEN', draft: false, headRefName: '002-phase-1-foundation-part' },
  getPullRequestDetail: { number: 16, base: 'main', /* … */ },
  fetchIssueState: { state: 'OPEN', labels: ['completed:validate'], /* … */ },
  getRequiredCheckNames: { source: 'fallback-pr-checks', names: null },
  getPullRequestCheckRuns: [],  // empty — no CI configured
  mergePullRequest: { merged: true, commitSha: 'abc123' },
});
// Assert: result.exitCode === 0
// Assert: result.stdout === 'no checks configured and none required — proceeding on completed:validate\n'
```

### Branch-protection required + no actual fixture for `merge.test.ts`

```ts
const gh = fakeGh({
  // …same as above except…
  getRequiredCheckNames: { source: 'branch-protection', names: ['ci/test', 'ci/lint'] },
  getPullRequestCheckRuns: [],
});
// Assert: result.exitCode === 1
// Assert: JSON.parse(result.stdout).failingChecks.map(c => c.name) === ['ci/test', 'ci/lint']
// Assert: every failingChecks[i].state === 'MISSING'
// Assert: JSON.parse(result.stdout).reason === 'checks-failing'
```
