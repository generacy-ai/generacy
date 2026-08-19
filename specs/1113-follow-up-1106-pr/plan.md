# Implementation Plan: Pin the PrSnapshot read-through path (follow-up to #1106)

**Feature**: Add regression coverage proving `SmeeDoorbellSource.processEventBlock` routes its read-through `PrSnapshot` cache lookup through `snapshotKey` (case-normalized), so a future inline of the `smee-source.ts:375` key turns the suite red instead of silently re-shipping the `checks: undefined` bug.
**Branch**: `1113-follow-up-1106-pr`
**Workflow**: `speckit-bugfix`
**Status**: Complete

## Summary

PR #1109 (merged `674cc228`) fixed the #1106 PrSnapshot cache-key casing bug centrally
inside `snapshotKey` (`watch/snapshot.ts:46`), which lowercases `repo` at both write
(`watch/poll-loop.ts:93`) and read (`doorbell/smee-source.ts:375`) sites. Unit tests pin the
`snapshotKey` invariant in isolation, but nothing asserts the read-through path in
`smee-source.processEventBlock` *actually routes through* `snapshotKey`. A refactor that
inlines the lookup as `` `${ev.repo}#pr#${ev.number}` `` (payload-canonical casing) would keep
the whole suite green while re-introducing `checks: undefined` on every case mismatch across the
write/read boundary.

This is a **test-only** change. It adds dedicated `it` block(s) to
`smee-source.integration.test.ts` that drive `processEventBlock` end-to-end with a write/read
casing mismatch across the `snapshotKey` boundary, asserting `checks` is stamped to the expected
wire value. No production code changes.

## Technical Context

- **Language / runtime**: TypeScript, Node >= 22, ESM.
- **Test framework**: Vitest (`pnpm --filter @generacy-ai/generacy test`).
- **Package**: `@generacy-ai/generacy`.
- **File under test**: `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts`
  (`processEventBlock`, lines 349–399; read-through lookup at line 375).
- **Test file to modify**: `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/smee-source.integration.test.ts`.
- **Existing harness reused**: `startFakeSmee`, `checkRunFrame`, `issueFrame`, `fakePrSnapshot`,
  `setPrev`, `waitFor`, module-mocked `resolveEpic` → `FAKE_RESOLVED` (epic `o/r#100`, watched
  repo `o/r`, ref `o/r#42`). No new harness (per Assumptions).
- **Dependencies**: none new.

## Key Design Decisions

1. **Casing values must be variants of `o/r`, not `Painworth/Doc-Intel`.** The module-mocked
   `FAKE_RESOLVED` fixes the watched repo to `o/r`, and ref-set membership is case-insensitive
   (#1106). A `Painworth/Doc-Intel` payload lowercases to `painworth/doc-intel`, which does not
   match `o/r` and would be dropped before reaching the read-through branch. So the tests use
   `o/r` in mixed vs. lowercase casings (owner/repo `O`/`R` vs. `o`/`r`). The spec's
   `Painworth/Doc-Intel` is the field narrative; the harness expresses the same casing-drift with
   the mocked repo. *(This is the load-bearing implementation constraint.)*

2. **Direction (2) — read-mixed — is the mutation-killer** (Q1=B). `snapshotKey` lowercases at
   write time (`snapshot.ts:47`), and `webhook-to-event.ts:132` emits `ev.repo = ${owner}/${repo}`
   in raw payload casing. So:
   - Direction (1) write-mixed (`snapshotKey('O/R',…)` → key `o/r#pr#42`) + read lowercase payload
     (`ev.repo='o/r'`): fixed HITS; inlined `'o/r#pr#42'` also HITS → does **not** kill the
     line-375 inline (kills only a `snapshotKey`-revert-at-write mutation).
   - Direction (2) write lowercase (`snapshotKey('o/r',…)` → key `o/r#pr#42`) + read **mixed**
     payload (`ev.repo='O/R'`): fixed `snapshotKey('O/R',…)`='o/r#pr#42' HITS; inlined
     `'O/R#pr#42'` MISSES → `checks: undefined` → **kills the mutation**.
   Both directions are covered per FR-003; direction (2) satisfies SC-002.

3. **Single representative rollup per branch** (Q3=A): `success`→`green` for both the `pr-checks`
   and `completed:validate` `label-change` branches. `pending`/`none` map to `undefined`
   regardless of hit/miss (zero mutation-sensitivity); the existing lowercase `it.each` already
   pins the full `mapChecks` table.

4. **Dedicated `it` blocks, existing tests untouched** (Q2=A). Mirrors the dedicated-`it`
   precedent at line 209. The existing lowercase `it.each` (355–392) and `completed:validate`
   test (424–462) remain the control for the `error`/`pending` mappings under homogeneous casing.

## Project Structure

```
specs/1113-follow-up-1106-pr/
├── spec.md              # (read-only) feature spec
├── clarifications.md    # (read-only) Q1=B, Q2=A, Q3=A
├── plan.md              # this file
├── research.md          # decisions + mutation analysis
├── data-model.md        # PrSnapshot / SnapshotMap / mapChecks reference
└── quickstart.md        # how to run + mutation-verify

packages/generacy/src/cli/commands/cockpit/
├── doorbell/
│   ├── smee-source.ts                         # under test (no change)
│   ├── webhook-to-event.ts                    # ev.repo raw casing (no change)
│   └── __tests__/
│       └── smee-source.integration.test.ts    # ADD dedicated it block(s)
└── watch/
    └── snapshot.ts                            # snapshotKey (no change)
```

## Test Design (to land in `tasks`/`implement`)

Add a `describe('#1113 read-through cache path — casing drift across snapshotKey', …)` (or
sibling `it` blocks) containing four assertions — the cross-product of {direction 1, direction 2}
× {`pr-checks`, `completed:validate`}:

| # | Direction | Write key (`snapshotKey(...)`) | Read payload owner/repo (`ev.repo`) | Event driver | Expected `checks` |
|---|-----------|-------------------------------|-------------------------------------|--------------|-------------------|
| 1 | write-mixed  | `snapshotKey('O/R','pr',42)` = `o/r#pr#42` | `o`/`r` → `o/r`   | `checkRunFrame`        | `green` |
| 2 | read-mixed   | `snapshotKey('o/r','pr',42)` = `o/r#pr#42` | `O`/`R` → `O/R`   | `checkRunFrame`        | `green` |
| 3 | write-mixed  | `snapshotKey('O/R','pr',42)` = `o/r#pr#42` | `o`/`r` → `o/r`   | `issueFrame` completed:validate | `green` |
| 4 | read-mixed   | `snapshotKey('o/r','pr',42)` = `o/r#pr#42` | `O`/`R` → `O/R`   | `issueFrame` completed:validate | `green` |

Each test: construct `prev: SnapshotMap`, `prev.set(snapshotKey(writeRepo,'pr',42), fakePrSnapshot(writeRepo,42,'success'))`,
`setPrev(source, prev)`, write the frame with the read-side casing, `waitFor(events.length>=1)`,
assert `ev.checks === 'green'` (not `undefined`). Rows 2 and 4 are the SC-002 mutation-killers.

## Constitution Check

No `.specify/memory/constitution.md` present in the repo. N/A. The change respects the
project's changeset gate (see below) and the test-only scope guarantee (SC-003).

## Changeset

Per CLAUDE.md, the changeset gate is **test-only exempt**: the sole modified file is
`__tests__/smee-source.integration.test.ts` (matches `__tests__/`), so no `.changeset/*.md` is
required and CI's `changeset-bot` will skip it. SC-003 (`git diff --stat` shows only `__tests__/`)
also confirms exemption. Do **not** add a changeset.

## Risks / Mitigations

- **Ref-set mismatch (primary risk)**: using `Painworth/Doc-Intel` would silently drop the event
  (repo not in watched set) and the test would hang at `waitFor`. Mitigation: use `o/r` casing
  variants only (Decision 1).
- **Wrong direction (false-green mutation test)**: only direction (2) read-mixed kills the
  line-375 inline. Mitigation: rows 2 & 4 above; SC-002 manual mutation-verify in quickstart.

## Next Step

`/speckit:tasks` to generate the task list.
