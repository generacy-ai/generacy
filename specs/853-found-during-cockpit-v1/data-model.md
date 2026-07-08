# Data Model: `cockpit merge` issue-scoped label check (#853)

This change introduces **no new persisted state** and **no new relay payloads**. It extends two existing type surfaces additively:

1. `FailingCheckPayload` gains an optional `issue` field (with optional `state`/`stateReason` sub-fields on the CLOSED-issue red branch).
2. `IssueStateResult` gains an optional-nullable `stateReason` field.

The shared JSON Schema (`failing-check.schema.json`) is relaxed to admit these fields — no existing property changes.

## Modified types

### `FailingCheckPayload` (`packages/generacy/src/cli/commands/cockpit/shared/failing-check-json.ts`)

**Before**:

```ts
export type RedReason = 'checks-failing' | 'missing-label' | 'unresolved';

export interface FailingCheckPayload {
  status: 'red';
  reason: RedReason;
  pr: { number: number; url: string } | null;
  failingChecks: FailingCheck[];
}

export interface BuildFailingCheckInput {
  reason: RedReason;
  pr: { number: number; url: string } | null;
  failingChecks?: FailingCheck[];
}
```

**After**:

```ts
export type RedReason = 'checks-failing' | 'missing-label' | 'unresolved';   // ← UNCHANGED (Q2→B)

export interface IssueRefWithState {
  owner: string;
  repo: string;
  number: number;
  state?: 'OPEN' | 'CLOSED';           // ← present only on CLOSED-issue red branch
  stateReason?: string | null;         // ← present only on CLOSED-issue red branch; null when gh doesn't surface a reason
}

export interface FailingCheckPayload {
  status: 'red';
  reason: RedReason;
  pr: { number: number; url: string } | null;
  failingChecks: FailingCheck[];
  issue?: IssueRefWithState;           // ← NEW; present on every red payload emitted by runMerge after this PR
}

export interface BuildFailingCheckInput {
  reason: RedReason;
  pr: { number: number; url: string } | null;
  failingChecks?: FailingCheck[];
  issue?: IssueRefWithState;           // ← NEW
}
```

### `buildFailingCheckPayload` — invariants

Existing invariants preserved:
- `reason='unresolved'` → `failingChecks` MUST be empty; `pr` MAY be null.
- `reason='missing-label'` → `pr` MUST be non-null; `failingChecks` MUST be empty.
- `reason='checks-failing'` → `pr` MUST be non-null; `failingChecks` MUST be non-empty.

New invariants added:
- **I-5 (issue-ref presence)**: When `input.issue` is provided, it is pass-through into the payload. `buildFailingCheckPayload` does not synthesize an `issue` — callers own emitting it.
- **I-6 (state fields are paired)**: If `input.issue.state` is set, `input.issue.stateReason` MUST also be set (even if `null`). Enforced by a runtime check that throws on partial state fields (defensive; keeps consumers from having to guess whether `stateReason` was intentionally absent vs. absent-but-unknown).
- **I-7 (state fields are only on CLOSED-issue red branches)**: This is a caller contract, not a builder-enforced check — `runMerge` only sets `state`/`stateReason` on the CLOSED-issue guard branch. The builder allows any red branch to carry them (for testability), but the CLI only emits them on that one branch.

### `IssueStateResult` (`packages/cockpit/src/gh/wrapper.ts`)

**Before**:

```ts
export interface IssueStateResult {
  state: 'OPEN' | 'CLOSED';
  closedAt: string | null;
  labels: string[];
  assignees: string[];
  title: string;
}
```

**After**:

```ts
export interface IssueStateResult {
  state: 'OPEN' | 'CLOSED';
  stateReason: string | null;    // ← NEW; null when gh returns no state_reason (e.g., OPEN issues, legacy closes)
  closedAt: string | null;
  labels: string[];
  assignees: string[];
  title: string;
}
```

Corresponding Zod schema:

```ts
const IssueStateRawSchema = z.object({
  state: z.string(),
  stateReason: z.string().nullable().optional(),   // ← NEW; maps to null in the wrapper when absent
  closedAt: z.string().nullable().optional(),
  labels: z.array(LabelLikeSchema).default([]),
  assignees: z.array(z.object({ login: z.string() }).passthrough()).default([]),
  title: z.string().default(''),
});
```

And in `fetchIssueState`, the gh `--json` argument gains `stateReason`:

```ts
// Before: '--json', 'state,closedAt,labels,assignees,title'
// After:  '--json', 'state,stateReason,closedAt,labels,assignees,title'
```

Wrapper mapping (in the `fetchIssueState` return construction):

```ts
return {
  state: normalizeIssueState(shape.data.state),
  stateReason: shape.data.stateReason ?? null,   // ← NEW; undefined → null
  closedAt: shape.data.closedAt ?? null,
  labels: extractLabelNames(shape.data.labels),
  assignees: shape.data.assignees.map((a) => a.login),
  title: shape.data.title,
};
```

## Types referenced (unchanged)

- `RedReason` — enum stays `'checks-failing' | 'missing-label' | 'unresolved'` (Q2→B: no new value).
- `PullRequestRef` (`packages/cockpit/src/gh/wrapper.ts`) — unchanged.
- `PullRequestDetail` (`packages/cockpit/src/gh/wrapper.ts`) — `labels: string[]` still present but no longer read by post-fix `runMerge`.
- `FailingCheck` (`packages/generacy/src/cli/commands/cockpit/shared/required-checks.ts`) — unchanged.
- `IssueRef` (`packages/generacy/src/cli/commands/cockpit/resolver.ts`) — the CLI's parsed `{owner, repo, number, nwo}` shape; `runMerge` receives `issue: number` and `repo: string` today, and splits `repo` on `/` to synthesize `{owner, repo, number}` for the payload's `issue` field. Alternative would be to thread `IssueRef` through `RunMergeInput` — considered but rejected as unnecessary API-surface churn for this fix.

## Label-source invariant (behavioral, not typed)

This change enforces at the CLI layer an invariant already documented at the protocol layer:

> **Workflow labels (`waiting-for:*`, `completed:*`) live on the linked ISSUE, not the PR.**
>
> - The orchestrator (`label-monitor-service.ts`) reads them from the issue via `fetchIssueState`.
> - `runMerge` MUST also read `completed:validate` from the issue via `fetchIssueState` after this fix.
> - No code path in the CLI reads workflow labels from `PullRequestDetail.labels` after this fix.

This invariant is documented in the rewritten `runMerge` header comment (see `contracts/merge-command.md`) and in `tetrad-development/docs/label-protocol.md` (already authoritative).

## Payload emission (behavioral, per red branch)

Every red payload emitted by post-fix `runMerge` carries `issue: {owner, repo, number}` (derived from `RunMergeInput.repo` and `RunMergeInput.issue`):

| Red branch | `reason` | `pr` | `issue` fields |
|---|---|---|---|
| PR-not-found (step 1) | `unresolved` | `null` | `{owner, repo, number}` |
| PR not OPEN (step 2) | `unresolved` | `{number, url}` | `{owner, repo, number}` |
| `fetchIssueState` throws (step 4) | `unresolved` | `null` | `{owner, repo, number}` |
| Issue CLOSED (step 5) | `unresolved` | `{number, url}` | `{owner, repo, number, state, stateReason}` |
| Issue missing label (step 6) | `missing-label` | `{number, url}` | `{owner, repo, number}` |
| Checks failing (step 7) | `checks-failing` | `{number, url}` | `{owner, repo, number}` |

Green path (step 8 → `mergePullRequest`): exit 0, empty stdout — unchanged.
