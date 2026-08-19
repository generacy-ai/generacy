# Tasks: Pin the PrSnapshot read-through path (follow-up to #1106)

**Input**: Design documents from `/specs/1113-follow-up-1106-pr/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Overview

Test-only change (FR-004, SC-003). The sole file touched is
`packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/smee-source.integration.test.ts`.
Add dedicated `it` block(s) that drive `SmeeDoorbellSource.processEventBlock` end-to-end with a
write/read casing mismatch across the `snapshotKey` boundary, asserting `checks` is stamped to the
expected wire value (`green`) rather than `undefined`. No production code changes; no changeset
(test-only exempt per CLAUDE.md).

## Phase 1: Setup

- [X] T001 Confirm the existing harness in
  `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/smee-source.integration.test.ts`
  is baseline-green: run `pnpm --filter @generacy-ai/generacy test smee-source` and verify all
  existing cases pass before adding new ones. Note the reusable helpers (`startFakeSmee`/`fake`,
  `checkRunFrame`, `issueFrame`, `fakePrSnapshot`, `setPrev`, `waitFor`, `snapshotKey`) and the
  module-mocked `resolveEpic → FAKE_RESOLVED` (watched repo `o/r`, ref `o/r#42`). No code change.

## Phase 2: Core Implementation

- [X] T002 [US1] Add a `describe('#1113 read-through cache path — casing drift across snapshotKey', …)`
  block (dedicated `it` blocks, mirroring the precedent at test line 209; do NOT fold into the
  existing lowercase `it.each` at 355–392 — Q2=A/FR-001) in
  `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/smee-source.integration.test.ts`.
  Leave the existing lowercase `it.each` and `completed:validate` test (424–462) unchanged (they
  are the control pinning `error`/`pending` mappings under homogeneous casing).

- [X] T003 [US1] Row 1 — **write-mixed × `pr-checks`**: build `prev: SnapshotMap`,
  `prev.set(snapshotKey('O/R','pr',42), fakePrSnapshot('O/R',42,'success'))`, `setPrev(source, prev)`,
  drive `fake.writeFrame(checkRunFrame({ prNumber: 42, repoOwner: 'o', repoName: 'r' }))`,
  `waitFor(() => events.length >= 1)`, assert emitted `issue-transition` event has
  `event === 'pr-checks'` and `checks === 'green'` (not `undefined`).

- [X] T004 [US1] Row 2 (**SC-002 mutation-killer**) — **read-mixed × `pr-checks`**: build `prev`,
  `prev.set(snapshotKey('o/r','pr',42), fakePrSnapshot('o/r',42,'success'))`, `setPrev(source, prev)`,
  drive `fake.writeFrame(checkRunFrame({ prNumber: 42, repoOwner: 'O', repoName: 'R' }))`,
  `waitFor(...)`, assert `event === 'pr-checks'` and `checks === 'green'`. This row fails when
  `snapshotKey(ev.repo,'pr',ev.number)` at `smee-source.ts:375` is inlined as
  `` `${ev.repo}#pr#${ev.number}` ``.

- [X] T005 [US1] Row 3 — **write-mixed × `completed:validate` label-change**: build `prev`,
  `prev.set(snapshotKey('O/R','pr',42), fakePrSnapshot('O/R',42,'success'))`, `setPrev(source, prev)`,
  drive `fake.writeFrame(issueFrame('labeled', { number: 42, label: 'completed:validate',
  labels: ['completed:validate'], repoOwner: 'o', repoName: 'r' }))`, `waitFor(...)`, assert
  `event === 'label-change'`, `sourceLabel === 'completed:validate'`, `checks === 'green'`.

- [X] T006 [US1] Row 4 (**SC-002 mutation-killer**) — **read-mixed × `completed:validate`
  label-change**: build `prev`, `prev.set(snapshotKey('o/r','pr',42), fakePrSnapshot('o/r',42,'success'))`,
  `setPrev(source, prev)`, drive `fake.writeFrame(issueFrame('labeled', { number: 42,
  label: 'completed:validate', labels: ['completed:validate'], repoOwner: 'O', repoName: 'R' }))`,
  `waitFor(...)`, assert `event === 'label-change'`, `sourceLabel === 'completed:validate'`,
  `checks === 'green'`. Load-bearing read-mixed direction (Q1=B / FR-003) for the label-change branch.

## Phase 3: Verification

- [X] T007 [US1] SC-001 — run `pnpm --filter @generacy-ai/generacy test smee-source` and confirm
  all four new rows plus the pre-existing cases are green against unmodified `smee-source.ts`.

- [X] T008 [US1] SC-002 — mutation verify: temporarily replace `snapshotKey(ev.repo, 'pr', ev.number)`
  at `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts:375` with an inlined
  `` `${ev.repo}#pr#${ev.number}` ``, re-run the suite, confirm rows 2 (T004) and 4 (T006) go **red**,
  then revert the mutation. Follow `specs/1113-follow-up-1106-pr/quickstart.md`.

- [X] T009 [US1] SC-003 — confirm `git diff --stat` shows only the `__tests__/` test file changed
  (zero production lines, no `.changeset/*.md` added).

## Dependencies & Execution Order

- **T001** (baseline) precedes all implementation.
- **T002** (add the `describe` scaffold) precedes **T003–T006** (the four rows live inside it).
- **T003–T006** all edit the same test file → author sequentially (not `[P]`), but each is
  independently small. T004 and T006 are the SC-002 mutation-killers.
- **Phase 3 (T007–T009)** runs after all rows land: T007 (green) → T008 (mutation red/revert) →
  T009 (test-only diff).

**Parallel opportunities**: none — the entire change is a single test file, so tasks are serialized
by file contention despite being logically independent per row.

## Next Step

`/speckit:implement` to add the dedicated `it` blocks and run the verification phase.
