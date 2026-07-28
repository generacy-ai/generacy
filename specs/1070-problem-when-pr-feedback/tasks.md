# Tasks: Distinguish PR-feedback fixer timeout from stuck-loop, and let it self-recover

**Input**: Design documents from `/specs/1070-problem-when-pr-feedback/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/
**Status**: Complete
**Issue**: [generacy#1070](https://github.com/generacy-ai/generacy/issues/1070)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story / functional requirement this task belongs to (US1 / US2 / US3)

## Phase 1: Types & Vocabulary (foundation — everything else depends on these)

- [X] T001 [P] [US1] Add three new label definitions to `packages/workflow-engine/src/actions/github/label-definitions.ts` immediately after the existing `blocked:stuck-feedback-loop` entry (~line 114): `blocked:fixer-timeout`, `blocked:fixer-timeout-no-progress`, `blocked:fixer-timeout-repeat`. Color `D73A4A` (matching sibling `blocked:*` red). Descriptions verbatim from `contracts/label-vocabulary.md` — all three fit under GitHub's 100-char limit. Verify by re-reading the file after edit.

- [X] T002 [P] [US2] Extend `PrFeedbackMetadata` in `packages/orchestrator/src/types/monitor.ts` (~lines 38-43) with optional `retryAttempt?: number` field. Add JSDoc per `data-model.md` §2: number of auto-retries dispatched so far including this dispatch; written by monitor at every enqueue; read by handler with `?? 0` default for rolling-deploy compatibility. This is the D-1 cross-process wire-format seam.

- [X] T003 [P] [US1] Add private `SpawnClaudeResult` interface at the top of `packages/orchestrator/src/worker/pr-feedback-handler.ts` (co-located, NOT exported from `@generacy-ai/orchestrator`). Fields: `success: boolean`, `exitCode: number | null`, `timedOut: boolean`. Include the semantic-invariant JSDoc from `contracts/spawn-claude-result.md` §"Semantic invariants" (esp. "`timedOut === true` implies `success === false`").

## Phase 2: Monitor (`PrFeedbackMonitorService`) — depends on Phase 1

- [X] T010 [US2] Add `private fixerTimeoutRetryCount: Map<string, number> = new Map();` field to `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` next to the sibling `lastUnresolvedThreadCount` map (~line 79). Key shape `${owner}/${repo}#${prNumber}` matches sibling. Include JSDoc from `data-model.md` §3 explaining write sites (retry branch increment + Case C delete) and read sites (retry-branch dispatch decision + `retryAttempt` bake).

- [X] T011 [US2] Insert the retry-eligible branch in `pr-feedback-monitor-service.ts::processPrReviewEvent` **between** the `getIssueLabels` fetch (~lines 363-372) and the current `blocked:*` skip check (~lines 373-389). Exact-match `issueLabels.includes('blocked:fixer-timeout')` gate → if `priorRetries < 2`: `client.removeLabels(...)` (fail-warn, non-fatal; on failure fall through to blocked:* skip — do NOT dispatch with the label still present), increment counter, structured `info` log with `gate: 'blocked-fixer-timeout-retry-dispatch'`, fall through to normal enqueue path. If `priorRetries >= 2`: structured `warn` log with `gate: 'blocked-fixer-timeout-budget-exhausted'` (defense-in-depth — handler should have applied `blocked:fixer-timeout-repeat` already), fall through to blocked:* short-circuit. Full code from `contracts/monitor-short-circuit.md` §After. Preserves Assumption 5: any UNRECOGNIZED `blocked:*` label still pauses.

- [X] T012 [US2] Modify the enqueue-path metadata construction (`pr-feedback-monitor-service.ts` ~lines 414-428) to attach `retryAttempt: this.fixerTimeoutRetryCount.get(stateKey) ?? 0` to every `PrFeedbackMetadata` — normal path AND retry-branch dispatch. Non-retry dispatches get `retryAttempt: 0`; retry-branch dispatches get the incremented value (T011 has already incremented before falling through). Per `contracts/handler-counter-seam.md` §"Write side".

- [X] T013 [US2] Add one line to Case C branch at `pr-feedback-monitor-service.ts:296-317`: `this.fixerTimeoutRetryCount.delete(stateKey);` after the existing `lastZeroTrustedState.set(stateKey, false);` line. This is the **sole** reset site (D-5, FR-013, Q5=C). `Map.delete` on absent key is a no-op — safe unconditional invocation. Per `contracts/counter-reset-trigger.md`.

## Phase 3: Handler (`PrFeedbackHandler`) — depends on Phase 1

- [X] T020 [US1] Widen `spawnClaudeForFeedback` return type in `packages/orchestrator/src/worker/pr-feedback-handler.ts`: change signature at ~line 687 from `Promise<boolean>` to `Promise<SpawnClaudeResult>`. Update all internal return sites in the definition body (~lines 719-814): catch on launch-failure returns `{ success: false, exitCode: null, timedOut: false }`; timeout branch at ~line 791 returns `{ success: false, exitCode, timedOut: true }`; clean-exit path returns `{ success, exitCode, timedOut: false }`; catch block returns `{ success: false, exitCode: null, timedOut }` preserving whatever `timedOut` was set to before the throw. Per `contracts/spawn-claude-result.md` §"Runtime plumbing".

- [X] T021 [US1] Update the sole call site of `spawnClaudeForFeedback` at `pr-feedback-handler.ts:412` from `const success = await this.spawnClaudeForFeedback(...)` to `const { success, exitCode, timedOut } = await this.spawnClaudeForFeedback(...)`. Depends on T020.

- [X] T022 [US3] Correct the log line at `pr-feedback-handler.ts:451-454` (FR-005 / D-6). Split into two conditions inside the existing `if (hasChanges)` block:
   - `hasChanges === true && success === true`: keep the existing `info`-level `'Successfully pushed changes to PR branch'` message. **Drop `success` from the payload** (redundant — both branches guard on it).
   - `hasChanges === true && success === false`: emit `warn`-level `'Pushed partial changes before CLI timed out — retry may follow'`. Payload: `{ prNumber, issueNumber, cliCompleted: false, exitCode }` (never `success: false` at this specific log site — that is the contradiction the bug report targeted). Depends on T021.

- [X] T023 [US1] Add three new label-application helpers to `pr-feedback-handler.ts` next to `addBlockedStuckFeedbackLoopLabel` (~line 1035): `addBlockedFixerTimeoutLabel`, `addBlockedFixerTimeoutNoProgressLabel`, `addBlockedFixerTimeoutRepeatLabel`. Each follows the sibling shape: `try { await github.addLabels(...) } catch { this.logger.warn(...) }`. Non-fatal on failure — logs and continues.

- [X] T024 [US1] Read `const retryAttempt = metadata.retryAttempt ?? 0;` near the top of `PrFeedbackHandler.handle` where `metadata` is destructured today (~line 114). Depends on T002 and T021.

- [X] T025 [US1] Split the collapsed `if (!success || !hasChanges)` branch at `pr-feedback-handler.ts:469-481` into the four explicit sub-branches from `data-model.md` §4 / `contracts/handler-counter-seam.md` §"Read side" — in this order:
   1. **B4** (`timedOut && !hasChanges`): `warn` with `disposition: 'timeout-no-progress'`, `cliCompleted: false`, `exitCode`. Apply `blocked:fixer-timeout-no-progress`. Return.
   2. **B5/B6** (`timedOut && hasChanges`): `disposition = retryAttempt < 2 ? 'fixer-timeout' : 'fixer-timeout-repeat'`; `label = retryAttempt < 2 ? 'blocked:fixer-timeout' : 'blocked:fixer-timeout-repeat'`. `warn` with `disposition`, `retryAttempt`, `cliCompleted: false`, `exitCode`. Apply the chosen label. Return.
   3. **B1/B2/B3** (residual: `!success || !hasChanges` after B4/B5/B6 didn't match — i.e., `!timedOut && (!success || !hasChanges)` OR `!hasChanges && !timedOut`): preserve today's behavior — `warn` with `disposition: 'no-diff' | 'push-failed'`, apply `blocked:stuck-feedback-loop` via `addBlockedStuckFeedbackLoopLabel`. Return.

   All four branches MUST flow through the shared `finally` at ~lines 628-637 (FR-010 — `agent:in-progress` clear preserved). FR-012: `waiting-for:address-pr-feedback` MUST remain — no branch calls `removeLabels(..., ['waiting-for:address-pr-feedback'])`. Depends on T023, T024.

## Phase 4: Cockpit precedence — depends on Phase 1 (label names must exist)

- [X] T030 [US1] Extend `WAITING_PIPELINE_ORDER` in `packages/cockpit/src/state/precedence.ts` (~lines 26-40) with three insertions per `data-model.md` §7 / plan `§D-3`:
   - `'blocked:fixer-timeout-no-progress'` immediately after `'blocked:stuck-feedback-loop'` (terminal, outranks `waiting-for:address-pr-feedback`).
   - `'blocked:fixer-timeout-repeat'` immediately after the above (same rationale).
   - `'blocked:fixer-timeout'` immediately after `'waiting-for:address-pr-feedback'` (retry-eligible, sorts **below** the active waiting gate per Q4=A intent — the retry is coming; "still waiting" is the more-informative status).

## Phase 5: Tests

### Handler tests

- [X] T040 [US1] Update ALL `spawnClaudeForFeedback` mocks in `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` (~5 sites per `contracts/spawn-claude-result.md` §"Test doubles to update") from `.mockResolvedValue(true|false)` to full triples. Common values: happy = `{ success: true, exitCode: 0, timedOut: false }`; timeout+push = `{ success: false, exitCode: 143, timedOut: true }`; timeout+no-push = same triple paired with `commitAndPushChanges` mock returning `false`; clean non-zero = `{ success: false, exitCode: 1, timedOut: false }`; signal-without-code = `{ success: false, exitCode: null, timedOut: true }`. Depends on T020.

- [X] T041 [US1] Add the four-branch disposition matrix to `pr-feedback-handler.test.ts` covering B1..B6 from `data-model.md` §4. For each precondition tuple `(success, hasChanges, timedOut, retryAttempt)`, assert (a) the specific label applied (mock `github.addLabels`), (b) the log line's `disposition` field matches, (c) `agent:in-progress` cleared via the shared finally (FR-010), (d) `waiting-for:address-pr-feedback` NOT removed (FR-012). Depends on T025, T040.

- [X] T042 [US3] Add SC-004 log-line audit test to `pr-feedback-handler.test.ts`: assert the source contains **exactly one** `'Successfully pushed changes to PR branch'` string, guarded by both `hasChanges === true && success === true`. Static test — read the compiled/source file and grep, OR simulate `hasChanges: true, success: false` and assert no log line matches `Successfully pushed`. Depends on T022.

### Monitor tests

- [X] T050 [US2] Add SC-002 base case to `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts`: fixture with `blocked:fixer-timeout` present, `counter === 0` → assert monitor calls `client.removeLabels(..., ['blocked:fixer-timeout'])`, increments counter to 1, enqueues with `metadata.retryAttempt === 1`. Second cycle without the label (success path) → counter unchanged; Case C triggers `fixerTimeoutRetryCount.delete(stateKey)`. Depends on T011, T012, T013.

- [X] T051 [US2] Add SC-003 three-timeout terminal case: three consecutive cycles with `blocked:fixer-timeout` present. Cycle 1: `retryAttempt: 1` on enqueue, handler applies `blocked:fixer-timeout` (retry-eligible). Cycle 2: same. Cycle 3: `retryAttempt: 2` on enqueue, handler applies `blocked:fixer-timeout-repeat` (terminal). Cycle 4: monitor's retry-eligible branch's else-branch fires `gate: 'blocked-fixer-timeout-budget-exhausted'` warn, falls through to `blocked:*` skip, no enqueue. Depends on T011, T012, T025.

- [X] T052 [US2] Add SC-003a zero-commit terminal case: mock CLI to return `{ success: false, exitCode: 143, timedOut: true }` with `commitAndPushChanges` returning `false`. Handler applies `blocked:fixer-timeout-no-progress`. Monitor's next poll: label present, but exact-match retry-eligible branch does NOT match (label is `-no-progress`, not `blocked:fixer-timeout`); generic `blocked:*` short-circuit matches → no enqueue. Assert `fixerTimeoutRetryCount.get(stateKey)` NEVER incremented. Depends on T011, T025.

- [X] T053 [US2] Add SC-003b counter-reset test per `contracts/counter-reset-trigger.md` §"Test coverage": timeline `[timeout, timeout, full-resolve, timeout, timeout, timeout]`. Two timeouts push counter to 2. Case C fires → counter deleted. Three more timeouts: cycle 4 dispatches with `retryAttempt: 1`, cycle 5 with `retryAttempt: 2`, cycle 6 handler applies `blocked:fixer-timeout-repeat`. Assert terminal label appears on cycle 6 (not cycle 4). Depends on T013.

- [X] T054 [US2] Add failure-isolation case: `client.removeLabels` throws in the retry-eligible branch → branch falls through WITHOUT dispatching (safer than racing the handler's own removal). Counter NOT incremented on that poll. Generic `blocked:*` short-circuit matches on next assertion. Depends on T011.

### Integration test

- [X] T060 [US2] Add end-to-end retry-then-succeed integration test to `packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts` covering SC-002: mock CLI to time out first invocation (with pushed commit), succeed second invocation (with reply+resolve loop completing). Assert final state: no `blocked:*` labels on issue, all review threads resolved, `fixerTimeoutRetryCount` cleared via Case C. This is the primary field-scenario regression test. Depends on Phases 2-3.

### Cockpit test

- [X] T070 [US1] Add three timeline-based cockpit precedence assertions to `packages/cockpit/src/__tests__/classifier.test.ts` (or a new `packages/cockpit/src/__tests__/e2e-fixer-timeout.test.ts` alongside `e2e-address-pr-feedback.test.ts`) per plan `§D-3` "Test coverage":
   - Issue with `blocked:fixer-timeout-no-progress` + `waiting-for:address-pr-feedback` → surfaces `blocked:fixer-timeout-no-progress` (terminal outranks).
   - Issue with `blocked:fixer-timeout-repeat` + `waiting-for:address-pr-feedback` → surfaces `blocked:fixer-timeout-repeat`.
   - Issue with `blocked:fixer-timeout` + `waiting-for:address-pr-feedback` → surfaces `waiting-for:address-pr-feedback` (retry-eligible sorts below).
   Depends on T030.

- [X] T071 [US1] Verify SC-005 by running the existing `packages/cockpit/src/__tests__/e2e-address-pr-feedback.test.ts:119` test UNMODIFIED — must continue to pass. This is a preservation assertion, not a new test. Any modification of this test breaks SC-005.

## Phase 6: Verification & Changeset

- [X] T080 [P] Add a **newly created** changeset file `.changeset/1070-fixer-timeout-disposition.md` per CLAUDE.md's changeset gate. Contents: bump `@generacy-ai/workflow-engine` **minor** (new label vocabulary per the "new label vocabulary in `workflow-engine` → `minor`" rule); bump `@generacy-ai/orchestrator` **patch** (internal behavior change, no new public exports); bump `@generacy-ai/cockpit` **patch** (WAITING_PIPELINE_ORDER addition, no new exports). Single file, three bumps. Body: one-sentence summary referencing `#1070`.

- [X] T081 Run full test suite for the three touched packages: `pnpm --filter @generacy-ai/orchestrator test`, `pnpm --filter @generacy-ai/workflow-engine test`, `pnpm --filter @generacy-ai/cockpit test`. All new tests green; SC-005 preservation confirmed; no unrelated regressions.

- [X] T082 Run `pnpm changeset status` to confirm the new changeset is picked up (CI gate at `.github/workflows/changeset-bot.yml` greps `--diff-filter=A` for newly-added `.changeset/*.md` files).

- [X] T083 Manual log-line audit per `quickstart.md` §"Log-line audit": grep the compiled handler for any `'Successfully pushed'` occurrence and confirm it is only reachable when `hasChanges && success`. Prove the SC-004 fix landed.

## Dependencies & Execution Order

**Phase order** (sequential):
- Phase 1 (T001-T003) → foundation types + label vocab. **Must land first** — everything else references these.
- Phase 2 (T010-T013) + Phase 3 (T020-T025) → parallel-eligible internally, both depend on Phase 1. Phase 3 also depends on T002 (retryAttempt field).
- Phase 4 (T030) → depends only on T001 (label names must exist).
- Phase 5 (T040-T071) → depends on Phases 2+3 for handler/monitor tests; T070 depends on T030.
- Phase 6 (T080-T083) → depends on all preceding phases.

**Load-bearing bundling** (per plan §"Ordering & Execution Notes"):
- T002 (metadata field), T010 (counter map), T011 (retry branch), T012 (metadata attach), T024 (handler read), T025 (handler decision) MUST land in the **same PR** — the field is a wire-format contract and split PRs would leave the handler reading `undefined` from a monitor that never wrote the field.
- T030 (cockpit precedence) is technically decoupled but MUST land in the same PR to satisfy SC-001 operator-triage (terminal labels must surface in cockpit UI on day one).
- T080 (changeset file) MUST be a **newly added** file — editing an existing changeset does not satisfy the CI gate.

**Parallel opportunities within phases** (marked with [P]):
- Phase 1: T001, T002, T003 all touch different files — safe to author in parallel.
- Phase 2 tasks T010-T013 all touch the same file (`pr-feedback-monitor-service.ts`) — sequential.
- Phase 3 tasks T020-T025 all touch the same file (`pr-feedback-handler.ts`) — sequential; T021 depends on T020, T024 depends on T002+T021, T025 depends on T023+T024, T022 depends on T021.
- Phase 5: T040-T054, T060, T070-T071 target different test files — parallel-eligible pairwise (T040 must precede T041; T050-T054 sequential within the monitor test file).
- Phase 6: T080 is file-add only, independent of other verification steps.

**Non-goals reminder** (from spec §"Out of Scope"):
- Do NOT extend the retry budget beyond 2.
- Do NOT change the 20-minute CLI timeout (`config.phaseTimeoutMs`).
- Do NOT modify the fixer prompt on retry (FR-008 — retry uses identical prompt).
- Do NOT touch `blocked:body-finding-unaddressed` / Disposition C behavior (FR-009).
- Do NOT change `agent:in-progress` clear semantics (FR-010 preserves #926).
- Do NOT add auto-retry on non-timeout failure modes (`push-failed`, `resolve-batch-zero-successes` remain human-only).
- Do NOT introduce new Redis keys or files under `/var/lib/generacy/` (SC-006).
