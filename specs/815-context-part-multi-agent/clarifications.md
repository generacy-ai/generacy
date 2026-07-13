# Clarifications — #815 Multi-agent phase 1c integration verification

## Batch 1 — 2026-07-13

### Q1: "Journal" definition and evidence extraction
**Context**: FR-003 requires "journal or argv log" evidence per phase spawn; FR-006 requires the parity run's "spawn argv" to contain no `--model`; FR-011 requires that evidence be captured (not just described) in the PR body or a linked artifact. The codebase has no distinct "journal" — the relevant surfaces are Pino orchestrator logs (`Spawning Claude CLI session for phase (via AgentLauncher)` in `cli-spawner.ts:61`, `agent.model.transition` in `phase-loop.ts:388`), plus the `packages/orchestrator/src/launcher/__tests__/__snapshots__/*.snap` argv fixtures used by the argv snapshot tests. Different capture mechanisms have very different reviewability: `docker logs` output is timestamp-noisy and needs filtering; a mounted log file is cleaner but requires bind-mount setup; a scripted argv dump could be added but is new code (out of scope per Out of Scope §3). The spec does not name the mechanism, so the operator running the verification can pick anything from "screenshot of terminal" to "gist of `docker logs --since ... orchestrator | grep`" — with wildly different reviewer experiences.
**Question**: What is the required capture mechanism for FR-003 / FR-006 / FR-011 evidence, and where does it land in the PR?
**Options**:
- A: `docker logs <orchestrator> | grep -E 'Spawning Claude CLI|agent.model.transition|--model'` (or equivalent Pino grep), pasted as fenced code blocks into the PR body — one block per phase for the configured run + one block covering the whole parity run showing zero matches for `--model`.
- B: Redirect orchestrator stdout to a file (e.g., `docker logs > run-configured.log`), attach both files as a gist (or `gh pr comment --body-file`) linked from the PR body; PR body summarizes the phase-by-phase mapping in a table.
- C: Add a small verification harness under `specs/815-.../verification/` (a shell script + captured outputs checked in) that both re-runs the greps and stores their canonical output; the PR links the script and its output.

**Answer**: *Pending*

### Q2: Phase-coverage requirement for "reaches every phase spawn"
**Context**: US1 AC #1 says the run "drives the issue to `epic-complete` (or to the equivalent phase-terminal gate the workflow reaches without human input)". `speckit-feature` has four human gates baked in (`spec-review`, `clarification-review`, `plan-review`, `tasks-review`, plus an implementation review) — so a run "without human input" naturally stops after the `specify` phase at `waiting-for:spec-review`. That's one phase, insufficient to prove per-phase model selection (US1 requires "the configured model differs between at least two phases in the run") and impossible to satisfy SC-002 ("100% of phase spawns... log the configured `--model` value") if "all phases" means the full 6-phase sequence. Two readings collide: (a) the operator manually advances each human gate (`completed:*`) during the verification so the run reaches all six phases; (b) verification is bounded to whatever phases naturally execute before the first human stop, and SC-002's "100%" is scoped to that observed set.
**Question**: For FR-003 / SC-002, how many phases must be observed spawning under the configured run, and does the verification protocol include manually advancing human gates?
**Options**:
- A: All six phases (`specify`, `clarify`, `plan`, `tasks`, `implement`, `validate`) — the operator manually adds `completed:<gate>` after each human-review pause during the verification session and drives the run through to the natural implementation-review stop. Evidence covers 6 spawns.
- B: A phase-subset floor — verification requires at least three distinct phases observed under different resolved models (e.g., configure `specify`, `plan`, `implement` with three different models; advance gates only to reach `implement`), scoped precisely enough to exercise the workflow-default → phase-override precedence layers.
- C: Only whatever the natural first-stop reaches (typically just `specify`); SC-002's "100%" scopes to observed phases only. Compensate by running two additional configurations (or the same config with an out-of-band phase invocation) so at least two phases are observed with distinct models across the aggregate evidence.

**Answer**: *Pending*

### Q3: Required `orchestrator.agents` shape for the test repo
**Context**: FR-001 says the fixture must set `phases.<phase>.model` for "enough phases that at least two phases resolve to distinct models". This is a lower bound only. But the docs deliverable (FR-008 / SC-005) is that an operator can construct a valid block from `examples/config-full.yaml` alone — implying the verification's own fixture is a natural reference. And the resume-preservation evidence (SC-004: reuse across a same-provider same-model boundary) requires at least one adjacent pair of phases with matching resolved model. Depending on how the block is shaped, verification either happens to exercise every precedence layer (`agents.default`, `workflows.<name>.default`, `phases.<phase>`) or exercises only the phase-override layer. The former makes the run a stronger integration test; the latter is easier to write.
**Question**: What is the required shape of the test repo's `orchestrator.agents` block?
**Options**:
- A: Minimum viable — set `phases.specify.model` and `phases.implement.model` to two distinct Claude models; leave everything else unset. Meets FR-001's floor and exercises the phase-override layer; other precedence layers are unexercised in this run.
- B: Full three-layer stack — set `agents.default.model` to one model (X), `workflows.speckit-feature.default.model` to a second model (Y), and `phases.implement.model` to a third model (Z). Every precedence layer is exercised in a single run; adjacent same-model pairs (e.g., `specify` + `clarify` both resolving to Y) supply SC-004's resume-preservation evidence.
- C: Full six-phase override — set `phases.<phase>.model` on all six with a documented model per phase; other precedence layers are unexercised in the run but the fixture directly mirrors what an operator would write for maximal per-phase control.

**Answer**: *Pending*

### Q4: Resume-preservation evidence — within a phase, or across phase boundaries?
**Context**: FR-004 says "Resume within a phase (same provider, same model) MUST reuse the stored `sessionId` at least once during the configured run — captured in the journal." SC-004 says "At least 1 `sessionId` reuse across phase **boundaries** in the configured run when model stays constant." These describe two different behaviors: (a) intra-phase resume (a phase spawn is killed and re-continued within itself — the resume path used by increments/timeouts/human input), (b) inter-phase carryover (phase N ends with `sessionId=S`, phase N+1 starts with `resumeSessionId=S` because provider+model matched, per `phase-loop.ts:402` reading `currentSessionId`). #814 clarification Q2 → C established behavior (b): sessions preserved on model-only same-provider transitions. Behavior (a) exists but is unrelated to this feature. If the verification proves (a), it doesn't prove the #814 change survived integration; if it proves (b), FR-004's wording is technically wrong.
**Question**: Which resume behavior is the required evidence for FR-004 / SC-004?
**Options**:
- A: Cross-phase carryover (b) — align FR-004's wording with SC-004; evidence is a journal entry showing phase N+1 spawned with `--resume <sessionId>` matching the `sessionId` phase N produced, when both resolved to the same `{provider, model}`. FR-004 rewritten in spec.md to match.
- B: Both — the run must exhibit at least one intra-phase resume (a) AND at least one cross-phase carryover (b); evidence for both cited in the PR body.
- C: Only within-phase (a) as literally written; SC-004's cross-boundary wording is treated as descriptive of the enabling behavior but not a distinct evidence requirement.

**Answer**: *Pending*

### Q5: dev-cluster-architecture.md docs update — cross-repo scope
**Context**: FR-009 requires the "dev-cluster-architecture 'orchestrator block' section" to document the config surface, precedence chain, and link to the plan doc. That file is `/workspaces/tetrad-development/docs/dev-cluster-architecture.md` — i.e., in the `tetrad-development` repo, not `generacy`. This issue's PR lands against `generacy-ai/generacy`; it cannot include changes to `tetrad-development` in the same PR. The plan doc (`multi-agent-provider-plan.md`, FR-010) has the same problem — it also lives in `tetrad-development`. AC #3 ("Docs merged") does not name which docs live where. Two of the three docs deliverables are cross-repo. The spec does not say whether those PRs block this issue's `epic-complete` or whether they are landed as follow-ups tracked separately.
**Question**: How are the cross-repo docs deliverables (`dev-cluster-architecture.md` FR-009, `multi-agent-provider-plan.md` FR-010) landed and gated?
**Options**:
- A: This issue's PR only lands `examples/config-full.yaml` (FR-008, which is in this repo). FR-009 and FR-010 are re-scoped to sibling issues on `tetrad-development` and are called out in this PR body as follow-ups; AC #3 is met by the in-repo doc change alone, with follow-up issues linked.
- B: This issue does not merge until sibling PRs against `tetrad-development` (one covering both `dev-cluster-architecture.md` and `multi-agent-provider-plan.md`) are also merged; this PR body links both PRs and AC #3 is checked only when all three are merged.
- C: FR-008 lands here; FR-009 and FR-010 are landed by the operator running the verification via manual `tetrad-development` PRs opened alongside this issue's PR; both must be merged before this PR merges, but they are not created by the workflow — only referenced in this PR's body.

**Answer**: *Pending*
