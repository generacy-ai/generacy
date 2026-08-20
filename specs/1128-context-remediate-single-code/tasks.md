# Tasks: Remediate phase executor — remediation counter + remediation-limit gate

**Input**: Design documents from `/specs/1128-context-remediate-single-code/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/remediate-executor.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Foundational (blocking prerequisites)

These build the shared surfaces every user story depends on: the sidecar counter, the launch intent, and the label vocabulary. Complete this phase before Phase 2.

- [X] T001 [P] [US2] Add `remediationCount: z.number().int().nonnegative().default(0)` to `ReviewArtifactSchema` in `packages/orchestrator/src/worker/review-artifact.ts`. `.default(0)` is load-bearing so pre-#1128 #1124 artifacts (no field) still parse via `readReviewArtifact` rather than returning `null`. Leave `round` as `z.number().int().positive()` and monotonic — do NOT touch it. (data-model.md §Zod change)
- [X] T002 [US2] Add helpers `bumpRemediationCount(checkoutPath, workflowId): Promise<number>` (read → +1 → atomic write, returns new count; no-op returns 0 if artifact missing) and `resetRemediationCount(checkoutPath, workflowId): Promise<void>` (read → set 0 → atomic write; no-op if missing) to `packages/orchestrator/src/worker/review-artifact.ts`. Reuse `readReviewArtifact` (null-safe) + `writeReviewArtifact` (temp+rename). Depends on T001.
- [X] T003 [P] [US1] Add `RemediateIntent { kind: 'remediate'; issueNumber: number; prompt: string; provider?: string; model?: string; effort?: Effort }` to `packages/generacy-plugin-claude-code/src/launch/types.ts` (mirror `ReviewIntent`), add it to the `ClaudeCodeIntent` union, and export it from `packages/generacy-plugin-claude-code/src/launch/index.ts`. (data-model.md §RemediateIntent, research.md Decision 9)
- [X] T004 [US1] In `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`: add `'remediate'` to `supportedKinds`, add a `case 'remediate': return this.buildRemediateLaunch(intent)` branch, and add `buildRemediateLaunch` byte-identical to `buildReviewLaunch`. Depends on T003.
- [X] T005 [P] [US2] Add `{ name: 'completed:remediation-limit', color: '0E8A16', description: 'Remediation-limit gate satisfied by operator' }` alongside the other `completed:*` entries in `packages/workflow-engine/src/actions/github/label-definitions.ts` so the monitor/cockpit recognize it and `ensureRepoLabelsExist` creates it. (research.md Decision 10)

## Phase 2: US1 — Engine-driven code remediation (P1)

Real executor + charter, wired into the off-sequence seam.

- [X] T006 [P] [US1] Create `packages/orchestrator/src/worker/remediate-charter.ts` — pure `buildRemediateCharter({ findings, round, remediationCount, blockingSeverity }): string`, no I/O. Structure: (1) title + attempt/round context; (2) "Findings to address" — one block per open blocking finding (`severity`, `file[:line]`, `title`, `detail`); (3) instruction to make the code changes but NOT resolve review threads and NOT mark the PR ready (verification happens next review round); (4) leave the structure so a future "Validate failures to fix" section (#1129) can be appended without restructuring. (data-model.md §RemediateCharterInput, research.md Decision 2)
- [X] T007 [US1] Create `packages/orchestrator/src/worker/remediate-executor.ts` — `RemediateExecutor` class (ctor deps `{ agentLauncher, config, settings, logger }`; `execute(context): Promise<PhaseResult>`) mirroring `review-executor.ts`. Behavior: resolve `{ maxRemediations, review: { blockingSeverity, profile } }` via `resolveWorkflowOverrides`; `readReviewArtifact` and filter to open blocking findings (`status==='open' && rank(severity) >= rank(blockingSeverity)`); `buildRemediateCharter(...)`; resolve agent via `resolveAgentForPhase(config, workflowName, 'implement')` and timeout via `resolvePhaseTimeoutMs(config, 'remediate')`; spawn via `agentLauncher.launch({ intent: { kind: 'remediate', ... }, cwd: checkoutPath, env: {}, credentials: buildLaunchCredentials(config.credentialRole), provider })`; manage child with `OutputCapture` + `setTimeout` SIGTERM→grace→SIGKILL; return `{ phase: 'remediate', success, exitCode, durationMs, output }`. **Increment `remediationCount` by exactly one on EVERY return path** (normal exit, timeout, spawn-failure catch) via `bumpRemediationCount`. MUST NOT resolve threads, mark ready, write GitHub review state, or touch `round`/`verdict`. Depends on T002, T004, T006. (contracts/remediate-executor.md)
- [X] T008 [US1] In `packages/orchestrator/src/worker/phase-loop.ts`, replace `runStubPhase('remediate')` at the off-sequence seam (~`:1277`) with: `onPhaseStart('remediate')` → `deps.remediateExecutor?.execute(context) ?? runStubPhase('remediate')` → `prManager.commitPushAndEnsurePr('remediate')` (FR-003) → honor #1051 `pushRefused` abort (`return { results, completed: false, lastPhase: 'remediate', gateHit: false }`) → set `context.prUrl` if returned → `onPhaseComplete('remediate')` → push result → `reviewRound++` → `i--; continue;` (FR-012 backtrack to review). Depends on T007. (contracts/remediate-executor.md §Seam integration)
- [X] T009 [US1] In `packages/orchestrator/src/worker/claude-cli-worker.ts`, construct `RemediateExecutor` alongside `ReviewExecutor` and inject it as `remediateExecutor` into `PhaseLoopDeps` (the `remediateTrigger` seam from #1124 already reads the sidecar verdict). Depends on T007.

## Phase 3: US2 — Bounded loop via remediation counter + cap gate (P1)

Re-key the existing `on-remediation-limit` gate onto the counter and enrich the gate body.

- [X] T010 [US2] In `packages/orchestrator/src/worker/phase-loop.ts` `on-remediation-limit` branch (~`:1138-1141`), change the gate predicate from `artifact.round >= maxRemediations` to `artifact.remediationCount >= maxRemediations`, keeping `artifact !== null` and `&& artifact.verdict === 'changes-required'` (Q5=A conjunct so a clean review on the cap round proceeds to `validate`). `maxRemediations` comes from `resolveWorkflowOverrides(config, deps.settings, workflowName)` (feature 3, bugfix 2). Depends on T001, T008. (contracts §Gate re-key, research.md Decision 6)
- [X] T011 [US2] In the same `on-remediation-limit` branch, before pausing/returning `gateHit: true`, post the gate body (FR-008) via `context.github.addIssueComment(owner, repo, issueNumber, body)` listing each `status:'open'` finding as `- <file>[:<line>] — <title>` plus an "Add `completed:remediation-limit` to resume with a fresh remediation budget." line. Wrap in try/catch (best-effort; a comment failure must not fail the pause). Assert no `blocked:*` label is applied anywhere in this path (SC-005). Depends on T010. (contracts §Gate body, research.md Decision 8)

## Phase 4: US3 — Operator resume resets the counter (P1)

- [X] T012 [US3] In `packages/orchestrator/src/worker/phase-loop.ts` gate-satisfaction check (~`:1163`), for the `remediation-limit` gate only when `completedLabel === 'completed:remediation-limit'` is present: `await resetRemediationCount(context.checkoutPath, workflowId)` then `await context.github.removeLabels(owner, repo, issueNumber, ['completed:remediation-limit'])` so the gate re-arms, before `continue`. Other gates keep today's plain `continue`. Verify `GATE_MAPPING['remediation-limit'] = { phase: 'review', resumeFrom: 'review' }` in `packages/orchestrator/src/worker/phase-resolver.ts` stays UNCHANGED (FR-010). Depends on T002, T010. (contracts §Gate satisfaction reset, research.md Decision 7)

## Phase 5: Tests

- [X] T013 [P] [US2] Create `packages/orchestrator/src/worker/__tests__/review-artifact.remediation-count.test.ts` — bump increments by 1, reset sets to 0, back-compat parse of a #1124 artifact missing the field (defaults to 0), `round`/`lastReviewedCommitSha` untouched across bump and reset. (SC-001, SC-003; INV-3)
- [X] T014 [P] [US1] Create `packages/orchestrator/src/worker/__tests__/remediate-charter.test.ts` — prompt shape: findings-only "Findings to address" section renders `severity`/`file[:line]`/`title`/`detail`; instruction forbids thread-resolve and ready-mark; structure leaves room for a future validate-evidence section.
- [X] T015 [P] [US1] Create `packages/orchestrator/src/worker/__tests__/remediate-executor.test.ts` — SC-001 exactly-one increment over N findings; increment-on-timeout (INV-2); no thread-resolve / no ready-mark / no review-state call (INV-4/FR-004/SC-005); `round` unchanged (INV-3).
- [X] T016 [P] [US2] Create `packages/orchestrator/src/worker/__tests__/phase-loop.remediate.test.ts` — SC-002 cap raises `waiting-for:remediation-limit` + `agent:paused` with open findings remaining; SC-003 `completed:remediation-limit` resets counter and re-arms gate; SC-004 `review(changes-required) → remediate → re-review → clean → validate` converges within cap; SC-005 no `blocked:*` label anywhere in the path.
- [X] T017 [P] [US4] Create `packages/orchestrator/src/worker/__tests__/phase-loop.remediate-timeout.integration.test.ts` — SC-006: simulated timeout with partial changes commits+pushes the partial work, sidecar/counter stay valid and parseable, and the next remediate entry continues (review→remediate again) rather than restarting.

## Phase 6: Changeset

- [X] T018 [P] Create `.changeset/1128-remediate-executor.md` — `@generacy-ai/orchestrator` **patch** (internal executor/charter/phase-loop wiring, no new public exports), `@generacy-ai/generacy-plugin-claude-code` **minor** (new `'remediate'` launch intent kind), `@generacy-ai/workflow-engine` **minor** (new `completed:remediation-limit` label vocabulary per the CLAUDE.md "new label vocabulary in `workflow-engine` → minor" rule). Single file, all three bumps.

## Dependencies & Execution Order

**Phase order** (sequential): Phase 1 → Phase 2 → Phase 3 → Phase 4. Phases 5 and 6 can begin as soon as the code they cover lands (tests trail their implementation).

**Phase 1 (Foundational)** — must complete first:
- T001 → T002 (same file, `remediationCount` field before helpers).
- T003 → T004 (intent type before the launch-plugin branch).
- T005 independent.
- T001, T003, T005 are mutually parallel `[P]` (different files/packages).

**Phase 2 (US1)**:
- T006 `[P]` (pure charter, independent).
- T007 depends on T002 + T004 + T006.
- T008 depends on T007 (same-file `phase-loop.ts` — serializes with T010/T011/T012).
- T009 depends on T007.

**Phase 3 (US2)**:
- T010 depends on T001 + T008; T011 depends on T010. Both edit `phase-loop.ts` — serialize with T008/T012.

**Phase 4 (US3)**:
- T012 depends on T002 + T010. Edits `phase-loop.ts` — serialize with T008/T010/T011.

**Phase 5 (Tests)** — T013–T017 all `[P]` (distinct new test files); each requires its target code (T013→T002, T014→T006, T015→T007, T016→T010/T011/T012, T017→T008).

**Phase 6**: T018 `[P]` anytime.

**Note on `phase-loop.ts` serialization**: T008, T010, T011, T012 all edit `packages/orchestrator/src/worker/phase-loop.ts` and therefore run sequentially even though they belong to different user stories.

**Note on FR-013 / SC-007 (flag-off byte-identity)**: no dedicated task — with `reviewPhaseEnabled=false` the `review`/`remediate` phases are absent from the effective sequence, the seam never fires, and `RemediateExecutor` never constructs. The existing #1121 byte-identity assertion covers it; verify it still passes after Phase 4.
