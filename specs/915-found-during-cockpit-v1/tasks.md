# Tasks: Surface classifier reason in failure evidence

**Input**: Design documents from `/specs/915-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/failure-reason-block.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 = classifier-message surfacing; US2 = process-path shape preserved

## Phase 1: Type + helper extension

- [X] T001 [US1] Extend `CommandExitEvidence` in `packages/orchestrator/src/worker/types.ts` (union variant at ~:250–294; `Extract` alias at ~:302–305) with optional `reason?: string`. Add JSDoc per data-model.md §Core Types (source = `error.message` when caller passes `classifier`; format = single-line inline or multi-line fenced; ZWSP-escaped at render). Field is additive; do not touch `command`, `exitDescriptor`, `outputTail`, or the `mergeConflict` variant.

- [X] T002 [US1] Extend `PhaseLoop.buildErrorEvidence` signature in `packages/orchestrator/src/worker/phase-loop.ts` (~:989) with an optional 4th parameter `classifier?: string`. When `classifier` is a non-empty string, set `exitDescriptor = \`failed post-exit: ${classifier} (process exit ${result.exitCode})\`` and include `reason: result.error?.message ?? ''` in the returned object. When `classifier` is `undefined`, exit-descriptor branching and returned shape are byte-identical to pre-fix. Do not cap or ZWSP-escape `reason` here — rendering owns both.

- [X] T003 [US1] [US2] Update all six `buildErrorEvidence` callsites in `packages/orchestrator/src/worker/phase-loop.ts` to pass `classifier` explicitly per the vocabulary in data-model.md §Classifier Vocabulary and contracts/failure-reason-block.md:
  - `~:294` (pre-validate install failure, shell process) → `classifier: undefined`
  - `~:373` (unexpected-spawn catch, synthetic) → `'spawn-error'`
  - `~:429` (no-progress guard, synthetic) → `'no-progress'`
  - `~:548` (post-phase process failure, shell/CLI process) → `classifier: undefined`
  - `~:600` (product-diff-detection catch, synthetic) → `'product-diff-error'`
  - `~:630` (product-diff guard, synthetic) → `'no-product-code-changes'`

  Explicit `undefined` at process sites is required (Q5→B) — grep-auditable statement, not implied by omission.

## Phase 2: Renderer updates
<!-- Depends on Phase 1: renderers read `evidence.reason`, so the field must exist first. -->

- [X] T004 [US1] Add a local reason-format helper inside `packages/orchestrator/src/worker/stage-comment-manager.ts` (private module function, not exported) implementing the normalization defined in data-model.md §Reason format contract and contracts/failure-reason-block.md §Rendering normalization:
  1. Return no lines when `evidence.reason` is `undefined` or `''`.
  2. `safeReason = reason.replace(/`/g, '`​')` (ZWSP after every single backtick — mirror the `outputTail` idiom already at ~:200 / ~:334).
  3. `isMultiLine = safeReason.includes('\n')`.
  4. Single-line → emit one line: `**Reason**: <safeReason>`.
  5. Multi-line → emit `**Reason**:`, blank line, ` ```text `, capped body (1 KiB byte cap via `Buffer.byteLength`; append `…` + newline on truncate), ` ``` `, blank line.

  Single-line reasons are NOT capped at the render layer.

- [X] T005 [US1] Wire the helper into `appendEvidenceBlock` in `packages/orchestrator/src/worker/stage-comment-manager.ts` (~:193): insert the reason-block output between the `**Exit**` line and the blank line preceding the `<details>` wrapper. Exact byte layout per contracts/failure-reason-block.md §Placement (stage comment). Must remain byte-identical above the reason line for pre-fix inputs (T007 asserts this).

- [X] T006 [US1] Wire the helper into `renderFailureAlert` in `packages/orchestrator/src/worker/stage-comment-manager.ts` (~:329): insert the reason-block output between the summary line and the blank line preceding the `<details>` wrapper. Exact byte layout per contracts/failure-reason-block.md §Placement (failure alert). Both renderers MUST call the same T004 helper — no divergent inline copy.

## Phase 3: Regression fixtures
<!-- Depends on Phases 1 + 2: fixtures assert both the derived evidence shape (Phase 1) and the rendered markdown (Phase 2). -->

- [X] T007 [US1] [US2] Extend `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` with six new fixtures covering every `buildErrorEvidence` callsite (data-model.md §Classifier Vocabulary, spec.md §Regression tests, plan.md Testing Strategy):
  - Four synthetic-path fixtures (`no-progress`, `no-product-code-changes`, `spawn-error`, `product-diff-error`) each assert:
    * `evidence.reason` equals the classifier's raw `error.message`.
    * `evidence.exitDescriptor` matches `` `failed post-exit: <classifier> (process exit <N>)` ``.
    * `evidence.outputTail` unchanged (counter text for `no-progress`; `(no output on either stream)` literal for the other three).
    * Rendered surface never contains `(no output on either stream)` as the only evidence surface.
  - Two process-path regression fixtures (`:294` pre-validate install; `:548` post-phase process failure) each assert:
    * `evidence.reason === undefined`.
    * `evidence.exitDescriptor` reads pre-fix shape (`exit <N>` / `killed …` / `aborted`).

- [X] T008 [P] [US1] Extend `packages/orchestrator/src/worker/__tests__/stage-comment-manager.test.ts` with rendering fixtures per contracts/failure-reason-block.md §Rendering normalization:
  - Single-line reason renders inline as `**Reason**: <text>` between `**Exit**` and `<details>` in `appendEvidenceBlock`.
  - Multi-line reason renders as `**Reason**:` + blank line + fenced ` ```text ` block above `<details>`.
  - Multi-line reason > 1 KiB is truncated to 1024 bytes and terminated with `…` + newline + closing fence.
  - Backtick in reason emits `` ` `` + ZWSP (`​`) in the rendered output.
  - Absent / empty `reason` produces byte-identical output to the pre-#915 (#890) shape.
  - Both `appendEvidenceBlock` and `renderFailureAlert` produce byte-identical reason-block substrings when fed the same `CommandExitEvidence` (lockstep invariant, contracts §Invariants 3).

## Phase 4: Changeset
<!-- Independent of Phase 3 — can run in parallel with T007/T008. -->

- [X] T009 [P] [US1] Add a `.changeset/` markdown entry describing the additive `reason?: string` field on `CommandExitEvidence` plus the `classifier?` parameter on `buildErrorEvidence`. Bump `@generacy-ai/orchestrator` with a patch semver (change is additive; no breaking consumers per plan.md §Rollout).

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 → T002 → T003 (helper signature depends on the type; callsites depend on the helper signature).
- T004 → T005, T006 (both renderers wire the same helper).
- Phase 3 fixtures (T007, T008) depend on Phases 1 + 2 being merged into the branch — they assert real behavior, not mocked.

**Parallel opportunities**:
- T005 and T006 modify the same file (`stage-comment-manager.ts`) — must be sequential.
- T007 and T008 modify different test files — can run in parallel (marked `[P]` on T008; T007 is the anchor).
- T009 (changeset) modifies only `.changeset/` — parallelizable with anything in Phases 1–3 once T001–T003 land.

**Suggested execution**: T001 → T002 → T003 → T004 → T005 → T006 → (T007 + T008 + T009 in parallel).

## Next step

Run `/speckit:implement` to begin execution.
