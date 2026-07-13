# Tasks: Multi-agent phase 1c — per-phase model selection end-to-end verification

**Input**: Design documents from `/specs/815-context-part-multi-agent/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/config-fixture.md, contracts/evidence.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files/artifacts, no dependencies)
- **[Story]**: Which user story this task belongs to (US1/US2/US3)

## Context

This is a **verification + docs** PR, not a code change. The only in-repo edit is
`packages/generacy/examples/config-full.yaml`. Every other deliverable is either
an out-of-repo artifact (test/parity repos, sibling tetrad-development issue) or
evidence pasted inline into the PR body per `contracts/evidence.md`.

Two verification tracks run against the same orchestrator build:
1. **Configured** (US1) — three-layer `orchestrator.agents` fixture (X/Y/Z).
2. **Parity** (US2) — no `orchestrator.agents` block; zero `--model` drift.

Plus one in-repo docs edit (US3).

## Phase 1: Setup & prerequisites

- [ ] T001 [P] [US3] Open the sibling follow-up issue on `generacy-ai/tetrad-development` covering `docs/dev-cluster-architecture.md` orchestrator-block update (FR-009) and `docs/multi-agent-provider-plan.md` Phase 1 status flip + PR link updates (FR-010). Record the issue URL — it will be linked from the PR body Follow-ups section (per Q5 → A).
- [ ] T002 [P] Confirm the target cluster's orchestrator build contains #813 and #814 on `develop` (`git log --oneline develop | grep -E '#813|#814'` returns both commits `92ca0b4` and `5488c4c`). This is the same-build precondition FR-005 depends on.
- [ ] T003 [P] Confirm operator has `docker logs <orchestrator-container>` access on the cluster and Cockpit label-manipulation access (`gh issue edit --add-label`/`--remove-label`) on both scratch repos. These are the evidence-capture and gate-advancement prerequisites (quickstart.md Prerequisites).
- [ ] T004 [P] Provision **two** scratch repos under the org's test scope: one **configured** repo and one **unconfigured parity** repo. Each must have the four `waiting-for:*-review` gate labels configured (contracts/config-fixture.md "Non-fixture requirements") and an open issue ready to receive the `process:speckit-feature` label. Neither repo is checked into `generacy-ai/generacy`.

## Phase 2: In-repo docs deliverable

- [ ] T005 [US3] Edit `packages/generacy/examples/config-full.yaml` — replace the commented-out `# agents:` block (currently lines ~57–82) with a **live, uncommented, three-layer** example matching the shape recommended in `quickstart.md` "The single file edit landed by this PR": `default.model` = `sonnet-4-6`, `workflows.speckit-feature.default.model` = `sonnet-4-5`, `workflows.speckit-feature.phases.implement` = `{ provider: claude-code, model: opus-4-7 }`. Keep the existing precedence-chain header comment (lines ~48–56) unchanged. Add inline comments describing each layer. Satisfies FR-008 / SC-005.

## Phase 3: Configured verification (Track 1 — US1)

- [ ] T006 [US1] Write `.generacy/config.yaml` in the **configured** test repo per `contracts/config-fixture.md` "Required shape": three distinct Claude model IDs (e.g., X = `sonnet-4-6`, Y = `sonnet-4-5`, Z = `opus-4-7`), full three-layer stack, provider `claude-code` (or omitted) at every layer, no `phases.<x>` overrides outside `implement`, no `orchestrator.agents.prFeedback`. Commit and push. Satisfies FR-001.
- [ ] T007 [US1] Trigger the workflow by adding the `process:speckit-feature` label to the pre-provisioned open issue in the configured repo. Wait for the orchestrator's label monitor to enqueue and start the `specify` phase.
- [ ] T008 [US1] Drive the run through every human-review gate by adding `completed:<gate>` when each `waiting-for:*-review` label appears — in order: `completed:spec-review` → `completed:clarification-review` → `completed:plan-review` → `completed:tasks-review`. Stop when `waiting-for:implementation-review` appears (natural terminal per Q2 → A). Verifies FR-002 and reaches the five agent-spawning phases denominator SC-002 requires.
- [ ] T009 [US1] Save the orchestrator log locally to guard against rotation before evidence capture: `docker logs <orchestrator-container> > /tmp/configured-run.log 2>&1`. All subsequent Block A / Block B greps run against this file. Addresses the "docker logs truncated" troubleshooting row in `quickstart.md`.
- [ ] T010 [P] [US1] Capture **Block A1 (`specify` phase)**: grep for `Spawning new Claude CLI|agent.model.transition|"--model"` filtered to `"phase":"specify"` from `/tmp/configured-run.log`; paste as fenced block under `### Phase 1: specify` in the PR body draft with the required assertion line: `Resolved specify to Y via workflows.speckit-feature.default — matches fixture Y.` (contracts/evidence.md Block A).
- [ ] T011 [P] [US1] Capture **Block A2 (`clarify` phase)**: same grep filtered to `"phase":"clarify"`; paste under `### Phase 2: clarify`; assertion: `Resolved clarify to Y via workflows.speckit-feature.default — matches fixture Y.`
- [ ] T012 [P] [US1] Capture **Block A3 (`plan` phase)**: same grep filtered to `"phase":"plan"`; paste under `### Phase 3: plan`; assertion: `Resolved plan to Y via workflows.speckit-feature.default — matches fixture Y.`
- [ ] T013 [P] [US1] Capture **Block A4 (`tasks` phase)**: same grep filtered to `"phase":"tasks"`; paste under `### Phase 4: tasks`; assertion: `Resolved tasks to Y via workflows.speckit-feature.default — matches fixture Y.`
- [ ] T014 [P] [US1] Capture **Block A5 (`implement` phase)**: same grep filtered to `"phase":"implement"`; block MUST include a preceding `agent.model.transition` line with `prevModel: Y, nextModel: Z`; paste under `### Phase 5: implement`; assertion: `Resolved implement to Z via workflows.speckit-feature.phases.implement — matches fixture Z; agent.model.transition Y → Z observed.` Satisfies FR-003 and SC-002 (5/5 agent-spawning phases).
- [ ] T015 [US1] Capture **Block B (cross-phase `sessionId` carryover)**: pick any adjacent pair among `specify` → `clarify` → `plan` → `tasks` (all Y). Grep `/tmp/configured-run.log` for `"sessionId":|"--resume"|"phase":"(clarify|plan|tasks)"` per contracts/evidence.md Block B. Confirm phase N+1's spawn argv contains `--resume <S>` where `<S>` is the `sessionId` phase N produced, with no `agent.model.transition` between them. Paste under `### Cross-phase sessionId carryover` with assertion: `Phase <N+1> reused session <S> produced by phase <N> (both resolved to {claude-code, Y}).` Satisfies FR-004 and SC-004.
- [ ] T016 [US1] Capture **Block D-configured (terminal state)**: `gh issue view <configured-issue-number> --json labels`; paste under `### Terminal state` in the configured-run section of the PR body draft.

## Phase 4: Parity verification (Track 2 — US2)
<!-- Phase boundary: Track 2 runs after Track 1 to reuse the same operator + cluster; can be started in parallel only if a second orchestrator instance is available. -->

- [ ] T017 [US2] Write `.generacy/config.yaml` in the **parity** repo with **no** `orchestrator.agents` block at all. Any other schema-valid fields are fine. Commit and push. Satisfies FR-005.
- [ ] T018 [US2] Trigger `process:speckit-feature` on the parity repo's pre-provisioned issue; drive through the same four `completed:<gate>` advances as T008 until it halts at the natural implementation-review terminal.
- [ ] T019 [US2] Save the parity orchestrator log locally: `docker logs <parity-orchestrator-container> > /tmp/parity-run.log 2>&1` (same rationale as T009).
- [ ] T020 [US2] Capture **Block C (zero `--model` drift)**: `grep -c -- '--model' /tmp/parity-run.log`; output MUST be `0`. Paste under `### Zero --model drift` with assertion: `Zero --model flags across the entire parity run.` Satisfies FR-006 and SC-003.
- [ ] T021 [US2] Capture **Block D-parity (terminal state)**: `gh issue view <parity-issue-number> --json labels`; paste under `### Terminal state` in the parity-run section. Confirm the terminal-state signal matches the configured run's (both green, or both stopped at the same gate). Satisfies FR-007 and SC-001.

## Phase 5: PR assembly & success-criteria gate
<!-- Phase boundary: All evidence captured in Phases 3 & 4 before assembling the PR body. -->

- [ ] T022 Assemble the PR body per the exact section layout in `contracts/evidence.md`: `## Verification — configured run` with H3s for the five phase blocks + carryover + terminal state, then `## Verification — parity run` with zero-drift + terminal state, then `## Follow-ups`. Each fenced block is preceded by the grep command that produced it (research.md Decision 1 rationale: reviewers can re-derive locally).
- [ ] T023 Add the **Follow-ups** section linking the T001 sibling `tetrad-development` issue URL, explicitly covering FR-009 + FR-010. Satisfies FR-011 and the follow-up-tracking half of SC-006.
- [ ] T024 Add the **honesty note** required by Decision 3: one line noting that `agents.default` (X) is configured but shadowed by the workflow default (Y) in a `speckit-feature` run — X-tier resolution is covered by #814's precedence unit tests, not this run.
- [ ] T025 Run the pre-open success-criteria gate before opening the PR — walk through SC-001…SC-005 against the assembled PR body: SC-001 terminal-state parity from Block D pair, SC-002 five per-phase `--model` visibility from Blocks A1–A5, SC-003 parity zero-drift from Block C, SC-004 cross-phase carryover from Block B, SC-005 docs discoverability from T005. SC-006 is measured on the sibling `tetrad-development` PR, not this one (per Q5 → A) — confirm the follow-up is filed, do not block on it. If any SC fails, escalate per FR-012 (do not paper over).

## Dependencies & Execution Order

**Phase 1** (Setup): T001–T004 are independent and can run in parallel. All must complete before Phase 3 starts (T004 provisions the repos T006/T017 need; T002 confirms the build both runs use; T001 gives T023 something to link).

**Phase 2** (Docs edit): T005 is a single in-repo file edit that is independent of Phases 3 & 4. Can be done at any time after Phase 1 completes.

**Phase 3** (Configured verification):
- T006 depends on T004.
- T007 depends on T006.
- T008 depends on T007 (drives the running workflow).
- T009 depends on T008 (log rotation snapshot after the run halts).
- **T010–T014 can all run in parallel** — each is an independent grep against the same saved log (`/tmp/configured-run.log`).
- T015 can run in parallel with T010–T014 (independent grep on the same file).
- T016 can run in parallel with T010–T015 (independent `gh` call).

**Phase 4** (Parity verification): T017 → T018 → T019 → T020 (with T021 parallelizable to T020). Sequential in wall-clock because there's one operator; can begin as soon as Phase 3's run halts (T008 done). If a second orchestrator instance is available, Phase 4 can start in parallel with Phase 3 evidence capture (T010+).

**Phase 5** (PR assembly): T022 depends on all Phase 3 & Phase 4 blocks. T023 depends on T001 (needs the sibling issue URL). T024 is independent of other Phase 5 steps. T025 is the terminal gate — depends on T022 + T023 + T024 + T005 (edits from every prior phase).

**Total tasks**: 25
**Parallelizable within phases**: T001–T004 (Phase 1, 4-way parallel), T010–T016 (Phase 3, 7-way parallel), T024 (independent within Phase 5).

## Next Step

`/speckit:implement` to begin execution — start with Phase 1 setup, then proceed sequentially through phases with parallelism inside each phase as marked.
