# Clarifications

## Batch 1 — 2026-08-19

### Q1: Top-level config shape (FR-008)
**Context**: FR-008 explicitly defers the top-level shape. The two candidates
change the schema surface, the loader parse target, and every test fixture.
**Question**: Where do the new per-workflow non-agent fields (`validateCommand`,
`preValidateCommand`, `maxRemediations`, `review`) live in `.generacy/config.yaml`?
**Options**:
- A: New sibling map `orchestrator.workflows.<name>` holding `{ validateCommand,
  preValidateCommand, maxRemediations, review }`, kept separate from
  `orchestrator.agents.workflows.<name>` (spec's leading candidate).
- B: Fold the non-agent fields into `orchestrator.agents.workflows.<name>`
  alongside the existing `{ default, phases }` agent selectors.

**Answer**: A — New sibling map `orchestrator.workflows.<name>` holding
`{ validateCommand, preValidateCommand, maxRemediations, review }`, kept separate
from `orchestrator.agents.workflows.<name>`. The already-shipped
`AgentsConfigSchema` is agent-specific (`{ default, phases }`); folding non-agent
fields into it (B) would blur two concerns and rework a strict, shipped schema.
Both maps key on the same workflow-name space and compose cleanly.

### Q2: Repo-level tier for `review` and `maxRemediations` (FR-004 vs FR-001)
**Context**: FR-004's precedence chain is "workflow-level > repo-level > cluster
default" and names `review.*`. But FR-001/FR-003 only define `review` and
`maxRemediations` *under* `WorkflowOverride` — there is no repo-level
`orchestrator.review` / `orchestrator.maxRemediations` sibling defined. Today only
`validateCommand`/`preValidateCommand` exist at repo level.
**Question**: Do `review` and `maxRemediations` also get a repo-level tier?
**Options**:
- A: No repo tier — `review` and `maxRemediations` are workflow-level only. Only
  `validateCommand`/`preValidateCommand` keep the existing repo-level tier
  (workflow > repo > cluster). `review`/`maxRemediations` resolve
  workflow-level > built-in default only.
- B: Add repo-level `orchestrator.review` and `orchestrator.maxRemediations`
  sibling fields too, so the full three-tier chain applies to all four fields.

**Answer**: A — No repo tier. Only `validateCommand`/`preValidateCommand` keep the
existing repo-level tier (workflow > repo > cluster). `review`/`maxRemediations`
resolve workflow-level > built-in default only. FR-001/FR-003 define `review` and
`maxRemediations` only under `WorkflowOverride`, and the design's config sketch
shows them only under `workflows.<name>`; option B adds schema surface, an extra
tier, and fixtures the design never calls for.

### Q3: Built-in defaults for `review.*` and `maxRemediations` fallback
**Context**: Out of Scope excludes cluster-level defaults for `review`, and
`WorkerConfig` has no `review` field. So when nothing is configured, resolution
needs built-in constants. `maxRemediations` defaults are given (feature 3, bugfix 2)
but not the fallback for other workflow names, nor any `review` defaults.
**Question**: What are the built-in defaults when unconfigured?
**Options**:
- A: `review` → `{ profile: 'standard', blockingSeverity: 'critical',
  failThenPass: false }`; `maxRemediations` fallback for non-feature/bugfix
  workflows → 3 (feature's value).
- B: Provide different built-in `review` defaults / a different maxRemediations
  fallback (specify in answer).

**Answer**: A — Built-in `review` default `{ profile: 'standard',
blockingSeverity: 'critical', failThenPass: false }`; `maxRemediations` fallback
for non-feature/bugfix workflows → 3 (feature's value). `blockingSeverity: critical`
is the conservative baseline (the feature config sets `major` as an explicit
override), `profile: standard` is the general profile vs bugfix-specific
`verification`, and `failThenPass` is opt-in (default false).

### Q4: Plumb-through target for `maxRemediations`/`review` (FR-007)
**Context**: The consuming review/remediate phases are Out of Scope (epic #1120).
`WorkerConfig`/`WorkerContext` today have no `maxRemediations` or `review` field.
FR-007 says "plumb the resolved values to the phase that consumes them, mirroring
`agents: effectiveConfig.agents`", but that phase does not exist yet.
**Question**: How far does this feature carry the resolved values?
**Options**:
- A: Ship resolver function(s) in `worker/config.ts` (sibling to
  `resolveAgentForPhase`) returning the resolved `{ validateCommand,
  preValidateCommand, maxRemediations, review }` for a workflow name, tested via
  SC-001..SC-005. Do NOT add `maxRemediations`/`review` to `WorkerContext` yet —
  wiring lands with the consuming phase.
- B: Also add the resolved `maxRemediations`/`review` to `WorkerContext` now
  (even though no phase reads them yet), mirroring the `agents` plumb-through.

**Answer**: A — Ship resolver function(s) in `worker/config.ts` (sibling to
`resolveAgentForPhase`) returning the resolved `{ validateCommand,
preValidateCommand, maxRemediations, review }` for a workflow name, tested via
SC-001..SC-005. Do NOT add `maxRemediations`/`review` to `WorkerContext` yet —
the consuming review/remediate phases are out of scope (epic #1120), so wiring
them now creates dead fields no code reads. WorkerContext wiring lands with the
consuming phase.
