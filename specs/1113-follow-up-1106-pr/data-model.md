# Data Model: Pin the PrSnapshot read-through path (#1113)

This is a test-only feature. No new entities or types are introduced. The relevant existing
types are referenced below for test construction.

## `PrSnapshot` (existing — `watch/snapshot.ts:20-33`)

The value cached in the read-through `SnapshotMap`. The test builds one via the existing
`fakePrSnapshot(repo, number, rollup)` helper.

```ts
interface PrSnapshot {
  kind: 'pr';
  repo: string;                 // original casing preserved on the value
  number: number;
  url: string;
  lifecycle: 'open' | 'closed' | 'merged';
  state: 'OPEN' | 'CLOSED';
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | null;
  labels: string[];
  classified: ClassifiedIssue;
  checksRollup: ChecksRollup;   // test uses 'success'
  headRefOid?: string;
  cyclesSinceLastCheckFetch: number;
}
```

## `SnapshotMap` (existing — `watch/snapshot.ts:36`)

```ts
type SnapshotKey = string;                 // `${repo.toLowerCase()}#${kind}#${number}`
type SnapshotMap = Map<SnapshotKey, Snapshot>;
```

Keys MUST be built via `snapshotKey(repo, 'pr', number)` on the **write** side (never inlined) —
this is the invariant under test. Injected into the source via `setPrev(source, prev)`.

## `snapshotKey` (existing — `watch/snapshot.ts:46-48`) — invariant under test

```ts
snapshotKey(repo, kind, number) === `${repo.toLowerCase()}#${kind}#${number}`
```

Case-insensitive: `snapshotKey('O/R','pr',42) === snapshotKey('o/r','pr',42) === 'o/r#pr#42'`.

## `ChecksRollup` → wire `checks` (existing `mapChecks` — `smee-source.ts:107-117`)

| `checksRollup` | wire `checks` | Used by test |
|----------------|---------------|--------------|
| `success`      | `green`       | ✅ (representative) |
| `failure`      | `red`         | — (covered by existing lowercase it.each) |
| `error`        | `red`         | — |
| `pending`      | `undefined`   | — (excluded: no mutation-sensitivity) |
| `none`         | `undefined`   | — |

## `CockpitStreamEvent` (`issue-transition` variant) — assertion target

The emitted event; the test asserts `ev.checks === 'green'`. Relevant discriminants:
`type === 'issue-transition'`, `event === 'pr-checks'` or (`event === 'label-change'` &&
`sourceLabel === 'completed:validate'`), `repo` = raw payload casing (`${owner}/${repo}`),
`number`, `checks: 'green' | 'red' | undefined`.

## Validation rules exercised

- Read-through branch fires only for `pr-checks` or `completed:validate` label-change events
  (`smee-source.ts:369-373`).
- `checks` is stamped only when `mapChecks(rollup) !== undefined` (`smee-source.ts:378`).
- Lookup key MUST equal the write-side key after `toLowerCase()` normalization — the property the
  new tests assert survives casing drift in both directions.
