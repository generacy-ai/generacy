# Tasks: Fresh single-package repos survive validate; failed phases post their evidence to the issue

**Input**: Design documents from `/specs/847-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/pre-validate-degrade.md, contracts/failure-evidence-block.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = Gap A degrade, US2 = Gap B evidence)

## Phase 1: Foundation — shared type surface

- [ ] T001 [US2] Extend `StageCommentData` in `packages/orchestrator/src/worker/types.ts` with optional `errorEvidence?: { command: string; exitDescriptor: string; stderrTail: string }` field. Field is optional; renderer + phase-loop callers land in later phases. No changes to `PhaseResult` (deliberately per plan Design Overview → Non-changes and Decision 7). See `data-model.md#modified-type` for exact JSDoc.

## Phase 2: Gap A — preValidate degrade (US1)
<!-- Phase boundary: Phase 1 is prerequisite only for Phase 3; Phase 2 can proceed independently after T001 is not required (US1 does not touch types.ts). -->

- [ ] T002 [US1] Update `WorkerConfigSchema.preValidateCommand` default in `packages/orchestrator/src/worker/config.ts:59` to the byte-exact degrade shell string per `contracts/pre-validate-degrade.md#default-command-post-fix`:
  ```
  pnpm install && if [ -f pnpm-workspace.yaml ] && ls packages/*/package.json >/dev/null 2>&1; then pnpm -r --filter './packages/*' build; fi
  ```
  Do NOT touch `applyRepoValidateOverrides` (`config.ts:98`) or the explicit-empty-string handling (`config.ts:110–115`). FR-001, FR-002.

- [ ] T003 [US1] Extend `packages/orchestrator/src/worker/__tests__/config.test.ts` with:
  1. `WorkerConfigSchema.parse({}).preValidateCommand === "<exact default string>"` byte-assertion (SC-005 signal, catches whitespace drift).
  2. Override with a custom `preValidateCommand` → returned config has the custom string (FR-002 regression guard on `applyRepoValidateOverrides`).
  3. Override with `""` (explicit empty) → returned config has `""` (skip-install preserved, FR-002).
  4. Override with only `validateCommand` set → `preValidateCommand` retains the new default.
  See `contracts/pre-validate-degrade.md#regression-tests` for the four cases.

## Phase 3: Gap B — evidence block (US2)
<!-- Phase boundary: Complete Phase 1 (T001) before starting. T004/T005/T007 are parallelizable; T006/T008/T009 have file-level dependencies. -->

- [ ] T004 [P] [US2] Create `packages/orchestrator/src/worker/stderr-tail.ts` exporting a pure `boundStderrTail(raw: string): string` per `data-model.md#new-pure-function-boundary`:
  - Empty input → literal `(stderr empty)`.
  - Non-empty ≤ 4096 bytes after `slice(-30)`.join('\n') → return unchanged (no marker).
  - Non-empty > 4096 bytes → truncate-from-start of the last-30-lines slice to 4096 bytes; prepend `… truncated (kept last <N> lines / 4096 bytes) …\n` where `<N>` is the line count of the returned slice.
  - MUST hold ≤ ~4200 bytes for any input up to 100 MB.
  Zero dependencies beyond `node:buffer`.

- [ ] T005 [P] [US2] Create `packages/orchestrator/src/worker/__tests__/stderr-tail.test.ts` covering `boundStderrTail` contract from T004:
  1. Empty string → `(stderr empty)`.
  2. Short (< 30 lines, < 4 KiB) → unchanged, no marker.
  3. Exactly 30 lines totaling ≤ 4 KiB → unchanged, no marker.
  4. > 30 lines, tail ≤ 4 KiB → last 30 lines only, no marker.
  5. > 30 lines, tail > 4 KiB → marker prepended, body ≤ 4096 bytes.
  6. 100 MB synthetic stderr (SC-004 fuzz) → output ≤ ~4200 bytes total, marker present.
  7. UTF-8 multi-byte content near cut point → decoded output is valid UTF-8 (no split codepoints; MAY resync to `\n`).

- [ ] T006 [US2] In `packages/orchestrator/src/worker/phase-loop.ts`, add a private `buildErrorEvidence(command: string, result: PhaseResult, resolvedTimeoutMs?: number): StageCommentData['errorEvidence']` helper matching `contracts/failure-evidence-block.md#field-derivations-from-phaseresult`:
  - `exitDescriptor` = `killed (SIGTERM) after ${resolvedTimeoutMs}ms` when `result.error?.message.includes('timed out')`; `'aborted'` when it includes `'was aborted'`; else `exit ${result.exitCode}`.
  - `stderrTail` = `boundStderrTail(result.error?.stderr ?? '')`.
  Then thread it into all three `updateStageComment({ status: 'error', ... })` call sites:
  1. Pre-validate install failure (line ~168): `command = config.preValidateCommand`, `result = installResult`, `resolvedTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS`.
  2. Unexpected spawn error catch (line ~217): synthesize `PhaseResult` from caught error (`{ error: { message: String(error), stderr: '', phase }, exitCode: 1, success: false }`); `command = phase === 'validate' ? config.validateCommand : phase`.
  3. Post-phase failure sites (~336, ~373, ~394): `command = phase === 'validate' ? config.validateCommand : phase`, `result = result`, `resolvedTimeoutMs` from the same source passed to the spawner. FR-003, FR-005. Depends on T001.

- [ ] T007 [P] [US2] Extend `renderStageComment` in `packages/orchestrator/src/worker/stage-comment-manager.ts` (starting at ~line 119) to append the evidence block per `contracts/failure-evidence-block.md#placement`:
  - Only when `data.status === 'error'` AND `data.errorEvidence` present (all three sub-fields).
  - Insert horizontal rule `---` after the last existing summary metadata line (after `**PR**` or `**Completed**`).
  - Emit exactly:
    ```
    **Failed command**: `<command>`
    **Exit**: <exitDescriptor>

    <details><summary>stderr (last <N> lines)</summary>

    ```text
    <stderrTail>
    ```

    </details>
    ```
    where `<N>` is `stderrTail.split('\n').length`.
  - Escape/substitute any triple-backtick sequence inside `stderrTail` with a zero-width space between two of the backticks (invariant 5 in the contract) so the fenced block cannot be broken out of.
  - On `errorEvidence` absent while `status === 'error'` (defensive path), omit the block and log a warning via the existing logger.
  - MUST NOT change any bytes above the horizontal rule; the `**Status**: ❌ Error` line stays byte-stable for the cockpit classifier (FR-006). Depends on T001.

- [ ] T008 [US2] Extend `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` to assert `errorEvidence` is passed to `updateStageComment` at each of the three `status: 'error'` sites:
  1. Pre-validate install failure → mock spy on `stageCommentManager.updateStageComment` asserts `command === config.preValidateCommand`, `exitDescriptor === 'exit <N>'`, `stderrTail` matches `installResult.error.stderr` after bounding.
  2. Unexpected spawn catch → synthetic `PhaseResult` shape asserted; `exitDescriptor === 'exit 1'`, `stderrTail === '(stderr empty)'`.
  3. Post-phase failure (validate + implement + gate paths) → three sub-cases with the correct `command` sourcing (`config.validateCommand` for validate; phase name string otherwise).
  4. Timeout site → `error.message` set to the timeout wording from `cli-spawner.ts:240–244` → `exitDescriptor === 'killed (SIGTERM) after <Nms>'`.
  5. Abort site → `error.message` set to the abort wording → `exitDescriptor === 'aborted'`.
  Depends on T006.

- [ ] T009 [US2] Extend `packages/orchestrator/src/worker/__tests__/stage-comment-manager.test.ts` per `contracts/failure-evidence-block.md#test-fixtures-stage-comment-managertestts`:
  1. Happy path (`status: 'complete'` + PR URL) → rendered markdown byte-identical to pre-fix (FR-007).
  2. Numeric-exit failure → asserts on exact rendered markdown including `**Failed command**`, `**Exit**: exit 1`, fenced block contents.
  3. Timeout failure → `**Exit**: killed (SIGTERM) after 300000ms` renders verbatim.
  4. Abort failure with empty stderr → `**Exit**: aborted` + fenced block contains literal `(stderr empty)`.
  5. Truncated stderr → marker `… truncated (kept last 30 lines / 4096 bytes) …` is first line inside the fenced block.
  6. Backtick-poisoned stderr → substitution keeps the fenced block closed by its own 3 backticks (invariant 5).
  7. Missing `errorEvidence` on `status: 'error'` → renderer omits block + logs a warning.
  8. HTML marker `STAGE_MARKERS[stage]` remains first line of comment body (invariant 3).
  Depends on T007.

## Phase 4: Documentation (FR-008)
<!-- Phase boundary: Complete Phases 2 and 3 first — docs describe shipped behavior. -->

- [ ] T010 [P] [US1] Update `docs/docs/getting-started/configuration.md` to document the new degrade behavior: (a) the default `preValidateCommand` now runs `pnpm install` unconditionally and only fires the `pnpm -r --filter` build half when both `pnpm-workspace.yaml` and `packages/*/package.json` exist; (b) the per-repo override in `.generacy/config.yaml` still takes precedence and an explicit empty string still means "skip install"; (c) template authors who want a non-pnpm stack should set the override rather than depend on the default (FR-008).

## Dependencies & Execution Order

**Sequential dependencies (must complete in order)**:
- T001 (types.ts) → T006 (phase-loop.ts uses `StageCommentData['errorEvidence']` type), T007 (stage-comment-manager.ts reads the field).
- T004 (stderr-tail.ts) → T005 (its test file), T006 (imports `boundStderrTail`).
- T006 (phase-loop.ts) → T008 (phase-loop.test.ts asserts on the helper's behavior).
- T007 (stage-comment-manager.ts) → T009 (stage-comment-manager.test.ts asserts on rendered output).
- Phases 2 and 3 → T010 (docs describe the landed behavior).

**Parallelizable within Phase 3** (after T001):
- T004 and T005 (new file + new test file) can proceed in parallel with T007 (stage-comment-manager.ts extension) — different files, no data dependency between the pure `boundStderrTail` and the renderer's changes.
- T006 must wait for T004 (needs `boundStderrTail` import).

**Phase-2 vs Phase-3 independence**: US1 (config.ts + config.test.ts) and US2 (stderr-tail, phase-loop, stage-comment-manager, their tests) touch disjoint files. Phase 2 can proceed in parallel with the entire Phase 3 chain — the only cross-story coupling is T001, which is a pure type addition consumed only by Phase 3 files.

**Non-changes** (deliberate, per plan Design Overview → Non-changes):
- No new fields on `PhaseResult`.
- No changes to `applyRepoValidateOverrides` in `config.ts`.
- No changes to the cockpit classifier surface.
- No new relay events.
- FR-009 (staging emits template-appropriate `orchestrator` block) is OUT OF SCOPE — companion issue in `generacy-cloud`, tracked separately.
