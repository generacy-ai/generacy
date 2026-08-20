# Tasks: Merge readiness — CI skipped≠passed, validate/CI parallel semantics, post-validate approval gate

**Input**: Design documents from `/specs/1133-context-repo-ci-yml/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup — shared types (workflow-engine)

- [ ] T001 [US1] Add `CiConclusion`, `CiRun`, `CiVerdict` types to
  `packages/workflow-engine/src/types/github.ts` per data-model.md
  (`CiConclusion` includes `null` for in-progress; `CiRun = { status: string; conclusion: CiConclusion }`;
  `CiVerdict = 'green' | 'pending' | 'not-passed'`). These are the foundation for all US1 work.

## Phase 2: US1 — CI-aware readout & three-state verdict (P1)

<!-- Skipped≠passed rule + check-runs primary / actions-runs fallback readout -->

- [ ] T002 [US1] Implement pure `aggregateCiVerdict(runs: CiRun[]): CiVerdict` in NEW file
  `packages/workflow-engine/src/actions/github/client/ci-verdict.ts`.
  Ignore-set `{skipped, neutral}`; precedence per contracts/ci-verdict.md:
  (1) any `failure|cancelled|timed_out|action_required` → `not-passed`,
  (2) any in-progress (`status !== 'completed'` or `conclusion === null`) → `pending`,
  (3) any `success` → `green`, (4) else `pending`. Zero I/O, total, never throws.
  Unknown terminal conclusions treated conservatively (not `success`).
- [ ] T003 [P] [US1] Unit test `packages/workflow-engine/src/actions/github/client/__tests__/ci-verdict.test.ts`
  covering the full truth table in contracts/ci-verdict.md (empty→pending, all-skipped→pending,
  `[success]`→green, `[success,skipped]`→green, `[failure]`→not-passed, `[success,failure]`→not-passed,
  `[null]`→pending, `[success,null]`→pending, `[failure,null]`→not-passed). Encodes SC-001.
- [ ] T004 [US1] Add `getCiRunsForSha(owner, repo, headSha, branch): Promise<{ runs: CiRun[]; source: 'check-runs' | 'actions-runs' }>`
  to the `GitHubClient` interface in
  `packages/workflow-engine/src/actions/github/client/interface.ts` (depends on T001).
- [ ] T005 [US1] Implement `getCiRunsForSha` in
  `packages/workflow-engine/src/actions/github/client/gh-cli.ts` per contracts/gh-cli-ci-readout.md.
  Primary: `gh api repos/{o}/{r}/commits/{headSha}/check-runs --jq '.check_runs[] | {status, conclusion}'`
  → `source: 'check-runs'`. Fallback on non-zero exit:
  `gh api "repos/{o}/{r}/actions/runs?branch={branch}&per_page=100" --jq '.workflow_runs[] | {head_sha, status, conclusion}'`
  filtered to `head_sha === headSha` → `source: 'actions-runs'`. Normalize both to `CiRun`.
  Non-zero exit on BOTH paths → throw with stderr (mirror `getRefHeadSha` at `gh-cli.ts:1637`).
  (Depends on T004.)
- [ ] T006 [P] [US1] Unit test `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli.ci-readout.test.ts`:
  primary check-runs path and actions/runs fallback yield an **identical** verdict for the same real CI
  state (SC-004); fallback triggered on non-zero primary exit; empty result → `runs: []`
  → aggregation yields `pending`; both-paths-fail → throws.

**Checkpoint**: US1 delivers an independently testable skipped≠passed verdict + dual-path readout.

## Phase 3: US2 — parallel validate + CI readiness with bounded backoff (P1)

<!-- Depends on Phase 2 (verdict + readout) -->

- [ ] T007 [US2] Create NEW file `packages/orchestrator/src/worker/ci-merge-readiness.ts`:
  `CiReadiness { verdict; runCount; source }`, `CiWaitOutcome = { kind: 'green' | 'not-passed' | 'timeout' }`.
  `evaluateCiReadiness({ github, owner, repo, headSha, branch })` calls `getCiRunsForSha` and maps through
  `aggregateCiVerdict`. `waitForCiGreen(..., ciWaitTimeoutMs)` polls with exponential backoff
  (5s→10s→20s→cap 30s) until `green`/`not-passed` or elapsed ≥ `ciWaitTimeoutMs` → `timeout`.
  A thrown readout is transient → continue backoff. Never declares green on pending (Q1-C/Q3-A/FR-004).
- [ ] T008 [P] [US2] Unit test `packages/orchestrator/src/worker/__tests__/ci-merge-readiness.test.ts`:
  bounded backoff (no busy loop, SC-005), pending→timeout outcome, green short-circuit,
  not-passed outcome, thrown-readout-then-recover continues backoff.

**Checkpoint**: US2 delivers the readiness evaluator + no-busy-loop wait, consumable by phase-loop.

## Phase 4: US3 — flag, config, gate relocation, resolver & phase-loop (P1)

<!-- Depends on Phase 3 (readiness) — this phase wires it into the worker -->

- [ ] T009 [US3] Add `waiting-for:ci` (color `FBCA04`) and `completed:ci` (color `0E8A16`) to
  `packages/workflow-engine/src/actions/github/label-definitions.ts` per contracts/labels.md.
- [ ] T010 [US3] In `packages/orchestrator/src/worker/config.ts`:
  add `ciMergeGateEnabled: z.boolean().default(false)` and
  `ciWaitTimeoutMs: z.number().int().min(30_000).default(900_000)` to `WorkerConfigSchema`
  (per-workflow-overridable, mirror `phaseTimeoutMs`); add `'on-ci-green'` to
  `GateDefinitionSchema.condition` enum; make the default `implementation-review` gate placement
  flag-conditional (ON → `{ phase: 'validate', condition: 'on-ci-green' }`;
  OFF → today's `{ phase: 'implement', condition: 'always' }` feature /
  `{ ... condition: 'on-request' }` bugfix — byte-identical). See contracts/gate-and-flag.md.
- [ ] T011 [US3] In `packages/orchestrator/src/config/loader.ts` read `WORKER_CI_MERGE_GATE_ENABLED`
  (+ prefixed variant, coerce `'true'`/`'1'`) and `WORKER_CI_WAIT_TIMEOUT_MS` (parse int),
  mirroring the `reviewPhaseEnabled` env-read precedent at `loader.ts:241-249`.
- [ ] T012 [US3] In `packages/orchestrator/src/worker/phase-resolver.ts` thread `ciMergeGateEnabled`
  through `resolveStartPhase` → `resolveFromContinue`/`resolveFromProcess` → `getEffectiveGateMapping`.
  Make `GATE_MAPPING['implementation-review']` flag-conditional:
  OFF → `{ phase: 'implement', resumeFrom: 'validate' }` (byte-identical, `phase-resolver.ts:9-17`);
  ON → `{ phase: 'validate', resumeFrom: <terminal no-op> }` per research Decision 5. Keep
  `speckit-feature`/`speckit-bugfix` consistent.
- [ ] T013 [P] [US3] Resolver test `packages/orchestrator/src/worker/__tests__/phase-resolver.ci-merge.test.ts`:
  flag ON → `implementation-review` on `validate` + terminal resume (neither `validate` nor `implement`
  re-runs); flag OFF → mapping unchanged (SC-006).
- [ ] T014 [US3] In `packages/orchestrator/src/worker/phase-loop.ts` (flag-gated):
  fold CI readiness/wait into `validate` completion — after `validate` succeeds and the PR is
  ready-for-review (reuse `markReadyForReview`, `phase-loop.ts:1419`), run `evaluateCiReadiness`/`waitForCiGreen`;
  `green` → allow the `on-ci-green` gate to fire; `not-passed` → readiness blocked, gate NOT raised;
  `timeout` → pause with `waiting-for:ci` + `agent:paused` (short-circuit before gate loop).
  Add `on-ci-green` gate-condition evaluation, and the terminal no-op short-circuit at loop entry
  (`{ completed: true }` when re-entering at `validate` on a `continue` carrying both
  `completed:validate` and `completed:implementation-review`) per research Decision 5.
- [ ] T015 [US3] In `packages/orchestrator/src/worker/claude-cli-worker.ts` pass
  `this.config.ciMergeGateEnabled` into `phaseResolver.resolveStartPhase(...)`.
- [ ] T016 [P] [US3] Integration test
  `packages/orchestrator/src/worker/__tests__/phase-loop.ci-merge-gate.test.ts`:
  skipped-CI + green validate → readiness blocked, `implementation-review` NOT raised (SC-001);
  green CI + green validate → gate raised (SC-002); satisfying the gate yields a merge-eligible state
  (`completed:validate` + gate answer) cockpit can read (SC-003); flag OFF → byte-identical run (SC-006).

**Checkpoint**: US3 wires readiness into the worker; merge readiness now requires validate AND CI green.

## Phase 5: US4 — target-repo migration docs (P2)

- [ ] T017 [P] [US4] Add a migration note (in `specs/1133-context-repo-ci-yml/quickstart.md` and/or the
  PR description / repo docs) stating: target repos must add `ready_for_review` to their
  `pull_request` trigger `types` in `ci.yml` (else CI never runs on the draft→ready flip), and document
  the readiness contract (validate AND CI green) plus the skipped≠passed rule (FR-008).

## Phase 6: Verification & Polish

- [ ] T018 Add changeset `.changeset/1133-ci-merge-gate.md`:
  `@generacy-ai/workflow-engine` **minor** (new public `getCiRunsForSha` client method + new
  `waiting-for:ci`/`completed:ci` label vocabulary) and `@generacy-ai/orchestrator` **patch**
  (internal flag/phase-loop/resolver wiring, no new public exports). NEWLY ADDED file (CI gate).
- [ ] T019 Run `pnpm -w build`, `pnpm -w lint`, and the touched packages' `vitest` suites
  (workflow-engine + orchestrator). Confirm SC-001…SC-006 assertions pass and the flag-OFF path
  is byte-identical (SC-006).

## Dependencies & Execution Order

**Sequential phase boundaries**:
- Phase 1 (T001 types) → Phase 2 (US1) → Phase 3 (US2) → Phase 4 (US3) → Phase 6.
- Phase 5 (US4 docs) is independent and can be done any time after Phase 1 (marked [P]-friendly).

**Within-task dependencies**:
- T001 blocks T002, T004, T005 (types).
- T004 (interface) blocks T005 (impl).
- T002 + T005 block T007 (readiness consumes verdict + readout).
- T007 blocks T014 (phase-loop consumes readiness).
- T010 + T011 + T012 block T014/T015 (config/flag/resolver wiring precedes phase-loop consumption).
- T018 (changeset) and T019 (verify) last.

**Parallel opportunities** (different files, no shared deps):
- T003 ∥ T006 (US1 tests) once their sources exist.
- T008 (US2 test) alongside other US2-independent work.
- T013 ∥ T016 (resolver test ∥ phase-loop integration test) once sources exist.
- T017 (docs) parallel with any code phase.

**Suggested next step**: `/speckit:implement` to begin execution.
