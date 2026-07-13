# Implementation Plan: Multi-agent phase 1c — per-phase model selection end-to-end verification

**Feature**: Verify that #813 + #814 landed a working, byte-for-byte-backwards-compatible per-phase `{ provider, model }` selection surface on a real `speckit-feature` run
**Branch**: `815-context-part-multi-agent`
**Status**: Complete

## Summary

Phase 1c is an integration verification and docs issue, not a code change. #813 opened the launcher to multiple providers and #814 threaded `{ provider, model }` from `orchestrator.agents` through `resolveAgentForPhase` into every spawn site. This plan wires that into a captured, reviewable proof:

1. **Configured run** — a real `process:speckit-feature` invocation against a test repo whose `.generacy/config.yaml` carries a full three-layer `orchestrator.agents` fixture (`agents.default` = X, `workflows.speckit-feature.default` = Y, `workflows.speckit-feature.phases.implement` = Z). The operator advances each `waiting-for:*-review` gate manually with `completed:<gate>` so the run reaches every agent-spawning phase.
2. **Parity run** — the same orchestrator build against an unconfigured sibling repo, proving zero `--model` drift.
3. **Docs deliverable** — annotate `packages/generacy/examples/config-full.yaml` so operators can copy the three-layer block and understand precedence without reading source. Cross-repo docs (`dev-cluster-architecture.md`, `multi-agent-provider-plan.md`) are re-scoped to a sibling issue on `generacy-ai/tetrad-development` per clarification Q5.

There is no new production code. The only file edit landed by this PR is `packages/generacy/examples/config-full.yaml`. Everything else is evidence pasted into the PR body as fenced code blocks per Q1.

## Technical Context

**Languages/frameworks**: none new — this issue targets an existing TypeScript orchestrator (Node ≥ 22, Fastify, Pino) already in the repo. Evidence capture uses `docker` + `grep` at the shell.

**Dependencies**: none added.

**Grep targets** (already emitted by `packages/orchestrator/src/worker/`):
- Spawn line: `cli-spawner.ts:61` — `"Spawning new Claude CLI session for phase (via AgentLauncher)"`.
- Model transition line: `phase-loop.ts:388` — `agent.model.transition` (fires when adjacent phases resolve to same provider but different model).
- Session carryover argv: `phase-loop.ts:402` sets `resumeSessionId: currentSessionId`, which reaches the CLI as `--resume <sessionId>` on phase N+1 when phase N produced a session at line 466.

**Config surface** (already shipped by #813/#814):
- Schema: `packages/orchestrator/src/worker/config.ts` — `WorkerConfigSchema.orchestrator.agents` (default + workflows + phases).
- Resolver: `resolveAgentForPhase(config, workflow, phase)` — returns `{ provider, model? }` following the precedence chain.
- Wire-through: `CliSpawnOptions.provider` / `CliSpawnOptions.model` in `worker/types.ts` → `AgentLauncher.launch` → per-plugin argv builder that renders `--model <model>` when set.

**Runtime environment**:
- Local dev cluster or scratch cluster (cloud production not required — Assumptions §2).
- `docker logs <orchestrator>` accessible to the operator running the verification.
- Two scratch repos under the org's test scope: one configured, one unconfigured. Neither needs to be pre-existing (Assumptions §3).

**Verification cadence**: single-session run for each of the two verification tracks. No CI job, no scheduled retry.

## Project Structure

```
specs/815-context-part-multi-agent/
├── spec.md                    # (frozen — describes what to prove)
├── clarifications.md          # (frozen — Q1-Q5)
├── plan.md                    # THIS FILE
├── research.md                # Mechanism choices with rationale
├── data-model.md              # Config fixture + evidence artifact shapes
├── quickstart.md              # Operator runbook for the two verification tracks
└── contracts/
    ├── config-fixture.md      # Required shape of the test repo's orchestrator.agents block
    └── evidence.md            # Required shape of PR-body evidence blocks

packages/generacy/examples/
└── config-full.yaml           # EDIT: uncomment + annotate orchestrator.agents block
```

**Files touched by this PR**:
- `packages/generacy/examples/config-full.yaml` — replace the commented-out `agents:` example with a live, uncommented three-layer block plus inline precedence documentation (FR-008).

**Files NOT touched by this PR**:
- `packages/orchestrator/**` — verification only, per Out of Scope §3.
- `packages/generacy/**` (excluding `examples/`) — no CLI change.
- `docs/dev-cluster-architecture.md`, `docs/multi-agent-provider-plan.md` — both live in `tetrad-development`, re-scoped to a sibling issue per Q5 (FR-009 / FR-010).

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. No project-wide constitution rules to check.

Project-level guardrails from `CLAUDE.md` that apply:
- Test-repo config lives under the test repo, not this repo — no fixture files checked in here.
- Evidence lives in PR body as fenced blocks (Q1 → A) — no `specs/815-.../verification/` harness added (spec Out of Scope §9).
- Cross-repo docs (FR-009, FR-010) tracked externally via sibling issue on `tetrad-development` (Q5 → A).

## Verification Protocol at a Glance

| Track | Repo config | Denominator | Primary evidence | Fails if… |
|-------|-------------|-------------|------------------|-----------|
| Configured | Three-layer `orchestrator.agents` fixture (X/Y/Z) | 5 agent-spawning phases: `specify`, `clarify`, `plan`, `tasks`, `implement` (per Q2 → A carve-out — `validate` is a shell phase, no spawn) | One fenced block per phase in the PR body showing `Spawning new Claude CLI session for phase` + `--model <resolved>` | Any phase spawns without `--model` OR spawns with a model not matching the resolved config OR no cross-phase `--resume <sessionId>` carryover observed |
| Parity | No `orchestrator.agents` block | Whole run | Single fenced block showing zero `--model` matches across the run | Any `--model` flag appears OR terminal state differs from configured run |

## Success Gate

All six spec success criteria (SC-001…SC-006) satisfied. SC-006 is measured on the sibling `tetrad-development` PR, not this one (Q5 → A). Configured + parity evidence blocks live in the PR body (FR-011); the sibling tetrad-development follow-up issue is linked in the PR body.

## Next Step

`/speckit:tasks` to break the verification runbook into an ordered, per-phase task list.
