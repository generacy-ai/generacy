# Feature Specification: Per-workflow orchestrator overrides in `.generacy/config.yaml`

**Branch**: `1122-context-generacy-config-yaml` | **Date**: 2026-08-19 | **Status**: Draft

**Issue**: generacy-ai/generacy#1122 | **Epic**: generacy-ai/generacy#1120 (engine-native review & remediate phases)

## Summary

Today a target repo's `.generacy/config.yaml` `orchestrator` block only lets a repo
override two values globally for that repo: `validateCommand` and
`preValidateCommand` (`packages/config/src/template-schema.ts:88,94`, merged by
`applyRepoValidateOverrides` in `packages/orchestrator/src/worker/config.ts:126-145`).
Everything else — remediation budgets, review strictness — is cluster-level only.

The engine-native review & remediate design (#1120) needs those settings to vary
**per workflow** (e.g. `speckit-feature` vs `speckit-bugfix`) so a bugfix can run a
cheaper review with a smaller remediation budget than a feature. This feature adds a
`workflows` map to `OrchestratorSettingsSchema`, wires it through the loader and worker
merge, and defines a clear precedence chain: **workflow-level > repo-level > cluster
default**.

The per-workflow *agents* keying already exists as `orchestrator.agents.workflows`
(shipped in #1095; see `AgentsConfigSchema` and `resolveAgentForPhase`). This feature
must **compose with**, not duplicate, that block.

## User Stories

### US1: Per-workflow validate + remediation budget (P1)

**As a** cluster operator configuring a target repo,
**I want** to set `validateCommand`, `preValidateCommand`, and `maxRemediations` per
workflow in `.generacy/config.yaml`,
**So that** `speckit-bugfix` jobs can use a tighter remediation budget and a different
validate command than `speckit-feature` jobs in the same repo.

**Acceptance Criteria**:
- [ ] `orchestrator.workflows.<name>.validateCommand` overrides the repo-level
      `orchestrator.validateCommand`, which overrides the cluster worker-config default.
- [ ] `orchestrator.workflows.<name>.maxRemediations` accepts an integer ≥ 0. When
      absent it defaults to 3 for `speckit-feature` and 2 for `speckit-bugfix`.
- [ ] `preValidateCommand: ""` (empty string) at workflow level still means "skip
      install" and is preserved through the merge, matching current repo-level behavior.

### US2: Per-workflow review strictness (P1)

**As a** cluster operator,
**I want** a `review` block per workflow (`profile`, `blockingSeverity`, `failThenPass`),
**So that** bugfix reviews can run a lighter profile and a lower blocking severity than
feature reviews.

**Acceptance Criteria**:
- [ ] `orchestrator.workflows.<name>.review.profile` accepts `standard` | `verification`.
- [ ] `review.blockingSeverity` accepts `critical` | `major` | `minor`.
- [ ] `review.failThenPass` is a boolean.
- [ ] Each `review` sub-field resolves independently over the precedence chain (a
      workflow that sets only `blockingSeverity` inherits `profile`/`failThenPass` from
      the lower tier).

### US3: Unchanged behavior for repos without the new block (P1)

**As a** cluster operator with existing repos,
**I want** repos that omit the new `workflows` block to behave exactly as before,
**So that** this change is non-breaking.

**Acceptance Criteria**:
- [ ] A config with no `orchestrator.workflows` key produces identical worker config
      to today (reference-equality "no override" fast paths preserved where they exist).
- [ ] Unknown keys anywhere in the block still fail loudly (schema stays `.strict()`).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Extend `OrchestratorSettingsSchema` with optional `workflows: Record<string, WorkflowOverride>` where `WorkflowOverride` = `{ validateCommand?, preValidateCommand?, maxRemediations?, review? }`. | P1 | `workflows` stays a `z.record(z.string(), …)` because workflow names are extensible; the value schema is `.strict()`. |
| FR-002 | `maxRemediations` is `z.number().int().min(0)`. Defaults applied at resolve time (not schema default): `speckit-feature` → 3, `speckit-bugfix` → 2, any other workflow name → 3 (per Q3). | P1 | Default lives in resolve logic so an absent key is distinguishable from an explicit `0`. |
| FR-003 | `review` = `{ profile?: 'standard'\|'verification', blockingSeverity?: 'critical'\|'major'\|'minor', failThenPass?: boolean }`, `.strict()`. | P1 | Enums closed. |
| FR-004 | Precedence: `validateCommand`/`preValidateCommand` resolve workflow-level > repo-level `orchestrator.*` > cluster worker-config default (three tiers). `review.*`/`maxRemediations` resolve workflow-level > built-in default (two tiers — **no repo-level tier**, per Q2). Each field resolves independently. | P1 | Extends the existing `applyRepoValidateOverrides` semantics. |
| FR-005 | Loader (`packages/config/src/loader.ts` `tryLoadOrchestratorSettings`) parses and returns the new block unchanged. | P1 | No new loader entrypoint; existing parse path carries the extended schema. |
| FR-006 | Worker merge (`packages/orchestrator/src/worker/config.ts`) resolves per-workflow overrides given a workflow name. | P1 | New resolver(s) sibling to `applyRepoValidateOverrides` / `resolveAgentForPhase`. |
| FR-007 | `claude-cli-worker` plumbs the resolved per-workflow values to the phase that consumes them. | P1 | Mirrors existing `agents: effectiveConfig.agents` plumb-through at `claude-cli-worker.ts:496`. |
| FR-008 | The new per-workflow non-agent fields live in a **new sibling map** `orchestrator.workflows.<name>` holding `{ validateCommand, preValidateCommand, maxRemediations, review }`, kept separate from `orchestrator.agents.workflows.<name>` (which holds `{ default, phases }` agent selectors). Both maps key on the same workflow-name space (per Q1). | P1 | Keeps the agent-specific `AgentsConfigSchema` untouched; the two blocks compose without conflict. |
| FR-009 | Schema stays `.strict()`; unknown keys fail loudly at parse time. | P1 | |
| FR-010 | Built-in `review` default when unconfigured: `{ profile: 'standard', blockingSeverity: 'critical', failThenPass: false }` (per Q3). Each sub-field falls back independently. | P1 | `blockingSeverity: 'critical'` is the conservative baseline; `profile: 'standard'` is the general profile; `failThenPass` is opt-in. |
| FR-011 | This feature ships the resolver function(s) in `worker/config.ts` only. `maxRemediations`/`review` are **not** added to `WorkerContext` yet — that wiring lands with the consuming review/remediate phase (epic #1120), per Q4. | P1 | Avoids dead fields no code reads. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Round-trip (yaml → loader → worker config) for defaults | pass | Test: no `workflows` block → resolved values equal cluster defaults; `maxRemediations` equals workflow default (3/2). |
| SC-002 | Round-trip for repo-level override | pass | Test: repo-level `validateCommand` applies when no workflow-level value present. |
| SC-003 | Round-trip for workflow-level override | pass | Test: workflow-level `validateCommand`/`maxRemediations`/`review.*` win over repo-level and cluster default. |
| SC-004 | Invalid values rejected | pass | Test: `maxRemediations: -1`, unknown `review.profile`, unknown top-level key each throw at parse. |
| SC-005 | Non-breaking | pass | Test: config without the new block yields byte-identical worker config to pre-change behavior. |

## Clarifications

### Batch 1 — 2026-08-19

- **Q1 (top-level shape → A)**: The new per-workflow non-agent fields live in a
  **new sibling map** `orchestrator.workflows.<name>` holding `{ validateCommand,
  preValidateCommand, maxRemediations, review }`, kept separate from
  `orchestrator.agents.workflows.<name>`. See FR-008.
- **Q2 (repo-level tier → A)**: No repo-level tier for `review`/`maxRemediations` —
  they resolve workflow-level > built-in default only. Only
  `validateCommand`/`preValidateCommand` keep the three-tier chain. See FR-004.
- **Q3 (built-in defaults → A)**: Built-in `review` default `{ profile: 'standard',
  blockingSeverity: 'critical', failThenPass: false }`; `maxRemediations` fallback
  for non-feature/bugfix workflows → 3. See FR-002, FR-010.
- **Q4 (plumb-through target → A)**: Ship resolver function(s) in `worker/config.ts`
  only; do **not** add `maxRemediations`/`review` to `WorkerContext` yet. See FR-011.

## Assumptions

- Precedence and independent-field resolution follow the established pattern in
  `resolveAgentForPhase` (`worker/config.ts:283-302`).
- `speckit-feature` and `speckit-bugfix` are the two named workflows in scope; the
  `z.record` keeps the map open to future workflow names.

## Out of Scope

- Implementing the review/remediate *phases* themselves (that is the rest of epic
  #1120) — this feature only ships the **config surface** and its plumb-through.
- Cluster-level defaults for `maxRemediations`/`review` beyond the hardcoded
  per-workflow constants.
- Changing the existing `orchestrator.agents` block behavior.

---

*Generated by speckit*
