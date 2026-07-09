# Phase 0 Research — #873 Closed-issue dominance in cockpit classifier

## Root-cause locus

- `packages/generacy/src/cli/commands/cockpit/watch/actionable.ts:22-26` — `isActionableSnapshot(snap)` scans `snap.labels[]` for `completed:validate`, `needs:intervention`, `agent:error`, `waiting-for:*`, `failed:*`. No check of `snap.state`.
- `packages/generacy/src/cli/commands/cockpit/watch/diff.ts:127-146` — `computeInitialSweep(curr, ts)` walks every snapshot in the first-poll `curr` map, filters by `isActionableSnapshot(snap)`, and emits one `label-change` event per match with `initial: true`. This is the "startup sweep" the operator sees.
- `packages/generacy/src/cli/commands/cockpit/status/row.ts:17-38` — `buildStatusRow()` populates `state: classified.state` (the label-derived `CockpitState`, e.g. `'terminal'`) and `sourceLabel: classified.sourceLabel` (e.g. `'completed:validate'`). Nothing carries `Issue.state` through.
- `packages/generacy/src/cli/commands/cockpit/status/render-table.ts:18-28` — `fmtRow(row, colorizer)` composes columns from `row.state` and `row.sourceLabel`. No branching on the underlying issue state (there was nothing to branch on).

## Decision 1: Shared predicate lives in `packages/generacy/src/cli/commands/cockpit/shared/`

**Rationale**: Q3-C selection. The invariant *"issue `state: closed` dominates any label-derived actionability tier"* is code-load-bearing (watch's initial sweep AND status's row renderer must honor it). Two guard sites cannot drift if there is one predicate to grep.

**Alternatives considered**:
- Q3-A (JSDoc at each guard site): PII-of-invariant is scattered; rot-prone.
- Q3-B (contract note in `specs/873-.../contracts/`): completed-spec-folder notes are where invariants go to die. The spec dir is not on the grep path future refactors traverse.
- Q3-D (all three): belt-and-braces is overkill; the answer is not "invariant is important therefore document it three times."

**File**: `packages/generacy/src/cli/commands/cockpit/shared/is-done-snapshot.ts` — sibling of `classify-issue.ts`. Same import surface as the classifier; both watch and status already reach into `shared/`.

## Decision 2: `Issue.stateReason` optional, propagated end-to-end

**Rationale**: Q4-B distinguishes `NOT_PLANNED` render from `COMPLETED` render but keeps actionability identical. The data-plane change is one optional field on `Issue`, one optional field on `IssueSnapshot`, one field on `StatusRow`. The `gh` CLI already returns `stateReason` — see `fetchIssueState()` at `packages/cockpit/src/gh/wrapper.ts:963`. It's only absent from `listIssues()` and `getIssue()`'s `--json` field lists because nothing needed it before.

**Alternatives considered**:
- Q4-A (identical treatment for both): loses signal an operator needs — `✓` on abandoned scope misreports progress.
- Q4-C (machine-readable only, identical render text): render text is *the* signal for an operator scanning terminal output; separating it from the JSON envelope is inconsistent.
- Ship `stateReason` on `Snapshot` only, not `Issue`: forces the snapshot builders to reach through to a separate `gh` call — extra I/O for a field the underlying JSON already carries.

**Implementation notes**:
- Extend `gh search issues --json` field list at `packages/cockpit/src/gh/wrapper.ts:525` to include `stateReason`.
- Extend `gh issue view --json` field list at `packages/cockpit/src/gh/wrapper.ts:545` to match.
- Extend `IssueRawSchema` at `packages/cockpit/src/gh/wrapper.ts:260` with `stateReason: z.string().nullable().optional()` — pattern already used at line 260 for `fetchIssueState`'s schema.
- Add `stateReason: string | null` to the `Issue` interface at `packages/cockpit/src/gh/wrapper.ts:7-16`. Normalize to `'COMPLETED' | 'NOT_PLANNED' | null` in the mapper — silently coerce unknown strings to `null` (defense against future GitHub API additions).

## Decision 3: `isDoneSnapshot` reads `snap.state`, not `snap.classified.state`

**Rationale**: `snap.state` is the raw GitHub issue state (`'OPEN' | 'CLOSED'`), which is the ground-truth data-plane signal. `snap.classified.state` is the label-tier vocabulary output (`'terminal' | 'active' | …`) — the exact thing this fix stops trusting. Reading `classified.state === 'terminal'` would perpetuate the same bug pattern (labels leaking into actionability decisions).

**Predicate body (draft)**:
```ts
export function isDoneSnapshot(snap: Snapshot): boolean {
  return snap.state === 'CLOSED';
}
```

**JSDoc host**: The invariant lives on this function (Q3-C answer). Text: *"Issue `state: closed` dominates any label-derived actionability tier — a closed issue carrying `completed:validate` (or any other actionable-label residue) is done, not actionable. This helper is the single decision surface: both `isActionableSnapshot` (watch) and `buildStatusRow`'s downstream renderer (status) route through it. If you need to expand actionability tiers, extend `isActionableSnapshot` — do not add a second done-gate."*

## Decision 4: Render `NOT_PLANNED` with `✗` and dim/red, not `✓` and green

**Rationale**: Q1-A (verbatim `✓ merged/closed` for merged) + Q4-B (distinguish `NOT_PLANNED`). Picking a distinct glyph (`✗`) and colour (dim, or red) makes the two closed states scannable at a glance without shouting. Dim is preferred over red — this is not an error, it is decided-not-done work.

**Palette**:
- `COMPLETED` (or null `stateReason` on a closed issue, defensive default): `✓ merged/closed` in green.
- `NOT_PLANNED`: `✗ closed (not planned)` in dim grey (chalk's `gray`).
- Open rows: unchanged.

**Alternatives considered**:
- `✗` in red: red typically signals error/failure; `not_planned` is a decision, not a failure.
- Suffix `(not planned)` on the title column instead of replacing state+source: harder to scan, hidden past `COL_TITLE=60` truncation.

## Decision 5: `computeInitialSweep` change is indirect via `isActionableSnapshot`

**Rationale**: `computeInitialSweep` at `diff.ts:132` already gates on `isActionableSnapshot(snap)`. Once the predicate short-circuits on `isDoneSnapshot`, the sweep is silent for closed rows automatically. Adding a second explicit gate before the predicate call would create two places future maintainers must keep in sync.

**Live open→closed transition**: The existing `diffIssue` at `diff.ts:82` emits exactly one `issue-closed` event with `to: 'terminal'`. Spec calls for exactly this — one terminal done line, no suggestion. The `CockpitEvent` shape carries no suggestion payload; downstream cockpit-watch skill infers "suggested" from the event kind, and an `issue-closed` event is not the shape that skill suggests a `/cockpit:merge` from (that keys off `completed:validate` seen on an OPEN issue). No change to `diffIssue` or `emit.ts` required.

## Decision 6: No `CockpitState` enum expansion

**Rationale**: Q2-C explicitly rejected. `CockpitState` is a label-tier classification vocabulary (`terminal` = label-derived). GitHub issue open/closed is a data-plane fact. Merging them into one enum re-conflates the exact axes this fix separates. `StatusRow.issueState` is a raw new field, orthogonal to `state: CockpitState`.

## Sources / references

- Spec: [spec.md](./spec.md)
- Clarifications: [clarifications.md](./clarifications.md) — Q1 (Q1-A), Q2 (Q2-A), Q3 (Q3-C), Q4 (Q4-B)
- Bug locus (live reproducer): `generacy-ai/tetrad-development#88` finding #32, sniplink epic #1 with closed children #2 + #3.
- Existing patterns:
  - `classify-issue.ts` — sibling in `cockpit/shared/`, pattern for a pure predicate module.
  - `IssueStateResult.stateReason` at `packages/cockpit/src/gh/wrapper.ts:95` — pattern for the field name and shape (`stateReason: string | null`).
  - `renderJsonEnvelope` at `packages/generacy/src/cli/commands/cockpit/status/render-table.ts:54` — envelope shape auto-extends with `StatusRow` field additions (no separate serializer to update).
