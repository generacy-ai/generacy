# Data Model: cockpit status renders phase grouping for epic children

**Issue**: [#828](https://github.com/generacy-ai/generacy/issues/828)
**Branch**: `828-found-during-cockpit-v1`

## Overview

Two entity changes:
1. `StatusRow` gains a nullable `phase` field.
2. `RowGroup` header semantics widen from "one epic header" to "one heading per `ParsedPhase` + optional `— (no phase) —` trailing group".

No new types are introduced. `ParsedPhase` and `IssueRef` are re-used from `@generacy-ai/cockpit` unchanged.

## Types

### `StatusRow` (modified)

```ts
// packages/generacy/src/cli/commands/cockpit/status/row.ts
export interface StatusRow {
  repo: string;
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  state: CockpitState;
  sourceLabel: string;
  prNumber: number | null;
  checks: 'pending' | 'success' | 'failure' | 'none';
  url: string;
  phase: string | null;  // NEW — ParsedPhase.token or null for "no phase"
}
```

**Validation rules**:
- `phase` when non-null MUST match the lowercase pattern used by `firstToken()` (`packages/cockpit/src/resolver/heading-match.ts`). No new runtime validation — trust the parser.
- Cross-phase duplicate refs emit multiple `StatusRow` values with the same `(repo, number)` but distinct `phase` tokens.
- A ref appearing in `allRefs` but no phase emits exactly one row with `phase: null`.

**Row identity**: `(repo, number, phase)`. For phase-less epics this degenerates to `(repo, number)`.

### `buildStatusRow` (modified signature)

```ts
export function buildStatusRow(
  repo: string,
  issue: Pick<Issue, 'number' | 'title' | 'url'>,
  classified: ClassifiedIssue,
  kind: 'issue' | 'pr',
  prNumber: number | null,
  checks: 'pending' | 'success' | 'failure' | 'none',
  phase: string | null,  // NEW required arg
): StatusRow;
```

### `RowGroup` (unchanged shape, new semantics)

```ts
// packages/generacy/src/cli/commands/cockpit/status/group.ts
export interface RowGroup {
  header: string;
  rows: StatusRow[];
}
```

**New semantics**:
- One `RowGroup` per `ParsedPhase` in body order.
- Optionally one trailing `RowGroup` with header `— (no phase) —` when there are unassigned rows OR the epic has zero phases (FR-004, FR-008).
- `header` format:
  - `— <heading> —` when `ParsedPhase.heading.toLowerCase() !== ParsedPhase.token`.
  - `— <TOKEN-UPPER> —` when `heading` matches `token` (label-less phase).
  - `— (no phase) —` for the trailing / phase-less-fallback group.

### `groupRows` (modified signature)

```ts
export function groupRows(
  rows: StatusRow[],
  phases: ParsedPhase[],
  epicOwnerRepo: string,
): RowGroup[];
```

**Behavior**:
1. Bucket `rows` by `row.phase` (string key or `null`).
2. Emit one `RowGroup` per `ParsedPhase` in body order; within each, sort rows by `ParsedPhase.refs` body order (join by `${repo}#${number}`).
3. Emit trailing `— (no phase) —` group when (a) any `null`-bucket rows exist OR (b) `phases.length === 0`.

**`epicOwnerRepo` parameter**: Currently unused post-refactor but preserved to keep the JSON path's flatten-in-order pattern symmetric. May be removed in a follow-up if unused.

### `StatusEnvelope` (unchanged shape, extended row schema)

```ts
// packages/generacy/src/cli/commands/cockpit/status/render-table.ts
export interface StatusEnvelope {
  scope: { kind: 'epic'; owner: string; repo: string; issue: number };
  rows: StatusRow[];  // now each row has `phase: string | null`
}
```

**Row ordering in envelope**: phase body order → within phase, `ParsedPhase.refs` body order → trailing `phase: null` rows last. Achieved by flattening `groupRows(...)` in group order (see research P3).

## Relationships

```
ParsedEpicBody (from @generacy-ai/cockpit, unchanged)
├── phases: ParsedPhase[]              ─┐  Consumed by status.ts
│   ├── heading: string                 │  to build memberships + groups.
│   ├── token: string                   │
│   └── refs: IssueRef[]                │
└── allRefs: IssueRef[]                ─┘  Consumed by status.ts for the
                                           batched `gh issue list` query
                                           and to seed the "no phase" bucket.
                     │
                     ▼
StatusRow[] (one per (issue × phase membership))
  ├── phase: string | null               ← New; = ParsedPhase.token or null
  └── ...existing fields
                     │
                     ▼
RowGroup[] (one per phase + optional trailing "no phase")
  ├── header: string                     ← New format from ParsedPhase.heading
  └── rows: StatusRow[]                  ← Sorted by ParsedPhase.refs order

Consumed by:
  ├── renderTable(groups, options) → stdout table
  └── renderJsonEnvelope(epic, groups.flatMap(g => g.rows)) → --json output
```

## Invariants

| # | Invariant | Enforced by |
|---|-----------|-------------|
| I1 | Every `StatusRow.phase` is either `null` or equal to some `ParsedPhase.token` in the same `ResolvedEpic`. | `status.ts` row emission loop |
| I2 | Group count = `phases.length + (hasNullBucket \|\| phases.length === 0 ? 1 : 0)`. | `groupRows` |
| I3 | For any `ParsedPhase`, the row set in its group equals the subset of `rows` where `row.phase === phase.token`. | `groupRows` bucket step |
| I4 | Row order within a group matches `ParsedPhase.refs` body order (by `${repo}#${number}`). | `groupRows` sort step |
| I5 | `JSON.parse(env).rows.length >= parsed.allRefs.length` (equality when no ref is under multiple phases). | Row emission loop in `status.ts` |
| I6 | `renderTable` and `renderJsonEnvelope` iterate rows in the same order (flatten of `groupRows(...)`). | `render-table.ts` |
| I7 | Fetching/PR/check semantics are unchanged: for a given `(repo, number)`, all emitted rows share identical `state`, `sourceLabel`, `prNumber`, `checks`, `title`, `url`. | `status.ts` (single fetch, emit N times) |

## Migration Notes

- Existing consumers of the `--json` envelope get `phase: string | null` added to every row. Backward-compatible (additive).
- Existing consumers relying on `rows.length === allRefs.length` may see `>`. FR-006 documents this; no known consumer today.
- Test `status.render.test.ts:53-64` ("epic mode flattens rows under a single header sorted by number") is deleted, not migrated — it asserts behavior that this issue explicitly removes.
