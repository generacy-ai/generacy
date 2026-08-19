# Tasks: Review phase executor — structured findings artifact + engine-internal verdict

**Input**: Design documents from `/specs/1124-context-new-review-phase/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Artifact + verdict core

- [ ] T001 [US1] Create `packages/orchestrator/src/worker/review-artifact.ts` — the persisted sidecar module.
  - Define `ReviewFinding` / `ReviewArtifact` TS interfaces + `ReviewFindingSchema` / `ReviewArtifactSchema` Zod schemas per data-model.md (FR-006). `Severity` = `critical|major|minor`, `FindingStatus` = `open|resolved`, `verdict` = `clean|changes-required`, `round` positive int, `lastReviewedCommitSha` non-empty string.
  - `getReviewArtifactPath(checkoutPath, workflowId)` → `<checkoutPath>/.generacy/review-findings-<sanitizedWorkflowId>.json`; `sanitizeWorkflowId(id)` = `id.replace(/[^a-zA-Z0-9_-]/g, '_')` (identical to `worker/pause-context.ts`).
  - `getReviewArtifactRelPath(workflowId)` → `.generacy/review-findings-<sanitizedWorkflowId>.json` (must resolve against `checkoutPath` to equal the absolute path).
  - `writeReviewArtifact(checkoutPath, workflowId, artifact)` — `mkdir -p` the `.generacy` dir, write `<path>.tmp`, `rename` to `<path>` (atomic), overwrite unconditionally. Async.
  - `readReviewArtifact` (async) + `readReviewArtifactSync` (sync, `fs.readFileSync` + Zod for the sync `remediateTrigger` seam) — both return `null` on missing / unreadable / invalid JSON / schema-invalid; NEVER throw.
  - `clearReviewArtifact` — idempotent `unlink`, swallow `ENOENT`.
- [ ] T002 [US1] Add `computeVerdict(findings, blockingSeverity)` to `review-artifact.ts` (FR-007). `SEVERITY_RANK = { critical: 3, major: 2, minor: 1 }`; returns `changes-required` iff ≥1 finding with `status === 'open'` AND `SEVERITY_RANK[severity] >= SEVERITY_RANK[blockingSeverity]`; else `clean`. Pure, total over the closed enum.
- [ ] T003 [P] [US1] Create `packages/orchestrator/src/worker/__tests__/review-artifact.test.ts`.
  - SC-001: round-trip a valid `ReviewArtifact` through write→read; assert malformed JSON, missing file, and schema-invalid content each return `null` (async and sync readers).
  - Assert `getReviewArtifactRelPath` resolved against `checkoutPath` equals `getReviewArtifactPath` (agent + engine target same file).
  - SC-002: verdict-gating matrix — replicate every row of the data-model.md severity/verdict truth table (10 rows incl. `resolved` findings excluded, empty findings → `clean`).

## Phase 2: Charter

- [ ] T004 [US1] Create `packages/orchestrator/src/worker/review-charter.ts` — `buildReviewCharter({ profile, sidecarRelPath, blockingSeverity, round })` pure string builder (FR-002/003/004/005).
  - Selects `standard` vs `verification` body by `profile`; `verification` additionally instructs emitting "needs verification" findings for `validate` to confirm.
  - Directs a correctness/regression review of the PR diff; **explicitly forbids running tests or builds** (FR-003).
  - Instructs flagging an implausibly empty/trivial diff as a finding at/above `blockingSeverity` (FR-004 → US3).
  - Names `sidecarRelPath` as the write target and describes the `ReviewFinding[]` shape (FR-005). No I/O, deterministic.
- [ ] T005 [P] [US1] Create `packages/orchestrator/src/worker/__tests__/review-charter.test.ts` — assert the returned string: contains an explicit tests/builds prohibition (FR-003); instructs empty/trivial-diff flagging (FR-004); names `sidecarRelPath` + describes the finding shape (FR-005); `verification` output adds "needs verification" instructions while `standard` does not.

## Phase 3: Launch intent
<!-- Depends on nothing in Phases 1-2; can run in parallel with them, but must precede the executor (Phase 4). -->

- [ ] T006 [US1] Add `ReviewIntent { kind: 'review'; issueNumber: number; prompt: string; provider?: string; model?: string; effort?: string }` to `packages/orchestrator/src/launcher/types.ts` and add it to the `LaunchIntent` union (mirror `MergeConflictIntent`).
- [ ] T007 [P] [US1] Mirror the `ReviewIntent` interface + union member in `packages/generacy-plugin-claude-code/src/launch/types.ts`.
- [ ] T008 [US1] Wire the plugin in `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`: add `'review'` to `supportedKinds`, add `case 'review' → buildReviewLaunch(intent)`, and implement `buildReviewLaunch(intent)` byte-for-byte mirroring `buildMergeConflictLaunch` (`claude -p --output-format stream-json --dangerously-skip-permissions --verbose [--model …] [--effort …] <prompt>`).

## Phase 4: Executor

- [ ] T009 [US1] Create `packages/orchestrator/src/worker/review-executor.ts` — `ReviewExecutor` class, ctor `{ agentLauncher, settings, logger }`, `async execute(context, deps): Promise<PhaseResult>` following the contract sequence:
  1. Resolve `review.profile`, `review.blockingSeverity`, `maxRemediations` from settings + workflow (`resolveWorkflowOverrides`).
  2. `readReviewArtifact` → `priorRound`; `round = (priorRound?.round ?? 0) + 1`.
  3. `buildReviewCharter({ profile, sidecarRelPath: getReviewArtifactRelPath(workflowId), blockingSeverity, round })`.
  4. Resolve provider/model/effort via `resolveAgentForPhase(config, workflow, 'implement')`.
  5. `agentLauncher.launch({ intent: { kind: 'review', issueNumber, prompt: charter, provider, model, effort }, cwd: checkoutPath, env: {}, credentials: buildLaunchCredentials(credentialRole) })` — direct `launch()`, NOT `cli-spawner.spawnPhase` (which excludes `review`).
  6. Manage the child: `OutputCapture` + SIGTERM→grace→SIGKILL timeout (mirror `pr-feedback-handler.ts:700-985`).
  7. Read the agent-written candidate sidecar; extract + Zod-validate `findings` (tolerate a looser candidate `verdict`/`round`).
  8. `verdict = computeVerdict(findings, blockingSeverity)` — **ignore any agent-claimed verdict** (FR-005/FR-007).
  9. `lastReviewedCommitSha = getCurrentCommitSha(checkoutPath)`.
  10. `writeReviewArtifact({ findings, verdict, round, lastReviewedCommitSha })`.
  11. Return `{ phase: 'review', success: true, exitCode: 0, durationMs, output }`.
- [ ] T010 [P] [US1] Create `packages/orchestrator/src/worker/__tests__/review-executor.test.ts`.
  - SC-003: assert NO validate/build process is spawned during `review` — the only spawn is the `review` intent; the `cli-spawner` validate path is never invoked.
  - Assert GitHub review APIs (`gh pr review`, `/pulls/*/reviews`) are NEVER called.
  - SC-004 (executor slice): the persisted `verdict` equals `computeVerdict(...)` regardless of what the candidate file claimed (recompute-ignores-agent-verdict).

## Phase 5: Phase-loop wiring
<!-- Phase boundary: T009 (executor) and T006-T008 (intent) must exist before wiring. -->

- [ ] T011 [US2] Modify `packages/orchestrator/src/worker/config.ts`: add `'on-remediation-limit'` to `GateDefinitionSchema.condition` enum, and add a default review gate for `speckit-feature` / `speckit-bugfix` (phase `review`, gateLabel `remediation-limit`, condition `on-remediation-limit`).
- [ ] T012 [US2] Modify `packages/orchestrator/src/worker/phase-loop.ts`:
  - Swap the `phase === 'review'` branch (~line 473) to `result = deps.reviewExecutor ? await deps.reviewExecutor.execute(context, deps) : this.runStubPhase('review')`; `phase === 'remediate'` stays `runStubPhase('remediate')`.
  - Add `PhaseLoopDeps.reviewExecutor?: ReviewExecutor` and `PhaseLoopDeps.settings?: OrchestratorSettings` (or resolved review config).
  - Add gate evaluation for the new `'on-remediation-limit'` condition in the gate block (`:1020-1124`, BEFORE the remediate seam at `:1157`): fires when `readReviewArtifactSync(...).round >= maxRemediations` → `onGateHit(waiting-for:remediation-limit)` → pause with `agent:paused` (FR-011). Leave the `:1157` seam line unchanged.
- [ ] T013 [US2] Modify `packages/orchestrator/src/worker/claude-cli-worker.ts`: resolve review config once via `resolveWorkflowOverrides(config, settings, workflowName)`; construct `new ReviewExecutor({ agentLauncher, settings, logger })`; inject `reviewExecutor`, `settings`, and `remediateTrigger = (context) => readReviewArtifactSync(context.checkoutPath, context.workflowId)?.verdict === 'changes-required'` into `PhaseLoopDeps`.
- [ ] T014 [P] [US2] Create `packages/orchestrator/src/worker/__tests__/phase-loop.review.test.ts` — integration:
  - US2: `verdict: clean` → loop continues toward `validate`; `verdict: changes-required` → `remediateTrigger` returns `true` → stub `remediate` runs → `review` re-entered.
  - FR-011: when `round` reaches `maxRemediations`, the `on-remediation-limit` gate fires and the workflow pauses (`waiting-for:remediation-limit` + `agent:paused`) rather than looping forever.
  - SC-005: with `reviewPhaseEnabled=false`, `review` is absent from the effective sequence and behavior is byte-identical (extend/reuse #1121's byte-identity assertion).

## Phase 6: Labels, resume, changeset

- [ ] T015 [P] [US2] Add `{ name: 'waiting-for:remediation-limit', color: 'FBCA04', description: 'Review↔remediate cap reached; awaiting operator' }` to `packages/workflow-engine/src/actions/github/label-definitions.ts` (matches the `waiting-for:implementation-review` review-gate color family).
- [ ] T016 [P] [US2] If required for `/cockpit:resume` re-entry, add `remediation-limit → review` to `GATE_MAPPING` in `packages/orchestrator/src/worker/phase-resolver.ts` so a paused `waiting-for:remediation-limit` issue resumes into `review`.
- [ ] T017 [US1] Hand-write `.changeset/1124-review-phase-executor.md` (NEWLY-ADDED file — required by the CLAUDE.md changeset gate):
  - `@generacy-ai/workflow-engine`: **minor** (new `waiting-for:remediation-limit` label vocabulary).
  - `@generacy-ai/generacy-plugin-claude-code`: **minor** (new `review` launch intent kind).
  - `@generacy-ai/orchestrator`: **patch** (internal plumbing, no new public exports).

## Dependencies & Execution Order

**Sequential dependencies**:
- T002 depends on T001 (same file, `computeVerdict` uses the schema types).
- T003 depends on T001+T002 (tests the module).
- T005 depends on T004.
- T008 depends on T006+T007 (plugin consumes the mirrored intent).
- T009 (executor) depends on T001/T002 (artifact + verdict) and T006-T008 (launch intent).
- T010 depends on T009.
- T012 depends on T009 (executor injected) and T011 (gate condition enum).
- T013 depends on T009 + T001 (readReviewArtifactSync) + T011.
- T014 depends on T011-T013.
- T017 must land in the same PR as the `src/` changes (changeset gate).

**Parallel opportunities**:
- Phase 1 (T001→T002→T003), Phase 2 (T004→T005), and Phase 3 (T006→T007→T008) are independent tracks and can proceed concurrently.
- `[P]` test tasks (T003, T005, T010, T014) and label tasks (T015, T016) touch distinct files from their siblings.

**Critical path**: T001 → T002 → T009 → T012 → T013 → T014.

## Next Step

Run `/speckit:implement` to begin execution.
