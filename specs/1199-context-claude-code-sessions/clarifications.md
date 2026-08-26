# Clarifications: Route-aware session invalidation + transition logging

## Batch 1 — 2026-08-26

### Q1: Route identity and equality semantics
**Context**: FR-001/FR-002/FR-003 hinge on detecting "the route changed", but the spec never defines what a route *value* is. `resolveRoute` is owned by the sibling plugin issue and has not landed yet, so its return shape is unconfirmed. If it returns a structured object (e.g., `{ kind: 'gateway', baseUrl, ... }`), naive `!==` comparison would treat every phase as a route change and drop the session every time — silently destroying resume behavior while all tests that use a shared literal still pass.
**Question**: How should the orchestrator compare routes across phases?
**Options**:
- A: `resolveRoute` returns (or is required to return) an opaque canonical string identifier (e.g., `subscription` / `gateway:<name>`); orchestrator compares with strict string equality and logs that string verbatim.
- B: `resolveRoute` returns a structured object that exposes a canonical key field (e.g., `route.key: string`); orchestrator compares and logs only the key.
- C: Orchestrator serializes the returned value itself (e.g., stable JSON) for comparison and logging.

**Answer**: *Pending*

### Q2: Simultaneous provider + route change — which lines fire?
**Context**: The existing provider-switch drop (`phase-loop.ts:780-786`) logs its own line and clears the session. A provider change will almost always also be a route change (different provider = different config-dir boundary). The `agent.model.transition` line deliberately fires only on *same-provider* changes; the spec doesn't say whether `agent.route.transition` mirrors that scoping or fires on any route change including provider switches — which determines whether transcripts show one or two transition lines for a cross-provider hop.
**Question**: When provider and route change together between phases, what should be emitted?
**Options**:
- A: Both lines — the existing provider-switch line AND `agent.route.transition` (route transition fires on any route change; session dropped once).
- B: `agent.route.transition` only fires for same-provider route changes, mirroring `agent.model.transition`'s scoping; cross-provider hops keep only the existing provider-switch line.
- C: Unify — `agent.route.transition` becomes the single line for both cases (provider-switch line retired or subsumed).

**Answer**: *Pending*

### Q3: First-phase (undefined → route) transition semantics
**Context**: On the first CLI phase of a run, `currentRoute` is `undefined`. The existing model-transition logic explicitly does NOT treat `undefined → X` as a transition (`phase-loop.ts:788-798` — "the config just started naming a model"). The spec doesn't state whether route tracking follows the same rule. If `undefined → route` counted as a change, every run's first phase would emit a spurious `agent.route.transition` and (worse) FR-002 could drop a session that doesn't exist yet — harmless — but SC-003's byte-identical subscription-only guarantee would break on the extra log line.
**Question**: Does the first observed route (undefined → X) count as a route change?
**Options**:
- A: No — mirror the model-transition rule: no transition line and no session drop when `currentRoute` is `undefined`; trackers just initialize. (Preserves SC-003 byte-identical behavior.)
- B: Yes — log `agent.route.transition` with `prevRoute: undefined` on the first phase for a complete transcript.

**Answer**: *Pending*

### Q4: Dependency handling — `resolveRoute` has not landed
**Context**: A repo-wide grep confirms `@generacy-ai/generacy-plugin-claude-code` currently exports no `resolveRoute` (the only matches are cluster-relay's unrelated dispatcher helper). The spec says this issue is "dependency-blocked" if the sibling lands later — which is the current reality. The implement phase needs a concrete instruction for this state.
**Question**: What should implementation do while the plugin export is absent?
**Options**:
- A: Hard-block — pause/requeue this issue until the sibling plugin issue merges to develop; no code lands beforehand.
- B: Implement now against an agreed interface: define the `resolveRoute` signature/type in the plugin as part of THIS issue (a minimal subscription-only default implementation), letting the sibling issue fill in gateway logic later.
- C: Implement orchestrator-side with a temporary local no-op resolver behind the same import path, swapped when the sibling lands (violates the "consume from plugin" rule temporarily).

**Answer**: *Pending*

### Q5: FR-006 phase-start log placement
**Context**: The existing `'Starting phase'` log (`phase-loop.ts:453`) fires for ALL phases (including validate/review/remediate, which never spawn the CLI) and fires *before* `resolveAgentForPhase` runs (`:771`), so the route is not yet resolvable there. FR-006 says the phase-start log includes the route "for CLI phases". Satisfying it at `:453` requires hoisting resolution earlier for CLI phases only; satisfying it at the spawn site means the route appears in a different (or new) log line than the one currently named "phase-start".
**Question**: Where should the resolved route appear for FR-006?
**Options**:
- A: In a log line at the CLI spawn site, after provider/model/route resolution (e.g., extend or add a line adjacent to the spawn at `:807`); the `:453` 'Starting phase' line is unchanged.
- B: Hoist route resolution before `:453` and extend the existing 'Starting phase' line with `route` for CLI phases (field absent for non-CLI phases).

**Answer**: *Pending*
