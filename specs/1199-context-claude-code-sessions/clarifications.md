# Clarifications: Route-aware session invalidation + transition logging

## Batch 1 — 2026-08-26

### Q1: Route identity and equality semantics
**Context**: FR-001/FR-002/FR-003 hinge on detecting "the route changed", but the spec never defines what a route *value* is. `resolveRoute` is owned by the sibling plugin issue and has not landed yet, so its return shape is unconfirmed. If it returns a structured object (e.g., `{ kind: 'gateway', baseUrl, ... }`), naive `!==` comparison would treat every phase as a route change and drop the session every time — silently destroying resume behavior while all tests that use a shared literal still pass.
**Question**: How should the orchestrator compare routes across phases?
**Options**:
- A: `resolveRoute` returns (or is required to return) an opaque canonical string identifier (e.g., `subscription` / `gateway:<name>`); orchestrator compares with strict string equality and logs that string verbatim.
- B: `resolveRoute` returns a structured object that exposes a canonical key field (e.g., `route.key: string`); orchestrator compares and logs only the key.
- C: Orchestrator serializes the returned value itself (e.g., stable JSON) for comparison and logging.

**Answer**: A — `resolveRoute` returns an opaque canonical string identifier; the orchestrator compares with strict string equality and logs that string verbatim. generacy#1198 already pins the contract as `resolveRoute(model?: string): 'subscription' | 'gateway'` — a two-member string union, so `===` is correct and the logged value is the string itself. Options B and C presuppose a structured return the owning issue does not produce.

### Q2: Simultaneous provider + route change — which lines fire?
**Context**: The existing provider-switch drop (`phase-loop.ts:780-786`) logs its own line and clears the session. A provider change will almost always also be a route change (different provider = different config-dir boundary). The `agent.model.transition` line deliberately fires only on *same-provider* changes; the spec doesn't say whether `agent.route.transition` mirrors that scoping or fires on any route change including provider switches — which determines whether transcripts show one or two transition lines for a cross-provider hop.
**Question**: When provider and route change together between phases, what should be emitted?
**Options**:
- A: Both lines — the existing provider-switch line AND `agent.route.transition` (route transition fires on any route change; session dropped once).
- B: `agent.route.transition` only fires for same-provider route changes, mirroring `agent.model.transition`'s scoping; cross-provider hops keep only the existing provider-switch line.
- C: Unify — `agent.route.transition` becomes the single line for both cases (provider-switch line retired or subsumed).

**Answer**: A — emit both lines: the existing provider-switch line AND `agent.route.transition`; the session is dropped once. Provider-change and route-change are independent facts and both are diagnostically useful; a cross-provider hop that is also a config-dir hop should say so. Option B loses the route signal exactly where it matters most. Option C retires a line existing transcripts and log-greps depend on.

### Q3: First-phase (undefined → route) transition semantics
**Context**: On the first CLI phase of a run, `currentRoute` is `undefined`. The existing model-transition logic explicitly does NOT treat `undefined → X` as a transition (`phase-loop.ts:788-798` — "the config just started naming a model"). The spec doesn't state whether route tracking follows the same rule. If `undefined → route` counted as a change, every run's first phase would emit a spurious `agent.route.transition` and (worse) FR-002 could drop a session that doesn't exist yet — harmless — but SC-003's byte-identical subscription-only guarantee would break on the extra log line.
**Question**: Does the first observed route (undefined → X) count as a route change?
**Options**:
- A: No — mirror the model-transition rule: no transition line and no session drop when `currentRoute` is `undefined`; trackers just initialize. (Preserves SC-003 byte-identical behavior.)
- B: Yes — log `agent.route.transition` with `prevRoute: undefined` on the first phase for a complete transcript.

**Answer**: A — no. Mirror the model-transition rule: no transition line and no session drop when `currentRoute` is `undefined`; the trackers just initialize. SC-003's byte-identical subscription-only guarantee underpins the epic's "flag-free by construction" claim, and an extra first-phase log line breaks it. `phase-loop.ts:788-798` already established this rule for models; diverging for routes would be a gratuitous inconsistency.

### Q4: Dependency handling — `resolveRoute` has not landed
**Context**: A repo-wide grep confirms `@generacy-ai/generacy-plugin-claude-code` currently exports no `resolveRoute` (the only matches are cluster-relay's unrelated dispatcher helper). The spec says this issue is "dependency-blocked" if the sibling lands later — which is the current reality. The implement phase needs a concrete instruction for this state.
**Question**: What should implementation do while the plugin export is absent?
**Options**:
- A: Hard-block — pause/requeue this issue until the sibling plugin issue merges to develop; no code lands beforehand.
- B: Implement now against an agreed interface: define the `resolveRoute` signature/type in the plugin as part of THIS issue (a minimal subscription-only default implementation), letting the sibling issue fill in gateway logic later.
- C: Implement orchestrator-side with a temporary local no-op resolver behind the same import path, swapped when the sibling lands (violates the "consume from plugin" rule temporarily).

**Answer**: A — hard-block. Pause/requeue this issue until generacy#1198 merges to develop; no code lands beforehand. generacy#1198 is the declared owner of the `resolveRoute` export and is queued in the same phase. Option B would make this issue a second owner of the route rule — exactly the parallel-decomposition drift the P1 integration issue (#1201) exists to catch. Option C lands a resolver that silently classifies everything as `subscription`, so every test passes while the feature does nothing. Accepted consequence: P1 serializes as #1198 → (#1199, #1200) → #1201.

### Q5: FR-006 phase-start log placement
**Context**: The existing `'Starting phase'` log (`phase-loop.ts:453`) fires for ALL phases (including validate/review/remediate, which never spawn the CLI) and fires *before* `resolveAgentForPhase` runs (`:771`), so the route is not yet resolvable there. FR-006 says the phase-start log includes the route "for CLI phases". Satisfying it at `:453` requires hoisting resolution earlier for CLI phases only; satisfying it at the spawn site means the route appears in a different (or new) log line than the one currently named "phase-start".
**Question**: Where should the resolved route appear for FR-006?
**Options**:
- A: In a log line at the CLI spawn site, after provider/model/route resolution (e.g., extend or add a line adjacent to the spawn at `:807`); the `:453` 'Starting phase' line is unchanged.
- B: Hoist route resolution before `:453` and extend the existing 'Starting phase' line with `route` for CLI phases (field absent for non-CLI phases).

**Answer**: A — put the resolved route in a log line at the CLI spawn site, after provider/model/route resolution (extend or add a line adjacent to the spawn at `:807`). The `:453` 'Starting phase' line is unchanged. `'Starting phase'` at `:453` fires for validate/review/remediate too — phases that never spawn a CLI and have no route. Option B requires hoisting `resolveAgentForPhase` (`:771`) above `:453` for CLI phases only, restructuring the phase preamble and risking behavior change on non-CLI phases, to satisfy a logging requirement. Option A puts the route where the route is actually known.
