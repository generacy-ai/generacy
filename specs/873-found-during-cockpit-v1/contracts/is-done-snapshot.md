# Contract: `isDoneSnapshot(snap)` — the single done-gate

**Location**: `packages/generacy/src/cli/commands/cockpit/shared/is-done-snapshot.ts`
**Consumers**: `watch/actionable.ts` (direct), `status/render-table.ts` (indirect via `StatusRow.issueState`), any future actionability tier.

## Signature

```ts
export function isDoneSnapshot(snap: Snapshot): boolean;
```

## Invariant

> **Issue `state: closed` dominates any label-derived actionability tier.**

A closed issue carrying `completed:validate`, `waiting-for:*`, `failed:*`, `needs:intervention`, `agent:error`, or any other actionable-label token is done — never actionable. This applies uniformly to `IssueSnapshot` and `PrSnapshot` (though PRs use their own `lifecycle` state for closed/merged handling in `diffPr`, and this predicate is only queried on the actionability path).

## Return value

- `true` iff `snap.state === 'CLOSED'`.
- `false` iff `snap.state === 'OPEN'`.

The predicate is unaffected by `snap.stateReason` — both `COMPLETED` and `NOT_PLANNED` are equally done for actionability purposes (Q4-B applies to *rendering* only). It is unaffected by `snap.labels` — that is exactly the residue this fix stops trusting. It is unaffected by `snap.classified.state` — that is a label-derived tier, which reading here would recreate the bug pattern.

## Non-obligations

- Does NOT emit any event, log, or side-effect. Pure function.
- Does NOT check PR lifecycle (`snap.lifecycle === 'merged'`). A merged PR whose issue is still OPEN would return `false` — this is correct, because the underlying issue is still an actionable candidate. (`PrSnapshot.state === 'CLOSED'` covers the merged-PR case.)
- Does NOT normalize labels. Labels are ignored entirely.

## Composition contract with `isActionableSnapshot`

```ts
export function isActionableSnapshot(snap: Snapshot): boolean {
  if (isDoneSnapshot(snap)) return false;
  // ... existing label + checks-rollup gates unchanged ...
}
```

`isDoneSnapshot` MUST run first. Reordering (label check first, done check second) is functionally identical today but loses the "single-line assertion of the invariant" property — any future actionability tier added below the label check would need its own duplicate `isDoneSnapshot` gate.

## Grep audit (SC-005)

The invariant text lives on `isDoneSnapshot`'s JSDoc and NOWHERE else in `packages/generacy/src/cli/commands/cockpit/`. Regression check (manual pre-review):

```bash
rg -n "state: closed dominates|closed dominates|issueState === 'CLOSED'" \
   packages/generacy/src/cli/commands/cockpit/ \
   packages/cockpit/src/
```

Expected matches:
- Exactly one occurrence of "closed dominates" (the JSDoc on `isDoneSnapshot`).
- One occurrence of `issueState === 'CLOSED'` in `render-table.ts::fmtRow` (the render-branch, orthogonal concern).
- Test files may reference either string in `describe`/`it` labels — allowed.

## Test surface

Co-located `is-done-snapshot.test.ts` covers:

- `{ kind: 'issue', state: 'OPEN', labels: [] }` → `false`.
- `{ kind: 'issue', state: 'OPEN', labels: ['completed:validate'] }` → `false`.
- `{ kind: 'issue', state: 'CLOSED', labels: [] }` → `true`.
- `{ kind: 'issue', state: 'CLOSED', labels: ['completed:validate'] }` → `true`. **← regression case for #873.**
- `{ kind: 'issue', state: 'CLOSED', stateReason: 'COMPLETED' }` → `true`.
- `{ kind: 'issue', state: 'CLOSED', stateReason: 'NOT_PLANNED' }` → `true`.
- `{ kind: 'pr', state: 'OPEN', lifecycle: 'open', … }` → `false`.
- `{ kind: 'pr', state: 'CLOSED', lifecycle: 'merged', … }` → `true`.
