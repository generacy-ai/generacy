# Tasks: Delete Cockpit Dark Subsystems (S1)

**Input**: Design documents from `/specs/805-epic-generacy-ai-tetrad/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 = delete dark subsystems; US2 = remove stuck output surface (per Q1)

Absolute paths below are rooted at `/workspaces/generacy/`.

---

## Phase 1: Setup

- [X] T001 Verify branch `805-epic-generacy-ai-tetrad` is checked out, working tree clean, and run `pnpm install` from the repo root.
- [X] T002 Baseline: run `pnpm --filter @generacy-ai/cockpit build && pnpm --filter @generacy-ai/generacy build` to confirm both packages typecheck **before** deletions begin. Record any pre-existing failures.

---

## Phase 2: File Deletions (parallelizable)

Delete-only tasks. Each is a single `rm` on an owned file — safe to run in parallel because no task edits another's file.

### `packages/cockpit`

- [X] T003 [P] [US1] Delete `packages/cockpit/src/orchestrator/client.ts`.
- [X] T004 [P] [US1] Delete `packages/cockpit/src/orchestrator/http.ts`.
- [X] T005 [P] [US1] Delete `packages/cockpit/src/orchestrator/stub.ts`.
- [X] T006 [P] [US1] Delete the now-empty `packages/cockpit/src/orchestrator/` directory (after T003–T005).
- [X] T007 [P] [US1] Delete `packages/cockpit/src/journal.ts`.
- [X] T008 [P] [US1] Delete `packages/cockpit/src/__tests__/journal.test.ts`.
- [X] T009 [P] [US1] Delete `packages/cockpit/src/__tests__/orchestrator-client.test.ts`.

### `packages/generacy` — CLI cockpit helpers

- [X] T010 [P] [US1] Delete `packages/generacy/src/cli/commands/cockpit/shared/orchestrator-footer.ts`.
- [X] T011 [P] [US1] Delete `packages/generacy/src/cli/commands/cockpit/shared/orchestrator-token.ts`.
- [X] T012 [P] [US1] Delete `packages/generacy/src/cli/commands/cockpit/shared/orchestrator-warn.ts`.
- [X] T013 [P] [US1] Delete `packages/generacy/src/cli/commands/cockpit/watch/orchestrator-counts.ts`.

### `packages/generacy` — orchestrator-scoped tests

- [X] T014 [P] [US1] Delete `packages/generacy/src/cli/commands/cockpit/__tests__/orchestrator-token.test.ts`.
- [X] T015 [P] [US1] Delete `packages/generacy/src/cli/commands/cockpit/__tests__/orchestrator-warn.test.ts`.
- [X] T016 [P] [US1] Delete `packages/generacy/src/cli/commands/cockpit/__tests__/status.footer.test.ts`.
- [X] T017 [P] [US1] Delete `packages/generacy/src/cli/commands/cockpit/__tests__/status.token-precedence.test.ts`.
- [X] T018 [P] [US1] Delete `packages/generacy/src/cli/commands/cockpit/__tests__/watch.orchestrator-counts.test.ts`.
- [X] T019 [P] [US1] Delete `packages/generacy/src/cli/commands/cockpit/__tests__/watch.orchestrator-failure.test.ts`.

---

## Phase 3: Trim `@generacy-ai/cockpit` Package Surface

Sequential where files may share edits; parallel [P] where distinct.

- [X] T020 [US1] Edit `packages/cockpit/src/types.ts`: remove `StuckReason`, `JournalLivenessResult`, and `ReadJournalLivenessOptions` types (data-model.md §2). Leave `COCKPIT_STATES`, `CockpitState`, `ClassifyResult` untouched.
- [X] T021 [US1] Edit `packages/cockpit/src/index.ts`: remove exports `createOrchestratorClient`, `OrchestratorClient`, `CreateOrchestratorClientConfig`, `HealthResult`, `JobsResult`, `WorkersResult`, `JobSummary`, `UnavailableReason`, `readJournalLiveness`, `StuckReason`, `JournalLivenessResult`, `ReadJournalLivenessOptions`, `appendChildIssue`. Depends on T020.
- [X] T022 [P] [US1] Edit `packages/cockpit/src/config/schema.ts`: drop `orchestrator` object and `stuckThresholdMinutes` from `CockpitConfigSchema` (data-model.md §1). Do **not** add `.strict()`.
- [X] T023 [P] [US1] Edit `packages/cockpit/src/manifest/io.ts`: delete `appendChildIssue` function (and any helpers used only by it).
- [X] T024 [P] [US1] Edit `packages/cockpit/src/__tests__/config-loader.test.ts`: drop assertions on `orchestrator` and `stuckThresholdMinutes`.
- [X] T025 [P] [US1] Edit `packages/cockpit/src/__tests__/manifest-io.test.ts`: drop `appendChildIssue` cases.
- [X] T026 [P] [US1] Edit `packages/cockpit/src/__tests__/fixtures/config-samples/full.yaml`: strip `orchestrator:` block and `stuckThresholdMinutes:` key.

---

## Phase 4: Update `packages/generacy` CLI Call Sites (top-level)

Sequential — both files import cascading helpers whose surfaces change in Phase 5.

- [X] T027 [US1] Edit `packages/generacy/src/cli/commands/cockpit/status.ts`: drop imports of `createOrchestratorClient`, `readJournalLiveness`, `StuckReason`, `getOrchestratorFooter`/`renderFooter`, orchestrator-token, orchestrator-warn; remove `liveness` computation and any footer wiring; ensure `renderJsonEnvelope` is called without the footer arg.
- [X] T028 [US1] Edit `packages/generacy/src/cli/commands/cockpit/watch.ts`: drop orchestrator client construction, `warner`, `prevOrchestrator`, `pollOrchestratorCounts` call, and the orchestrator-counts stdout write; drop related imports; drop `stuckThresholdMinutes` and `readLiveness` from `PollDeps` wiring.

---

## Phase 5: Update `status/*` and `watch/*` Helpers

Different files — most can run in parallel. T033 depends on T031 (import cleanup follows type change).

- [X] T029 [P] [US2] Edit `packages/generacy/src/cli/commands/cockpit/status/render-table.ts`: drop `COL_STUCK` constant, `stuckCol` computation in `fmtRow`; remove `orchestrator` field from `StatusEnvelope`; drop `footer` param from `renderJsonEnvelope` (data-model.md §8).
- [X] T030 [P] [US2] Edit `packages/generacy/src/cli/commands/cockpit/status/row.ts`: drop `stuck` and `stuckReason` fields from `StatusRow`; drop `liveness` param and fields from `buildStatusRow`; drop `StuckReason` import (data-model.md §3).
- [X] T031 [P] [US2] Edit `packages/generacy/src/cli/commands/cockpit/status/color.ts`: drop `stuck()` method from `Colorizer` interface and both `chalkColorizer`/`identityColorizer` implementations (data-model.md §6).
- [X] T032 [P] [US2] Edit `packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts`: drop `stuck` and `stuckReason` from `IssueSnapshot`; drop `liveness` param and fields from `buildIssueSnapshot`; drop `StuckReason` import (data-model.md §4).
- [X] T033 [US2] Edit `packages/generacy/src/cli/commands/cockpit/watch/diff.ts`: narrow `CockpitEventDiscriminator` union to `'label-change' | 'issue-closed' | 'pr-merged' | 'pr-closed' | 'pr-checks'`; drop `stuckReason?` from `CockpitEvent`; delete stuck/recovered emission branches from `diffIssue`; drop `StuckReason` import (data-model.md §5, research.md R3).
- [X] T034 [P] [US1] Edit `packages/generacy/src/cli/commands/cockpit/watch/emit.ts`: verify Zod enum already excludes `stuck`/`recovered` (research.md R3 confirms `emit.ts:14`). No enum change required; only remove any residual `stuckReason` field from the emitted event type if present.
- [X] T035 [US1] Edit `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts`: drop `stuckThresholdMinutes` and `readLiveness` from `PollDeps`; delete the liveness branch inside the issue path; drop `readJournalLiveness` and `StuckReason` imports (data-model.md §7).

---

## Phase 6: Trim Generacy CLI Tests

- [X] T036 [P] [US2] Edit `packages/generacy/src/cli/commands/cockpit/__tests__/status.render.test.ts`: drop the stuck-column cases; adjust any column-count / header assertions to reflect the removed STALE column.
- [X] T037 [P] [US2] Edit `packages/generacy/src/cli/commands/cockpit/__tests__/watch.diff.test.ts`: drop `stuck` and `recovered` event cases.
- [X] T038 [P] [US1] Edit `packages/generacy/src/cli/commands/cockpit/__tests__/watch.poll-loop.test.ts`: drop `stuckThresholdMinutes`/`readLiveness` cases.
- [X] T039 [P] [US1] Read `packages/generacy/src/cli/commands/cockpit/__tests__/watch.no-mutations.test.ts` and `watch.pagination.test.ts` (plan.md Risks). If they construct `IssueSnapshot` literals with `stuck: false` / `stuckReason: null`, or assert orchestrator-counts stdout lines, remove those bits. Otherwise no change.

---

## Phase 7: Verification

Sequential — each step validates the previous.

- [X] T040 Typecheck gate: run `pnpm --filter @generacy-ai/cockpit build && pnpm --filter @generacy-ai/generacy build`. Both must exit 0 (quickstart.md step 1).
- [X] T041 Dead-symbol grep: run
  ```
  git grep -nE 'readJournalLiveness|createOrchestratorClient|appendChildIssue|StuckReason|JournalLivenessResult|ReadJournalLivenessOptions|orchestrator-footer|orchestrator-token|orchestrator-warn|orchestrator-counts' -- 'packages/**/*.ts'
  ```
  Expected: zero matches under `packages/` (quickstart.md step 2). Matches in `specs/` / `dist/` do not count.
- [X] T042 Run test suites: `pnpm --filter @generacy-ai/cockpit test && pnpm --filter @generacy-ai/generacy test`. Both must pass green (quickstart.md step 3).
- [X] T043 Smoke `cockpit status`: `node packages/generacy/dist/cli/index.js cockpit status --repos generacy-ai/generacy`. Confirm no `STALE` column and no `orchestrator:` footer line (quickstart.md step 4).
- [X] T044 Smoke `cockpit status --json`: `node packages/generacy/dist/cli/index.js cockpit status --repos generacy-ai/generacy --json | jq '.rows[0], .orchestrator'`. Confirm row has no `stuck`/`stuckReason` keys and `.orchestrator` is `null` (quickstart.md step 5).
- [X] T045 Smoke `cockpit watch`: run `node packages/generacy/dist/cli/index.js cockpit watch --repos generacy-ai/generacy --interval 2000` for two ticks, Ctrl-C. Confirm no `orchestrator-counts` JSON lines and no `stuck`/`recovered` events (quickstart.md step 6).
- [X] T046 Final acceptance check against spec.md: no orchestrator/journal references remain outside git history; watch/status run with reduced output; typecheck green.

---

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 (setup) → Phase 2 (deletions) → Phase 3 (cockpit surface) → Phase 4 (CLI call sites) → Phase 5 (helpers) → Phase 6 (test trims) → Phase 7 (verify).
- Phase 2 (deletions) intentionally runs first per plan.md Execution Sequence step 1 — surfaces "unknown import" errors that guide Phases 3–5.

**Intra-phase parallelism**:
- Phase 2: T003–T019 all parallel (`[P]`), except T006 waits for T003–T005.
- Phase 3: T020 → T021 (index re-exports the types). T022–T026 parallel with each other and with T020/T021 (distinct files).
- Phase 4: T027 and T028 sequential is safest (both re-run typecheck locally after edit); either order works.
- Phase 5: T029, T030, T031, T032, T034 all parallel. T033 last (it also touches the discriminator that T034's emit.ts alignment references). T035 parallel with the others (distinct file).
- Phase 6: T036, T037, T038, T039 all parallel.
- Phase 7: T040 → T041 → T042 → T043 → T044 → T045 → T046 strictly sequential.

**Cross-phase dependency**:
- Deletions in Phase 2 make imports fail; Phase 3–5 edits are what unblock the typecheck in T040. Do not run Phase 7 until Phases 3–6 are complete.

---

## Summary

- **Total tasks**: 46 (T001–T046)
- **Phases**: 7 (Setup, Deletions, Cockpit surface, CLI call sites, Helpers, Test trims, Verify)
- **Parallel opportunities**: Phase 2 (17 [P] deletions), Phase 3 (5 [P] edits), Phase 5 (5 [P] edits), Phase 6 (4 [P] edits)
- **Mode**: Standard (fine-grained; `epic-child` issue, not epic itself)
- **Next step**: `/speckit:implement` to begin execution.
