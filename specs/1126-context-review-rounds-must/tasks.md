# Tasks: Re-review convergence — delta-scoped verification passes

**Input**: Design documents from `/specs/1126-context-review-rounds-must/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/verification-pass.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup

- [X] T001 Create the module directory `packages/orchestrator/src/worker/review/` and its
      test directory `packages/orchestrator/src/worker/review/__tests__/`. Add the changeset
      `.changeset/1126-verification-pass-convergence.md` — `@generacy-ai/orchestrator` **patch**
      (internal worker convergence logic + pause-context read-side field; no new public exports).
      Confirm bump level at implement time via `pnpm why @generacy-ai/orchestrator`; upgrade to
      **minor** only if a new public package export is added.

## Phase 2: Foundational (blocks all story work)

- [X] T002 [US1] Create the #1124 seam interface + severity helper in
      `packages/orchestrator/src/worker/review/findings-artifact.ts`: `Severity`
      (`'minor' | 'major' | 'critical'`), `FindingStatus`, `ReviewVerdict`, `ReviewFinding`,
      `FindingsArtifact` (per data-model.md). Add the `sev()` helper
      (`minor=0 < major=1 < critical=2`). Mark the file `// #1124 seam`. Absent artifact is
      normalized as `{ round: 0, findings: [] }`.

## Phase 3: US1 — Converging re-reviews after remediation (Priority: P1)

**Goal**: A re-review (round ≥ 2) is scoped to the delta since the last-reviewed SHA plus the
still-open findings, drops new advisory findings after round 1, and advances a monotonic
artifact.

**Independent test**: Run the `review/` unit tests — mode selection, delta correctness,
status transitions, filter, verdict, and prompt content all pass against injected artifacts
with no phase loop booted.

- [X] T003 [P] [US1] Implement `determineReviewMode(artifact?)` in
      `packages/orchestrator/src/worker/review/review-mode.ts` (FR-001): absent / `round === 0` /
      no `lastReviewedSha` ⇒ `{ kind: 'full-review', round: 1 }`; else
      `{ kind: 'verification', round: artifact.round + 1 }`. Match the truth table in
      contracts/verification-pass.md.

- [X] T004 [P] [US1] Implement `composeVerificationInput(delta, artifact)` in
      `packages/orchestrator/src/worker/review/verification-input.ts` (FR-003): `deltaFiles =
      delta.files`; `openFindings = artifact.findings.filter(f => f.status === 'open')`. Enumerate
      ALL open findings even if outside the delta (Q2); do not filter here.

- [X] T005 [P] [US1] Implement `buildVerificationPrompt(parts)` in
      `packages/orchestrator/src/worker/review/verification-prompt.ts` (FR-004): output contains
      the literal round number (e.g. `Round 2`), each open finding's `title`/`detail` verbatim,
      and the verification-charter framing when `parts.charter === 'verification'` (SC-006).

- [X] T006 [P] [US1] Implement `computeReviewDelta(input)` in
      `packages/orchestrator/src/worker/review/review-delta.ts` (FR-002 + FR-009 branches only;
      resolution branch lands in T013): base-selection order (2) artifact `lastReviewedSha` **and**
      `await commitExistsInCheckout(sha)` ⇒ `source: 'last-reviewed'`, head = `getCurrentCommitSha()`;
      (3) otherwise ⇒ `source: 'full-diff'`, base = `prBaseRef`, head = `getCurrentCommitSha()`.
      Files via `getFilesChangedBetween(base, head)`. Every branch returns
      `round = artifact.round + 1` (Q5 — no round-1 reset). Identical SHAs ⇒ `files: []` (SC-001).
      A genuine git failure propagates; only a missing SHA (`commitExistsInCheckout === false`)
      triggers the fallback.

- [X] T007 [P] [US1] Implement the status machine in
      `packages/orchestrator/src/worker/review/findings-advance.ts`: `filterNewFindings(newFindings,
      round, blockingSeverity)` (FR-005 — round 1 keeps all; round ≥ 2 drops `sev < blockingSeverity`,
      returns `{ kept, dropped }`), `advanceArtifact(input)` (FR-006 — resolve delta-located addressed
      open findings; leave non-delta open findings untouched Q2; never touch `resolved` Q1; append
      filtered new findings with `round = delta.round`; set `lastReviewedSha = delta.base.head`;
      immutable), and `computeVerdict(artifact, blockingSeverity)` (FR-008 — `changes-required` iff any
      `open` finding `sev >= blockingSeverity`; else `clean`).

- [X] T008 [US1] Add barrel exports in `packages/orchestrator/src/worker/review/index.ts` for the
      types and all pure functions from T002–T007.

- [X] T009 [P] [US1] Unit test `packages/orchestrator/src/worker/review/__tests__/review-mode.test.ts`
      (SC-001 mode selection) covering the full contract truth table.

- [X] T010 [P] [US1] Unit test `packages/orchestrator/src/worker/review/__tests__/review-delta.test.ts`
      (SC-001): last-reviewed base selected when `commitExistsInCheckout` true; identical SHAs ⇒ empty
      delta; missing/unresolvable SHA ⇒ `full-diff` fallback with `round` still `artifact.round + 1`;
      genuine git error propagates.

- [X] T011 [P] [US1] Unit test `packages/orchestrator/src/worker/review/__tests__/findings-advance.test.ts`
      (SC-002/SC-003/SC-004): addressed delta-located open findings → `resolved`; unaddressed and
      non-delta open findings stay `open`; `resolved` never re-opened (Q1); new advisory findings
      dropped on round ≥ 2 and kept on round 1 (Q3); new blocking findings appended with correct
      round; `lastReviewedSha` advanced; verdict correctness.

- [X] T012 [P] [US1] Unit test
      `packages/orchestrator/src/worker/review/__tests__/verification-prompt.test.ts` (SC-006):
      assert the prompt contains the round number and each open finding's `title`/`detail` verbatim.

**Checkpoint**: US1 convergence logic is fully unit-tested and buildable in isolation.

## Phase 4: US2 — Merge-conflict-resolution re-reviews stay narrow (Priority: P1)

**Goal**: When the pause-context sidecar carries resolution base/head SHAs, the re-review delta is
scoped to just the resolution diff (same verification charter, round still increments).

**Independent test**: `computeReviewDelta` with a `pauseContext` carrying resolution SHAs returns a
`source: 'resolution'` delta excluding files untouched by the resolution.

- [X] T013 [US2] Extend `PauseContextSchema` in
      `packages/orchestrator/src/worker/pause-context.ts` with optional
      `resolutionBaseSha?: string` and `resolutionHeadSha?: string` (both `.optional()`,
      non-breaking, read-side only — #1131 owns writing them).

- [X] T014 [US2] Add the resolution branch to `computeReviewDelta` in
      `packages/orchestrator/src/worker/review/review-delta.ts` (FR-007): when
      `pauseContext.resolutionBaseSha && pauseContext.resolutionHeadSha` are both present, select
      `source: 'resolution'` with those SHAs (highest priority, before last-reviewed). Still returns
      `round = artifact.round + 1` under the same verification charter (Q4). Depends on T006 and T013.
      Extend `review-delta.test.ts` (T010) to cover the resolution branch and file-scoping exclusion.

**Checkpoint**: Both delta sources (remediate re-review and merge-conflict resolution) are covered.

## Phase 5: Integration — wire the convergence module through the phase loop

- [X] T015 [US1] Wire the `review` stub branch in
      `packages/orchestrator/src/worker/phase-loop.ts` (`473-477`) through the convergence module:
      load/persist the artifact via `PhaseTracker.getValueRaw/setValueRaw/clearRaw` under the
      `review-findings:<owner>:<repo>:<issue>:<branch>` key (mirror the `phase-start-ref:` shape and
      7-day TTL at `389-398`); call `determineReviewMode` → `computeReviewDelta` (reading resolution
      SHAs from the pause-context sidecar) → `composeVerificationInput` → `buildVerificationPrompt` →
      `advanceArtifact` → persist. Consume `ResolvedWorkflowConfig.review.blockingSeverity`
      (`config.ts:33`). Degrade to null/no-op when Redis is down (fresh full review, FR-009 posture).

- [X] T016 [US1/US2] Integration test
      `packages/orchestrator/src/worker/__tests__/phase-loop.verification-pass.test.ts` (SC-005):
      exercise the remediate re-review path AND the merge-conflict resolution-scoped path via the
      phase loop; assert the scoped input excludes unrelated files and that the artifact/`lastReviewedSha`
      advances across rounds. Reuse `createMockDeps()` / `github` mocks from
      `phase-loop.test.ts:42-96`.

## Phase 6: Verification & Polish

- [X] T017 Run `pnpm --filter @generacy-ai/orchestrator build`,
      `pnpm --filter @generacy-ai/orchestrator test review`, and
      `pnpm --filter @generacy-ai/orchestrator test phase-loop` (per quickstart.md). Confirm the
      changeset from T001 exists as a newly-added file and the bump level is correct. Confirm the
      `blockingSeverity` default mismatch noted in research.md (`major` vs current `critical` in
      `config.ts:11`) is left to #1122/#1124 — this feature only consumes it.

## Dependencies & Execution Order

**Phase boundaries (sequential)**:
- Phase 1 (Setup) → Phase 2 (Foundational) → Phase 3 (US1) → Phase 4 (US2) → Phase 5 (Integration) → Phase 6 (Verification)

**Blocking dependencies**:
- T002 (seam interface + `sev()`) blocks all of T003–T007 (they import its types/helper).
- T008 (barrel) depends on T003–T007.
- T009–T012 (unit tests) depend on their respective implementations (T003/T006/T007/T005).
- T014 (resolution branch) depends on T006 (base function) and T013 (pause-context field).
- T015 (phase-loop wiring) depends on the full module (T008) and the pause-context field (T013).
- T016 (integration test) depends on T015.
- T017 (verification) depends on everything.

**Parallel opportunities**:
- Within Phase 3: T003, T004, T005, T006, T007 are all `[P]` (distinct files, each depends only on T002).
- Within Phase 3: unit tests T009, T010, T011, T012 are `[P]` once their implementations exist.

**Independent story delivery**:
- US1 (Phase 3) is independently testable via the `review/` unit tests without US2 or the phase loop.
- US2 (Phase 4) adds only the resolution delta branch + pause-context field on top of US1.

## MVP scope

US1 (Phases 1–3) is the minimum viable convergence: it delivers delta-scoped verification passes for
the remediate re-review loop. US2 (Phase 4) and the phase-loop wiring (Phase 5) extend it to the
merge-conflict path and live orchestration.
