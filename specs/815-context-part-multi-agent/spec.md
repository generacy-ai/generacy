# Feature Specification: Multi-agent phase 1c — per-phase model selection end-to-end verification

**Branch**: `815-context-part-multi-agent` | **Date**: 2026-07-13 | **Status**: Draft

## Summary

Phase 1c is the integration closer for the multi-agent provider plan's Wave 1. #813 opened the launcher to multiple providers; #814 threaded `{ provider, model }` from `orchestrator.agents` all the way to the spawn. This issue proves the wire works end-to-end on a real workflow run and that repos with no `orchestrator.agents` block behave byte-for-byte identically to pre-change. No new production code — the deliverable is a green verification protocol, its captured evidence, and the docs updates that make the feature discoverable.

## Context

Part of the [multi-agent provider plan (Codex + OpenCode)](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/multi-agent-provider-plan.md) — Phase 1 integration issue (3 of 3). Depends on #813 and #814.

Phase 1 ends with an end-to-end verification that per-phase model selection works on a real workflow run and that unconfigured repos are byte-for-byte unaffected.

## Scope

- On a test repo, run a `process:speckit-feature` issue with `orchestrator.agents` configured to use different Claude models per phase; verify via journal/argv logging that each phase spawned with the configured model and that resume threading still works within the provider.
- Run an unconfigured sibling repo and verify behavior is identical to pre-change (parity check).
- Update docs: `examples/config-full.yaml`, the dev-cluster-architecture "orchestrator block" section, and the plan doc's status line.

## Acceptance criteria (from issue)

- [ ] Configured run green end-to-end with per-phase models visible in spawn logs/journal.
- [ ] Unconfigured parity run green and identical to pre-change behavior.
- [ ] Docs merged.

## User Stories

### US1: Operator configures different Claude models per workflow phase

**As an** operator managing a Generacy cluster,
**I want** to configure a distinct Claude model for each `speckit-feature` phase in a repo's `.generacy/config.yaml`,
**So that** I can trade cost for capability per phase (e.g. cheaper model for `specify`/`clarify`, top model for `implement`/`validate`) without patching orchestrator code.

**Acceptance Criteria**:
- [ ] With `orchestrator.agents.workflows.speckit-feature.phases.<phase>.model` set for each of the six phases, a real `process:speckit-feature` run drives the issue to `epic-complete` (or to the equivalent phase-terminal gate the workflow reaches without human input).
- [ ] Spawn logs / journal show `--model <configured-model>` argv for every phase's process, and the configured model differs between at least two phases in the run.
- [ ] The provider stays `claude-code` for every phase; the stored `sessionId` is preserved across model-only transitions (per #814 clarification Q2 → C) so resume-threading is exercised.

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
- [ ] `examples/config-full.yaml` shows a fully annotated `orchestrator.agents` block with `default`, `workflows.<name>.default`, and `workflows.<name>.phases.<phase>` layers.
- [ ] The dev-cluster-architecture "orchestrator block" section documents the block and the precedence chain from #814 FR-008.
- [ ] The plan doc's Phase 1 status line flips to complete with a link back to this issue.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Test repo carries `.generacy/config.yaml` with `orchestrator.agents.workflows.speckit-feature.phases.<phase>.model` set for enough phases that at least two phases resolve to distinct models. | P1 | Test-fixture setup. |
| FR-002 | Configured run is a real `process:speckit-feature` invocation on a live orchestrator against the test repo — not a fixture-driven unit test. | P1 | E2E, not unit. |
| FR-003 | Each phase's spawn (journal or argv log) is captured and inspected; each phase MUST show `--model <configured-model>` matching the resolved config. | P1 | Primary evidence for AC #1. |
| FR-004 | Resume within a phase (same provider, same model) MUST reuse the stored `sessionId` at least once during the configured run — captured in the journal. | P1 | Proves resume threading survived #814. |
| FR-005 | Parity run uses an unconfigured sibling repo (no `orchestrator.agents` block at all) and is driven by the same orchestrator binary/build as the configured run. | P1 | Same-build parity, not cross-build. |
| FR-006 | Parity run's spawn argv MUST contain no `--model` flag on any phase's process. | P1 | Primary evidence for AC #2. |
| FR-007 | Parity run reaches the same terminal state as the configured run (both green, or both stopped at the same gate). | P1 | Behavioral parity, not just argv. |
| FR-008 | `examples/config-full.yaml` gains an `orchestrator.agents` block with inline comments describing each layer and the precedence chain. | P1 | Discoverability. |
| FR-009 | The dev-cluster-architecture "orchestrator block" section documents the config surface, the precedence chain (`phases.<phase>` > `workflows.<name>.default` > `agents.default` > `defaults.agent` > env > `claude-code`), and links to the plan doc. | P1 | Discoverability. |
| FR-010 | The multi-agent provider plan doc's Phase 1 status line flips to complete, with links to #813, #814, #815. | P2 | Roadmap hygiene. |
| FR-011 | Evidence for FR-003 / FR-006 (argv/journal excerpts) is captured in the PR body or an artifact linked from the PR, not just described. | P1 | Reviewable evidence. |
| FR-012 | If the configured run fails and root cause is a defect in #813 or #814, this issue is blocked pending a fix issue against those PRs — no "fix while integrating" scope creep here. | P2 | Scope discipline. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Configured run's terminal state | Reaches the same phase-terminal state as the parity run (green or same-gate stopped) | Read from GitHub issue labels post-run |
| SC-002 | Per-phase `--model` visibility | 100% of phase spawns in the configured run log the configured `--model` value | Grep spawn logs / journal for each of the phases exercised |
| SC-003 | Parity argv drift | 0 `--model` flags across all phase spawns in the parity run | Grep parity-run journal |
| SC-004 | Resume within provider | At least 1 `sessionId` reuse across phase boundaries in the configured run when model stays constant | Journal inspection |
| SC-005 | Docs discoverability | An operator reading `examples/config-full.yaml` alone can construct a valid `orchestrator.agents` block | Reviewer check during PR review |
| SC-006 | Plan doc status | Phase 1 status line links to #813, #814, #815 and is marked complete | Doc diff review |

## Assumptions

- #813 and #814 are merged to `develop` and present in the orchestrator build used for both verification runs. (Confirmed by `git log`: `92ca0b4` and `5488c4c` on `develop`.)
- The verification runs occur on a cluster environment where journal / argv logs are inspectable post-hoc — either the local dev cluster or a scratch cluster. Cloud production is not required.
- A "test repo" and an "unconfigured sibling repo" can be scratch repos under the org's test scope; they do not need to be pre-existing.
- The workflow used is `speckit-feature`; other workflows (if any) are covered transitively by #814's precedence tests and are not re-verified here.
- `process:speckit-feature` runs to a natural human-gate stop is acceptable as "green" for AC purposes — the point is to prove per-phase model selection reaches every phase spawn, not to prove the workflow itself lands a PR without human review.

## Out of Scope

- Any new provider plugin (Codex, OpenCode) — plan Phase 3, tracked separately.
- Output-parser seam changes — plan Phase 2 ("Wave 3"), tracked separately.
- Changes to `WorkerConfigSchema`, `resolveAgentForPhase`, `CliSpawnOptions`, or any code path shipped in #813 / #814 — this issue verifies, does not extend.
- `agents.prFeedback` dedicated slot (Phase 1 issue 2 clarification Q1 → B leaves this as a later layer).
- Model-ID allowlist / format validation — #814 clarification Q4 → A explicitly leaves this as opaque pass-through.
- Custom-workflow phase keys beyond the `WorkflowPhase` enum — #814 clarification Q5 → A closed the schema.
- Cross-provider resume behavior — verified in #814 unit tests, not re-exercised here.
- Cluster-default env plumbing (`WORKER_AGENT_PROVIDER` / `WORKER_AGENT_MODEL`) — covered by #814's unit tests.

---

*Generated by speckit*
