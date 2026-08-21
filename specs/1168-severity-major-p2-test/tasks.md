# Tasks: Composed-loop integration coverage for review/remediate executors and gate-label resume

**Input**: Design documents from `/specs/1168-severity-major-p2-test/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

**Scope note**: This is a **test-only** feature. Every added/modified file lives under
`packages/orchestrator/src/worker/__tests__/`. No product `src/` code ships and **no changeset**
is required (the changeset gate exempts test-only diffs). Any deviation (a genuine untestable
seam requiring a ≤ small production fix) must be flagged before landing.

---

## Phase 1: Foundation — fixture, double, harness

<!-- These three artifacts are the shared substrate for US1 and US3. Everything downstream depends on them. -->

- [ ] T001 [P] [US1] Create the real spawnable scripted agent-CLI fixture at
  `packages/orchestrator/src/worker/__tests__/fixtures/scripted-review-cli.mjs`.
  Per `contracts/scripted-cli-fixture.md`: read `FIXTURE_CHECKOUT_PATH`, `FIXTURE_WORKFLOW_ID`,
  `FIXTURE_MODE` (`write` | `withhold`), `FIXTURE_CANDIDATE_JSON` from env. Sanitize the workflow
  id with `[^a-zA-Z0-9_-] → _` (matching the engine's derivation), resolve
  `.generacy/review-candidate-<sanitized>.json`. `write` → `mkdir -p .generacy`, write the
  candidate JSON verbatim, `process.exit(0)`. `withhold` → write nothing, `process.exit(0)`.
  Writes only within `FIXTURE_CHECKOUT_PATH`; no network; no stdout contract.

- [ ] T002 [P] [US1] Create the spawning `AgentLauncher` test double at
  `packages/orchestrator/src/worker/__tests__/helpers/spawning-agent-launcher.ts`.
  Per `contracts/spawning-agent-launcher-double.md`: expose `launch(request): Promise<LaunchHandle>`
  that `child_process.spawn(process.execPath, [FIXTURE_PATH], { cwd: request.cwd, env: { ...process.env,
  FIXTURE_* } })` (per-scenario `FIXTURE_*` env closed over at construction), adapts the Node
  `ChildProcess` to `ChildProcessHandle` (`stdin/stdout/stderr`, `pid`, `kill(signal)`,
  `exitPromise` from the child's `exit` event), and returns
  `{ process, outputParser: { processChunk(){}, flush(){} }, metadata: { pluginId: 'test-spawning-double', intentKind: 'review' } }`.
  No verdict logic, no findings synthesis.

- [ ] T003 [US1] Create the composition harness at
  `packages/orchestrator/src/worker/__tests__/helpers/review-composition-harness.ts`.
  `mkdtemp` a real checkout containing `.generacy/`, set an isolated `HOME` / `GIT_CONFIG_GLOBAL`
  pointed at the temp dir, `git init` + identity (follow the real-git pattern in
  `review-executor.ts` #1131 block / `initRepoWithCommits`). Build `workflowId =
  ${owner}/${repo}#${issueNumber}`. Provide a recording **fake** `GitHubClient` (shape of
  `createGithubSpy` in `phase-loop.review-clean.integration.test.ts`: empty `listReviews` /
  `listPullRequestFiles` / `getPRReviewThreads`, captures `createReview` / ready / draft calls).
  Provide a `PhaseLoopDeps` builder wiring the real `ReviewExecutor` (with the T002 double) and
  hand-constructed `WorkerConfig` (NOT `.parse()`d) with `reviewPhaseEnabled: true`; expose knobs
  for `blockingSeverity`, `phaseTimeoutMs`, `shutdownGracePeriodMs`. Mock doubles for
  `labelManager`, `stageCommentManager`, `gateChecker`, `cliSpawner`, `outputCapture`,
  `prManager` (non-review phases short-circuit to success). Do **not** wire
  `readFindingsArtifact` (would re-introduce the steering seam). Include per-suite teardown that
  `rm -rf`s the temp dir. Depends on T001, T002.

---

## Phase 2: US1 — real ReviewExecutor composed under PhaseLoop

<!-- Phase boundary: Phase 1 must complete before starting Phase 2. -->

All tasks in this phase land in the new file
`packages/orchestrator/src/worker/__tests__/phase-loop.review-composed.integration.test.ts`
and share the T003 harness, so they are sequential within the file (no `[P]`).

- [ ] T010 [US1] Add the verdict-recomputation regression test (FR-002 / SC-001, #1155):
  the fixture (`FIXTURE_MODE=write`) emits a candidate claiming top-level `verdict: clean` while
  carrying one `open` `critical` finding; assert the engine recomputes `changes-required` and the
  loop acts on the recomputed verdict (drives the remediate/off-sequence path, not the ready
  path). Assert against the engine-authoritative artifact
  (`review-findings-<sanitized>.json`), never the candidate's claim.

- [ ] T011 [US1] Add the severity-gating boundary tests (FR-003) exercising the composed loop at
  `blockingSeverity` edges per the `data-model.md` truth table: all `open:minor` + `major` →
  `clean`; one `open:critical` + `major` → `changes-required`; one `open:major` + `critical` →
  `clean`; one `open:critical` + `critical` → `changes-required`; one `resolved:critical` +
  `critical` → `clean`. Verdict must flow through the executor + `computeVerdict`, not by calling
  `computeVerdict` directly.

- [ ] T012 [US1] Add the finding-status lifecycle tests across rounds (FR-004, #1161): an `open`
  finding at round 1 the agent marks `resolved` is carried over as `resolved` at round 2 (engine
  merge); a sub-blocking finding is dropped at round ≥ 2 (finding-id match). Drive round 2 by a
  second fixture-written candidate through the composed loop.

- [ ] T013 [US1] Add the three executor failure-path tests, each with a distinct asserted loop
  outcome (FR-005 / SC-004): (a) **missing sidecar** — `FIXTURE_MODE=withhold`, real spawn exits
  0, `readCandidateFindings` returns `null`, no-verdict round (never `clean`), executor persists
  nothing; (b) **timeout** — NOT the fixture: inject a mocked/hanging `ChildProcessHandle`
  (EventEmitter-style, per `phase-loop.remediate-timeout.integration.test.ts`) with
  hand-constructed `phaseTimeoutMs: 20` + `shutdownGracePeriodMs: 10`, assert SIGTERM→SIGKILL and
  `success:false`; (c) **non-zero exit** — inject a handle whose `exitPromise` resolves non-zero,
  assert the failure gate persists nothing. Depends on T010 (harness scenario wiring proven).

---

## Phase 3: US3 — re-point clean-cycle / draft-ready at real executor + real poster

<!-- Phase boundary: Phase 2 must complete before starting Phase 3 (reuses the T001/T002/T003 substrate). -->

- [ ] T020 [US3] Re-point `packages/orchestrator/src/worker/__tests__/phase-loop.review-clean.integration.test.ts`
  (FR-008): remove the findings-steering lever (injected `readFindingsArtifact` / verdict stub);
  wire the real `ReviewExecutor` (spawned via the T002 double + T001 fixture) and the real
  `ReviewPoster` (`new ReviewPoster({ github: <recording fake>, owner, repo, getPrNumber, logger })`)
  into `PhaseLoopDeps`. Keep the recording-fake `GitHubClient` assertions.

- [ ] T021 [US3] Under the real composition, assert a clean review cycle posts **exactly one**
  COMMENT-event review via the real poster and flips the PR ready-for-review, driven by a real
  `ReviewExecutor` verdict; and a `changes-required` cycle converts the PR to draft when the
  engine previously marked it ready. Inspect the recorded `createReview` / ready / draft calls on
  the fake `GitHubClient`. Confirm no coverage is lost versus the prior double-based assertions.
  Depends on T020.

---

## Phase 4: US2 — verify/extend gate resume through the real label path

<!-- Phase boundary: independent of Phase 2/3 substrate, but grouped after per plan ordering. May proceed in parallel with Phases 2–3 if desired (different file, no shared deps). -->

- [ ] T030 [P] [US2] Verify `packages/orchestrator/src/worker/__tests__/phase-loop.resume-gates.integration.test.ts`
  already drives the **real** `LabelManager.onResumeStart` over a label-backed fake
  `GitHubClient` for the `remediation-limit` reset/re-arm and the terminal-no-op resume
  (FR-006/FR-007, clarification Q3→A). Confirm it does NOT pre-inject surviving labels into the
  mocked issue response and that deleting the #1154 `isHumanGateCompletion` guard makes it fail
  (SC-003).

- [ ] T031 [P] [US2] Extend that suite so the `completed:remediation-limit` label is applied via
  the label monitor's **exact mutation shape** (not a bare `Set.add`), and assert: the human-gate
  `completed:*` label survives the `onResumeStart` strip, the remediation counter resets, the loop
  re-arms (FR-006, #1154 regression); and the post-validate `implementation-review` /
  `on-ci-green` terminal-no-op resume engages when both `completed:validate` and
  `completed:implementation-review` are present after the real resume (FR-007). Depends on T030.

---

## Phase 5: FR-009 — repurpose the #1132 convergence/cap suites as charter-contract tests

<!-- Phase boundary: independent; may run in parallel with Phases 2–4 (different files). -->

- [ ] T040 [P] [US1] Reframe
  `packages/orchestrator/src/worker/__tests__/phase-loop.review-remediate-convergence.integration.test.ts`
  as a **charter-contract** test (FR-009): assert the prompt/charter shape and the merge contract
  (`advanceArtifact` finding carry-over / sub-blocking drop), NOT loop composition (US1 now owns
  real composed-loop coverage). Keep the coverage; do not delete or rewrite beyond this reframing.

- [ ] T041 [P] [US1] Reframe
  `packages/orchestrator/src/worker/__tests__/phase-loop.remediation-cap.integration.test.ts`
  as a **charter-contract** test (FR-009) using the same approach as T040. Keep the coverage; do
  not delete or rewrite beyond the reframing.

---

## Phase 6: Verification — green + CI budget

<!-- Phase boundary: all prior phases complete. -->

- [ ] T050 [US1] Confirm the SC-002 verification: grep
  `phase-loop.review-composed.integration.test.ts` for direct `new ReviewExecutor(` wired into
  `PhaseLoopDeps.reviewExecutor` with the real-spawn double, and confirm **no** `readFindingsArtifact`
  verdict-steering seam is present (`rg "readFindingsArtifact"` → no match in the composed suite).

- [ ] T051 [US1] Run `pnpm --filter @generacy-ai/orchestrator test` and confirm all suites are
  green (SC-005), including the retained "keep" coverage (`review-executor.test.ts`,
  `remediate-executor.test.ts`, cap-gate label-pair tests, repurposed convergence suites), and
  that the new suites introduce no CI wall-clock regression (SC-006). Confirm no changeset was
  added (test-only) and `git diff --stat` shows only files under
  `packages/orchestrator/src/worker/__tests__/`.

---

## Dependencies & Execution Order

**Sequential phase boundaries:**
- Phase 1 (foundation) → Phase 2 (US1 composed suite) → Phase 3 (US3 re-point). Phases 2 and 3
  both consume the T001/T002/T003 substrate, so they follow Phase 1.
- Phase 6 (verification) is last.

**Parallel opportunities:**
- **Within Phase 1**: T001 and T002 are independent files — run in parallel `[P]`. T003 depends
  on both.
- **Phase 4 (US2)** and **Phase 5 (FR-009)** touch different files from the US1/US3 substrate and
  have no dependency on Phases 1–3; they may run in parallel with Phases 2–3 and with each other.
  Within them, T030→T031 and T040 ∥ T041 (`[P]`).
- **Within Phase 2**: T010, T011, T012 share the composed suite file (sequential); T013 depends
  on T010's proven scenario wiring.

**Dependency-issue note:** #1161 (sub-blocking drop), #1156 (poster wiring), #1154 (resume
label-strip) are assumed merged to `develop`. If any is not on the branch base at implement time,
defer the dependent criterion (T012 sub-blocking drop; T020/T021 poster re-point; T031 #1154
resume) rather than reworking — the fixture/double/harness (T001–T003) are dependency-agnostic.

---

## Summary

- **Total tasks**: 12 (T001–T003, T010–T013, T020–T021, T030–T031, T040–T041, T050–T051).
- **Phase breakdown**: Foundation (3), US1 composed suite (4), US3 re-point (2), US2 gate-resume
  (2), FR-009 repurpose (2), Verification (2).
- **Parallel opportunities**: T001 ∥ T002; Phase 4 ∥ Phase 5 ∥ Phases 2–3; T040 ∥ T041; T030 ∥ T031-precursor.
- **Mode**: Standard (fine-grained).
- **Changeset**: none (test-only, gate-exempt).

**Next step**: `/speckit:implement` to begin execution.
