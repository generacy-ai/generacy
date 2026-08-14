# Clarifications

## Batch 1 — 2026-08-14

### Q1: Merge-conflict PR-without-workflow fallback
**Context**: Assumption 4 binds `merge-conflict-handler` to "the `implement` phase of the workflow that owns the enclosing PR" and defers confirmation to `/plan`. Spec is silent on the case where the enclosing PR has no `workflow:*` label (e.g., a manually opened PR, a PR whose label was cleared, or a PR predating the workflow label convention). FR-010 also requires spawn parity when `agents` is unset, so the fallback must not accidentally invent a `--model` when no config exists.
**Question**: When `merge-conflict-handler` runs against a PR that has no resolvable workflow, how should it resolve `{provider, model, effort}`?
**Options**:
- A: Default to `speckit-feature`'s `implement` phase entry (the primary workflow).
- B: Skip agent resolution entirely and use container CLI ambient default (matches today's behavior, preserves FR-010 parity for un-labeled PRs).
- C: Fail loudly — log a warning and refuse to spawn the fixer.
- D: Try each configured workflow in `agents.workflows.*` in registration order and use the first that resolves.

**Answer**: *Pending*

### Q2: Effort enum: schema-stable vs research-driven
**Context**: FR-001 fixes the enum as `low | medium | high | xhigh | max`. FR-006 says `/plan` researches the installed Claude CLI's supported effort mechanism. If the CLI accepts a different vocabulary (e.g., only `low | medium | high`, or a numeric budget), the schema enum and CLI mechanism will disagree. This affects whether operators can trust `effort: xhigh` to do anything, and whether the schema should be tightened after research completes.
**Question**: Which enum should the `AgentEntrySchema.effort` field ultimately accept?
**Options**:
- A: Exactly `low | medium | high | xhigh | max` as specified, regardless of CLI vocabulary. Values the CLI does not recognize become validated no-ops (schema is stable; providers translate what they can).
- B: `/plan` cross-references CLI vocabulary and narrows the enum to exactly what the current CLI accepts (schema mirrors reality; unsupported values become schema errors).
- C: Superset: spec enum ∪ any additional values the CLI accepts (maximum operator flexibility, but permits values one provider supports and another does not).

**Answer**: *Pending*

### Q3: Missing CLI mechanism operator feedback
**Context**: FR-006 branch (b): if the CLI exposes no effort mechanism, the field becomes "a validated no-op ready for future CLI support." SC-004 requires byte-identical spawn argv/env when `effort` is unset — but is silent on the case where `effort` IS set but the CLI has no mechanism. Silent no-op means an operator writes `effort: high` and observes no change in agent behavior, with no signal that it was ignored.
**Question**: When `effort` is set in config but the launch plugin's research (FR-006) determined the CLI has no delivery mechanism, how should the system tell the operator?
**Options**:
- A: Silent no-op — schema validates, spawn ignores field, no user feedback anywhere.
- B: `generacy validate` emits a warning naming `effort` and the unsupported provider.
- C: Warn once per spawn in orchestrator logs when a set `effort` is dropped.
- D: Both B (validate-time) and C (spawn-time).

**Answer**: *Pending*

### Q4: Strict-mode scope on CLI schema
**Context**: FR-011 / SC-006 require `generacy validate` to reject unknown keys under `agents`, `workflows.*`, `phases.*`, and entries. Assumption 7 notes the CLI schema in `packages/generacy/src/config/schema.ts` may or may not currently be `.strict()`. Applying strict mode narrowly to the `agents` sub-tree fixes the reported silent-strip bug but leaves typos elsewhere silent; applying it schema-wide is stricter but may reject configs that were previously accepted.
**Question**: What is the intended blast radius of the strict-mode change?
**Options**:
- A: Apply `.strict()` only to the `orchestrator.agents` sub-tree and its descendants (minimal blast radius; existing typos outside the block continue to be silently stripped).
- B: Apply `.strict()` to the entire CLI authoring schema (strictest; may reject existing configs elsewhere — acceptable one-time break to catch all typos).
- C: Preserve whatever mode each parent already uses; only enforce strict on the newly added `agents` sub-tree (safest for backward compat).

**Answer**: *Pending*
