# Contract: `derivePrChecksNeeded`

Pure function that decides whether `getPullRequestCheckRuns` needs to run for a given PR this cycle. Sibling to `derivePrLifecycle` in `pr-state.ts`, mirroring the D5 optimization.

## Signature

```ts
export interface DerivePrChecksNeededInput {
  prevSnapshot: PrSnapshot | undefined;
  currentLifecycle: PrLifecycle;
  currentLabels: string[];
  currentHeadRefOid: string | undefined;
  cyclesSinceLastCheckFetch: number;
  /** Safety cadence in cycles. Default 20 (≈10 min at 30 s poll cadence). */
  safetyCycles?: number;
}

export type PrChecksNeededReason =
  | 'no-prev'
  | 'lifecycle-flip'
  | 'head-changed'
  | 'label-changed'
  | 'safety-cycle'
  | 'not-terminal'
  | 'skip-terminal';

export interface PrChecksNeededDecision {
  fetch: boolean;
  reason: PrChecksNeededReason;
}

export function derivePrChecksNeeded(input: DerivePrChecksNeededInput): PrChecksNeededDecision;
```

## Decision tree

```
1. prevSnapshot == null
   → { fetch: true, reason: 'no-prev' }

2. currentLifecycle in ('merged', 'closed')
   → { fetch: false, reason: 'skip-terminal' }

3. prevSnapshot.lifecycle !== 'open' AND currentLifecycle === 'open'
   (lifecycle flip toward active — must re-check)
   → { fetch: true, reason: 'lifecycle-flip' }

4. prevSnapshot.checksRollup not in ('success')
   → { fetch: true, reason: 'not-terminal' }

5. currentHeadRefOid != null AND prevSnapshot.headRefOid != null
   AND currentHeadRefOid !== prevSnapshot.headRefOid
   → { fetch: true, reason: 'head-changed' }

6. labelSet(currentLabels) !== labelSet(prevSnapshot.labels)  (set equality, order-insensitive)
   → { fetch: true, reason: 'label-changed' }

7. cyclesSinceLastCheckFetch >= safetyCycles (default 20)
   → { fetch: true, reason: 'safety-cycle' }

8. otherwise
   → { fetch: false, reason: 'skip-terminal' }
```

## Invariants

- **I-1**: PURE — no I/O, no logging, no external state. `derivePrChecksNeeded` is safe to call in a test hot loop.
- **I-2**: Deterministic — same input → same output.
- **I-3**: `fetch === false` is only ever returned in the terminal-green paths (2, 8). All non-terminal snapshots fetch.
- **I-4**: `reason` is a stable identifier — never localized, safe to log or assert on.
- **I-5**: Missing `currentHeadRefOid` (undefined) never triggers a `head-changed` fetch (branch 5 has both-non-null guard). This lets the very first observation flow through the label / safety / lifecycle branches without spuriously fetching.

## Rationale for branch ordering

- Branch 3 (`lifecycle-flip`) comes before branch 4 (`not-terminal`) so a PR that transitions `closed → open` (rare but possible) always re-checks even if prev.rollup was, say, `'success'` at time of close.
- Branch 5 (`head-changed`) comes before branch 6 (`label-changed`) because head changes are the more common invalidator during active development, but the tests must not depend on this ordering (any of the true-returning branches is a correct answer for a case that hits both).

## Test matrix

| # | prev | currLifecycle | headChg | labelChg | cyclesGE20 | expected |
|---|---|---|---|---|---|---|
| 1 | null | open | - | - | - | true / no-prev |
| 2 | any | merged | - | - | - | false / skip-terminal |
| 3 | any | closed | - | - | - | false / skip-terminal |
| 4 | closed+success | open | - | - | - | true / lifecycle-flip |
| 5 | open+pending | open | - | - | - | true / not-terminal |
| 6 | open+failure | open | - | - | - | true / not-terminal |
| 7 | open+none | open | - | - | - | true / not-terminal |
| 8 | open+error | open | - | - | - | true / not-terminal |
| 9 | open+success | open | y | - | - | true / head-changed |
| 10 | open+success | open | - | y | - | true / label-changed |
| 11 | open+success | open | - | - | y | true / safety-cycle |
| 12 | open+success | open | - | - | - | false / skip-terminal |
| 13 | open+success (no prev headOid) | open | - | - | - | false / skip-terminal |
