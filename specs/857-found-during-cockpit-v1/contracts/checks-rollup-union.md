# Contract: `ChecksRollup` union widening + `actionable`/`diff` semantics

**Files**:
- `packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts` (union declaration)
- `packages/generacy/src/cli/commands/cockpit/watch/check-rollup.ts` (`rollup()` producer)
- `packages/generacy/src/cli/commands/cockpit/watch/actionable.ts` (consumer — no change)
- `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` (consumer — no change)
- `packages/generacy/src/cli/commands/cockpit/status/row.ts` (`StatusRow.checks` union)
- `packages/generacy/src/cli/commands/cockpit/status.ts` (catch-block mapping)
- `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts` (catch-block mapping)

## Union declaration

```ts
export type ChecksRollup = 'pending' | 'success' | 'failure' | 'none' | 'error';
```

- **`'pending'`** — non-empty check-run list, at least one non-terminal state.
- **`'success'`** — non-empty check-run list, all terminal-success (SUCCESS/NEUTRAL/SKIPPED).
- **`'failure'`** — any check-run in state FAILURE or CANCELLED.
- **`'none'`** — wrapper returned `[]` (no CI reported on the ref). Legitimate data.
- **`'error'`** — consumer caught a real error from the wrapper (fetch failed). Observability signal.

## `rollup(checks: CheckRunSummary[])` — post-fix behavior

```
checks.length === 0             → 'none'    (was 'pending' — this is the change)
any check.state === 'FAILURE'   → 'failure'
any check.state === 'CANCELLED' → 'failure'
all check.state in {SUCCESS, NEUTRAL, SKIPPED} → 'success'
otherwise                       → 'pending'
```

`rollup()` never returns `'error'` and never throws. `'error'` is exclusively produced by consumer catch-blocks around `getPullRequestCheckRuns` calls.

## Consumer contract: `actionable.ts`

**Unchanged code**:

```ts
export function isActionableSnapshot(snap: Snapshot): boolean {
  if (snap.labels.some(isActionableLabel)) return true;
  if (snap.kind === 'pr' && snap.checksRollup === 'failure') return true;
  return false;
}
```

**Effect on new members**:
- `'none'` → falls through `checksRollup === 'failure'` → non-actionable. ✓ (matches "no CI is not red").
- `'error'` → falls through → non-actionable. ✓ (matches "gh failure is not a red PR").

No code change; the union widening is source-compatible via the `===` comparison.

## Consumer contract: `diff.ts`

**Unchanged code**:

```ts
if (prev.checksRollup !== curr.checksRollup) {
  out.push(makeEvent(curr, 'pr-checks', ...));
}
```

**Effect on new members**:
- `'pending' → 'none'` emits `pr-checks` event. ✓
- `'none' → 'success'` emits `pr-checks` event. ✓ (repo gains CI mid-watch — a real observable event).
- `'success' → 'error'` emits `pr-checks` event. ✓ (gh started failing — real observability signal).
- `'error' → 'success'` emits `pr-checks` event. ✓ (recovered).
- `'none' → 'error'` emits `pr-checks` event. ✓
- `'error' → 'none'` emits `pr-checks` event. ✓

Event's `from` and `to` state fields carry the classified state (unchanged); the rollup transition itself is expressed as the mere presence of a `pr-checks` event. Consumers reading transitions from event streams see the same list-of-events format as before, just with two new legitimate rollup values.

## Consumer contract: `status.ts` catch mapping

**Before**:
```ts
try {
  const checkRuns = await gh.getPullRequestCheckRuns(repo, prNumber);
  checks = rollup(checkRuns);
} catch {
  checks = 'none';  // ← the conflation this fix undoes
}
```

**After**:
```ts
try {
  const checkRuns = await gh.getPullRequestCheckRuns(repo, prNumber);
  checks = rollup(checkRuns);  // ← may be 'none' if wrapper returned []
} catch {
  checks = 'error';  // ← real fetch failures now distinct
}
```

## Consumer contract: `watch/poll-loop.ts` catch mapping

**Before**:
```ts
let checks: CheckRunSummary[];
try {
  checks = await deps.gh.getPullRequestCheckRuns(repo, issue.number);
} catch {
  checks = [];  // ← after which rollup([]) === 'pending' pre-fix, 'none' post-fix (either way, conflated)
}
snapshot = buildPrSnapshot(repo, issue, classified, lifecycle, rollup(checks));
```

**After**:
```ts
let checksResult: ChecksRollup;
try {
  checksResult = rollup(await deps.gh.getPullRequestCheckRuns(repo, issue.number));
} catch {
  checksResult = 'error';  // ← direct sentinel; no ambiguous [] intermediate
}
snapshot = buildPrSnapshot(repo, issue, classified, lifecycle, checksResult);
```

The empty-result case flows through the try branch (`rollup([]) === 'none'`) — the catch is only for real errors. `'none'` and `'error'` are now cleanly separated at the producer boundary.

## Regression tests (per FR-007, FR-009, FR-010)

- `watch.check-rollup.test.ts`:
  - `rollup([])` returns `'none'` (was `'pending'`).
  - `rollup([{name:'a', state:'PENDING'}])` returns `'pending'` (unchanged non-empty behavior).
  - `rollup([{name:'a', state:'SUCCESS'}])` returns `'success'` (unchanged).
  - `rollup([{name:'a', state:'FAILURE'}])` returns `'failure'` (unchanged).
- `watch.actionable.test.ts`:
  - PR snapshot with `checksRollup === 'none'` and no actionable labels → NOT actionable.
  - PR snapshot with `checksRollup === 'error'` and no actionable labels → NOT actionable.
  - PR snapshot with `checksRollup === 'failure'` → actionable (unchanged).
- `watch.diff.test.ts`:
  - Prev `pending` → curr `none` emits one `pr-checks` event.
  - Prev `none` → curr `success` emits one `pr-checks` event.
  - Prev `success` → curr `error` emits one `pr-checks` event.
- `status.test.ts`:
  - Real fetch error → row's `checks === 'error'` (distinct from `'none'`).
  - Wrapper resolves `[]` → row's `checks === 'none'`.

## Not in scope

- Renderer visual style for `'error'` (default `padEnd` display is sufficient for FR-004/FR-009 — the string `error` appears in the checks column).
- Structured warn log at status/watch catch sites (the wrapper's log is authoritative; no CLI-layer duplicate).
- Backwards-compat re-alias of the pre-fix union (no consumer imports the union by shape; all imports are `type ChecksRollup`).
- Persisted state or relay-payload changes (union is CLI-only).
