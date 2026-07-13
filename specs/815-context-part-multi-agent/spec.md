# Feature Specification: Multi-agent phase 1c — per-phase model selection end-to-end verification

**Branch**: `815-context-part-multi-agent` | **Date**: 2026-07-13 | **Status**: Draft

## Summary

Phase 1c is the integration closer for the multi-agent provider plan's Wave 1. #813 opened the launcher to multiple providers; #814 threaded `{ provider, model }` from `orchestrator.agents` all the way to the spawn. This issue proves the wire works end-to-end on a real workflow run and that repos with no `orchestrator.agents` block behave byte-for-byte identically to pre-change. No new production code — the deliverable is a green verification protocol, its captured evidence, and the docs updates that make the feature discoverable.

## Context

Part of the [multi-agent provider plan (Codex + OpenCode)](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/multi-agent-provider-plan.md) — Phase 1 integration issue (3 of 3). Depends on #813 and #814.

Phase 1 ends with an end-to-end verification that per-phase model selection works on a real workflow run and that unconfigured repos are byte-for-byte unaffected.

## Scope

- On a test repo, run a `process:speckit-feature` issue with `orchestrator.agents` configured to use different Claude models per phase; verify via Pino spawn-log grep that each phase spawned with the configured model and that resume threading still works within the provider.
- Run an unconfigured sibling repo and verify behavior is identical to pre-change (parity check).
- Update the in-repo docs deliverable: `examples/config-full.yaml`. The two cross-repo docs (`dev-cluster-architecture.md`, `multi-agent-provider-plan.md`) are re-scoped to a sibling issue on `generacy-ai/tetrad-development`, linked from this PR body as a follow-up (per Q5 → A).

## Acceptance criteria (from issue)

- [ ] Configured run green end-to-end with per-phase models visible in spawn logs (all agent-spawning phases observed via operator-driven gate advancement — per Q2 → A).
- [ ] Unconfigured parity run green and identical to pre-change behavior.
- [ ] In-repo doc (`examples/config-full.yaml`) merged; cross-repo docs tracked in the linked follow-up issue against `tetrad-development` (per Q5 → A).

## User Stories

### US1: Operator configures different Claude models per workflow phase

**As an** operator managing a Generacy cluster,
**I want** to configure a distinct Claude model for each `speckit-feature` phase in a repo's `.generacy/config.yaml`,
**So that** I can trade cost for capability per phase (e.g. cheaper model for `specify`/`clarify`, top model for `implement`/`validate`) without patching orchestrator code.

**Acceptance Criteria**:
- [ ] With `orchestrator.agents` configured as a full three-layer stack (per Q3 → A, see FR-001), a real `process:speckit-feature` run reaches every agent-spawning phase — the operator manually adds `completed:<gate>` at each human-review pause to drive the run through the sequence to the natural implementation-review stop (per Q2 → A).
- [ ] Spawn logs show `--model <configured-model>` argv for every agent-spawning phase's process (`specify`, `clarify`, `plan`, `tasks`, `implement` — five phases; `validate` is a shell phase with no agent spawn, per Q2 → A carve-out), and the configured model differs between at least two phases in the run.
- [ ] The provider stays `claude-code` for every phase; a cross-phase `sessionId` carryover is observed at least once where two adjacent phases resolve to the same `{provider, model}` (per Q4 → A; see FR-004).

### US2: Operator with an unconfigured repo sees zero behavior change

**As an** operator whose repos never touched `orchestrator.agents`,
**I want** the same workflow runs, same spawn argv, same journal shape as before Wave 1 merged,
**So that** I can adopt the multi-agent-capable orchestrator with no rollout risk.

**Acceptance Criteria**:
- [ ] A `process:speckit-feature` run on a sibling repo with no `orchestrator.agents` block reaches the same terminal state as the configured run.
- [ ] The parity run's spawn argv contains **no** `--model` flag on any phase's process (matches the pre-#814 argv snapshot from #813's SC baseline).
- [ ] Journal shape and phase-transition timing are qualitatively identical to a pre-Wave-1 baseline.

### US3: Operator discovers the feature from docs

**As an** operator who did not follow the Wave 1 issues,
**I want** the config surface, precedence chain, and per-phase override syntax visible in `examples/config-full.yaml` and the dev-cluster-architecture doc,
**So that** I can adopt per-phase model selection without reading source or PR descriptions.

**Acceptance Criteria**:
- [ ] `examples/config-full.yaml` (in this repo) shows a fully annotated `orchestrator.agents` block with `default`, `workflows.<name>.default`, and `workflows.<name>.phases.<phase>` layers.
- [ ] A sibling issue on `generacy-ai/tetrad-development` is opened and linked from this PR body to cover the dev-cluster-architecture and plan-doc updates (per Q5 → A).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Test repo carries `.generacy/config.yaml` with a **full three-layer** `orchestrator.agents` fixture (per Q3 → B): `agents.default.model` = X, `workflows.speckit-feature.default.model` = Y, `workflows.speckit-feature.phases.implement.model` = Z, where X, Y, Z are three distinct Claude models. Every non-`implement` phase resolves to Y, supplying the adjacent same-model pairs SC-004's cross-phase carryover evidence requires. | P1 | Test-fixture setup. PR body must note that `agents.default` (X) is configured but shadowed by workflow default (Y) in a `speckit-feature` run — X-tier resolution is covered by #814's precedence unit tests (its SC-001), not this run. |
| FR-002 | Configured run is a real `process:speckit-feature` invocation on a live orchestrator against the test repo — not a fixture-driven unit test. | P1 | E2E, not unit. |
| FR-003 | Each agent-spawning phase's spawn is captured via `docker logs <orchestrator> \| grep -E 'Spawning Claude CLI\|agent.model.transition\|--model'` (or equivalent Pino grep against a saved log) and pasted as a fenced code block into the PR body — one block per phase (per Q1 → A). Each phase MUST show `--model <configured-model>` matching the resolved config. Denominator is the five agent-spawning phases: `specify`, `clarify`, `plan`, `tasks`, `implement` (per Q2 → A). | P1 | Primary evidence for AC #1. |
| FR-004 | **Cross-phase `sessionId` carryover** (per Q4 → A, replacing prior "within a phase" wording): at least once during the configured run, phase N+1's spawn argv MUST include `--resume <sessionId>` matching the `sessionId` phase N produced, where both phases resolved to the same `{provider, model}`. Captured in the same PR-body log excerpts as FR-003. This is the behavior #814 clarification Q2 → C established (sessions preserved on model-only same-provider transitions) — integration must prove it survived. Intra-phase resume (kill-and-continue within a single phase) is pre-existing, unrelated to this feature, and is NOT required evidence. | P1 | Proves #814's cross-boundary carryover survived integration. |
| FR-005 | Parity run uses an unconfigured sibling repo (no `orchestrator.agents` block at all) and is driven by the same orchestrator binary/build as the configured run. | P1 | Same-build parity, not cross-build. |
| FR-006 | Parity run's spawn argv MUST contain no `--model` flag on any phase's process. Captured via a single fenced code block in the PR body covering the whole parity run and showing zero grep matches for `--model` (per Q1 → A). | P1 | Primary evidence for AC #2. |
| FR-007 | Parity run reaches the same terminal state as the configured run (both green, or both stopped at the same gate). | P1 | Behavioral parity, not just argv. |
| FR-008 | `examples/config-full.yaml` (in this repo) gains an `orchestrator.agents` block with inline comments describing each layer and the precedence chain. This is the only in-repo docs deliverable landed by this PR. | P1 | Discoverability. |
| FR-009 | The dev-cluster-architecture "orchestrator block" section (in `generacy-ai/tetrad-development`, `docs/dev-cluster-architecture.md`) documents the config surface, the precedence chain (`phases.<phase>` > `workflows.<name>.default` > `agents.default` > `defaults.agent` > env > `claude-code`), and links to the plan doc. **Re-scoped to a sibling issue on `tetrad-development` per Q5 → A**; this PR does not land the change and does not block on it. Sibling issue link recorded in this PR body as a follow-up. | P1 | Cross-repo — tracked externally. |
| FR-010 | The multi-agent provider plan doc's (`generacy-ai/tetrad-development`, `docs/multi-agent-provider-plan.md`) Phase 1 status line flips to complete, with links to #813, #814, #815. **Re-scoped to the same sibling issue as FR-009 per Q5 → A**; this PR does not land the change and does not block on it. | P2 | Cross-repo — tracked externally. |
| FR-011 | Evidence for FR-003 / FR-004 / FR-006 is captured inline in the PR body as fenced code blocks (per Q1 → A). If a block outgrows the body, spilling it to a `gh pr comment --body-file` is an acceptable formatting fallback; gists and checked-in verification harnesses are NOT the required mechanism. | P1 | Reviewable evidence. |
| FR-012 | If the configured run fails and root cause is a defect in #813 or #814, this issue is blocked pending a fix issue against those PRs — no "fix while integrating" scope creep here. | P2 | Scope discipline. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Configured run's terminal state | Reaches the same phase-terminal state as the parity run (green or same-gate stopped) after operator advances each `waiting-for:*-review` gate with `completed:<gate>` (per Q2 → A). | Read from GitHub issue labels post-run |
| SC-002 | Per-phase `--model` visibility | 100% of **agent-spawning phase spawns** in the configured run log the configured `--model` value. Denominator = 5 phases (`specify`, `clarify`, `plan`, `tasks`, `implement`); `validate` is a shell phase with no agent spawn and is excluded (per Q2 → A). | Grep spawn logs for each of the five phases exercised |
| SC-003 | Parity argv drift | 0 `--model` flags across all phase spawns in the parity run | Grep parity-run log |
| SC-004 | Cross-phase `sessionId` carryover | At least 1 `sessionId` reuse across a phase boundary in the configured run where both adjacent phases resolve to the same `{provider, model}`. The three-layer fixture (FR-001) guarantees such a boundary exists — every non-`implement` phase resolves to Y, so any adjacent pair among `specify`→`clarify`→`plan`→`tasks` satisfies the requirement (per Q3 → B, Q4 → A). | Log inspection — grep for `--resume <sessionId>` on phase N+1's spawn matching phase N's produced `sessionId` |
| SC-005 | Docs discoverability | An operator reading `examples/config-full.yaml` alone can construct a valid `orchestrator.agents` block | Reviewer check during PR review |
| SC-006 | Plan doc status | **Re-scoped to sibling issue on `tetrad-development` per Q5 → A.** Measured on the sibling PR, not this one. | Tracked externally |

## Assumptions

- #813 and #814 are merged to `develop` and present in the orchestrator build used for both verification runs. (Confirmed by `git log`: `92ca0b4` and `5488c4c` on `develop`.)
- The verification runs occur on a cluster environment where journal / argv logs are inspectable post-hoc — either the local dev cluster or a scratch cluster. Cloud production is not required.
- A "test repo" and an "unconfigured sibling repo" can be scratch repos under the org's test scope; they do not need to be pre-existing.
- The workflow used is `speckit-feature`; other workflows (if any) are covered transitively by #814's precedence tests and are not re-verified here.
- The operator running the verification is available to manually add `completed:<gate>` labels at each human-review pause during the configured run, driving it through all five agent-spawning phases (per Q2 → A). The run is not expected to complete without operator gate advancement.
- The evidence-capture mechanism is `docker logs <orchestrator> | grep -E …` (or equivalent Pino grep against a saved log), pasted as fenced code blocks in the PR body (per Q1 → A). No new verification harness or checked-in log fixtures are produced.
- `validate` phase has no agent spawn (it is a shell phase in the current `speckit-feature` workflow); SC-002's "100%" denominator excludes it (per Q2 → A).

## Out of Scope

- Any new provider plugin (Codex, OpenCode) — plan Phase 3, tracked separately.
- Output-parser seam changes — plan Phase 2 ("Wave 3"), tracked separately.
- Changes to `WorkerConfigSchema`, `resolveAgentForPhase`, `CliSpawnOptions`, or any code path shipped in #813 / #814 — this issue verifies, does not extend.
- `agents.prFeedback` dedicated slot (Phase 1 issue 2 clarification Q1 → B leaves this as a later layer).
- Model-ID allowlist / format validation — #814 clarification Q4 → A explicitly leaves this as opaque pass-through.
- Custom-workflow phase keys beyond the `WorkflowPhase` enum — #814 clarification Q5 → A closed the schema.
- Cross-provider resume behavior — verified in #814 unit tests, not re-exercised here.
- Cluster-default env plumbing (`WORKER_AGENT_PROVIDER` / `WORKER_AGENT_MODEL`) — covered by #814's unit tests.
- Intra-phase resume evidence (kill-and-continue within a single phase) — pre-existing machinery unrelated to this feature (per Q4 → A).
- New verification scripts or checked-in log fixtures under `specs/815-…/verification/` — evidence lives inline in the PR body (per Q1 → A).
- Changes to `docs/dev-cluster-architecture.md` (FR-009) and `docs/multi-agent-provider-plan.md` (FR-010) in `generacy-ai/tetrad-development` — re-scoped to a sibling issue in that repo (per Q5 → A).

---

*Generated by speckit*
