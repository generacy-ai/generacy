# Clarifications — #690 Generic `phase:after` Extension Hook

## Batch 1 — 2026-05-22

### Q1: PhaseAfterContext Shape
**Context**: FR-001 says context includes "phase result, workflow state, logger, abort signal" but these are not mapped to concrete types. The phase loop has several objects available at the handler insertion point: the `PhaseLoopContext` (workdir, config, PR URL, item, signal), the CLI spawn result, and the commit/push result (`{ prUrl, hasChanges }`). The type surface of `PhaseAfterContext` directly determines what handlers can do.
**Question**: Should `PhaseAfterContext` expose the full `PhaseLoopContext` object (giving handlers access to workdir, config, item, signal, prUrl) plus the phase name, or should it be a minimal subset with only the fields listed in the spec?
**Options**:
- A: Full `PhaseLoopContext` + phase name (maximum flexibility for future handlers)
- B: Minimal subset — only phase name, phase exit code/success, logger, abort signal (tighter API surface)

**Answer**: A — Full `PhaseLoopContext` + phase name. This is an internal extension point, not an external plugin API — minimal-surface reasoning that applies to public APIs is overkill here. The first consumer (#691) already needs workdir, config, item, signal, and prUrl; restricting the surface and re-widening it every time a new handler shows up is more churn than starting open. Handlers that don't use most fields just don't reach for them.

### Q2: Commit/Push Result in Context
**Context**: The `commitPushAndEnsurePr()` call returns `{ prUrl?: string, hasChanges: boolean }` immediately before the handler insertion point. The multi-repo fan-out handler (Issue E) will likely need the `prUrl` to reference the primary repo's PR. If not included in the context, Issue E would need to read it from `PhaseLoopContext` (if exposed) or reconstruct it.
**Question**: Should `PhaseAfterContext` include the commit/push result (`prUrl` and `hasChanges`) as explicit fields?
**Options**:
- A: Yes, include `commitResult: { prUrl?: string; hasChanges: boolean }` (Recommended)
- B: No, handlers can access prUrl through the workflow context if needed

**Answer**: A — Include `commitResult: { prUrl?, hasChanges }` explicitly. Even with full context from Q1, this remains useful: `hasChanges` lets handlers short-circuit cleanly when the just-finished phase produced no primary-repo changes (likely correlates with no sibling changes either). And `prUrl` returned from `commitPushAndEnsurePr()` is semantically "the prUrl as of this commit step" — distinct from any pre-existing field on the broader context, and the value handlers actually want.

### Q3: Multiple Handler Failure Semantics
**Context**: FR-004 says "any throw blocks the phase and prevents gate check." With multiple handlers executing sequentially, if handler A throws, should handler B still run? The spec says "registration order" but doesn't clarify fail-fast vs run-all-then-report semantics. This affects whether handlers need to be defensive about partial prior-handler state.
**Question**: When multiple `phaseAfterHandlers` are registered and one throws, should execution be fail-fast (skip remaining handlers) or run-all (execute all handlers, then fail if any threw)?
**Options**:
- A: Fail-fast — stop on first error, skip remaining handlers (Recommended)
- B: Run-all — execute every handler, aggregate errors, fail at end

**Answer**: A — Fail-fast. Handlers execute sequentially in registration order and may produce side effects (commits, pushes, PR creates). Running subsequent handlers after one has thrown produces confusing partial state where a downstream handler could see inconsistent prior work. Run-all aggregation makes sense for independent validators, not for side-effecting handlers like our fan-out case. If we ever add validation-style handlers later, they can run in their own pre-phase pass.
