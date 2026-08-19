# Research: Pin the PrSnapshot read-through path (#1113)

## Decision 1 — Repo casing values in the harness

**Decision**: Express casing drift with variants of `o/r` (`O/R` vs `o/r`), not the spec's
`Painworth/Doc-Intel`.

**Rationale**: `resolveEpic` is module-mocked to `FAKE_RESOLVED` (`smee-source.integration.test.ts:147-162`),
which fixes the watched repo to `o/r` and the ref to `o/r#42`. `buildRefSet` performs
case-insensitive membership (#1106 fix), so any payload whose lowercased repo ≠ `o/r` is dropped
in `webhookToStreamEvent` before reaching the read-through branch at `smee-source.ts:369-382`.
`Painworth/Doc-Intel` → `painworth/doc-intel` ≠ `o/r` ⇒ dropped ⇒ test would time out at
`waitFor(() => events.length >= 1)`. Using `O/R`/`o/r` keeps the same casing-drift semantics
while remaining inside the mocked ref set. The precedent test at line 209 already uses `O`/`R`.

**Alternatives considered**:
- Re-define `FAKE_RESOLVED` to `Painworth/Doc-Intel`: it is a module-level const shared by all
  tests; mutating it risks the other suites and buys nothing over `O/R`.
- Per-test `vi.mock` override of `resolveEpic`: heavier, unnecessary; the casing dimension is
  fully expressed by owner/repo casing on the payload frame.

## Decision 2 — Which casing direction kills the target mutation

**Decision**: Cover both directions (FR-003 / Q1=B); the **read-mixed** direction is the one that
kills the `smee-source.ts:375` inline mutation.

**Analysis** (write key is always lowercased by `snapshotKey`, `snapshot.ts:47`; `ev.repo` is raw
payload casing, `webhook-to-event.ts:132`):

| Direction | Write key | `ev.repo` | Fixed lookup `snapshotKey(ev.repo,…)` | Mutated inline `` `${ev.repo}#pr#N` `` |
|-----------|-----------|-----------|----------------------------------------|-----------------------------------------|
| write-mixed | `o/r#pr#42` (from `snapshotKey('O/R',…)`) | `o/r` | `o/r#pr#42` HIT → green | `o/r#pr#42` HIT → green (**mutation survives**) |
| read-mixed  | `o/r#pr#42` (from `snapshotKey('o/r',…)`) | `O/R` | `o/r#pr#42` HIT → green | `O/R#pr#42` MISS → undefined (**mutation killed**) |

So write-mixed alone gives false confidence against the line-375 inline; read-mixed is
load-bearing for SC-002. Both are field-reachable (write key from operator-typed epic body at
`poll-loop.ts:93`; read from GitHub-canonical `repository.owner.login`/`name`).

## Decision 3 — Rollup breadth

**Decision**: Single representative `success`→`green` per branch (Q3=A).

**Rationale**: The bug symptom is `checks: undefined`. Only rollups mapping to a defined wire
value (`success`→green, `failure`/`error`→red) distinguish hit from miss. `pending`/`none` map to
`undefined` regardless, contributing zero mutation-sensitivity here. `mapChecks`
(`smee-source.ts:107-117`) is already pinned across the full table by the lowercase `it.each`
(`smee-source.integration.test.ts:355-392`); the new test's job is the key-lookup at line 375,
not the mapping.

## Decision 4 — Test structure

**Decision**: Dedicated `it` block(s), existing tests unchanged (Q2=A).

**Rationale**: The existing block is an `it.each` pinning the full rollup→wire table under
homogeneous casing; folding a casing dimension in would cross-multiply the matrix and blur which
assertion pins which invariant. The lowercase cases are the control distinguishing "checks never
stamped" from "checks not stamped under casing drift", and the sole pins for `error`/`pending`.
Dedicated-`it` precedent exists at line 209.

## Reference points (verified in code)

- Read-through lookup: `smee-source.ts:375` — `this.prev.get(snapshotKey(ev.repo, 'pr', ev.number))`.
- Branch condition: `smee-source.ts:369-373` — `pr-checks` OR (`label-change` && `sourceLabel === 'completed:validate'`).
- Stamp: `smee-source.ts:377-380` — `mapChecks(snap.checksRollup)`, only stamps when `wire !== undefined`.
- Key normalization: `snapshot.ts:46-48` — `${repo.toLowerCase()}#${kind}#${number}`.
- Raw payload repo: `webhook-to-event.ts:132` — `repo: ${owner}/${repo}`.
- `mapChecks`: `smee-source.ts:107-117` — success→green; failure/error→red; pending/none→undefined.

## Sources

- `specs/1113-follow-up-1106-pr/spec.md`
- `specs/1113-follow-up-1106-pr/clarifications.md` (Q1=B, Q2=A, Q3=A)
- PR #1109 (`674cc228`), issue #1106.
