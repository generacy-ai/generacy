# Feature Specification: Route-aware session invalidation + transition logging

**Branch**: `1199-context-claude-code-sessions` | **Date**: 2026-08-26 | **Status**: Draft

## Summary

Claude Code CLI sessions live inside a provider's config directory, so a resumed
session (`--resume <sessionId>`) is only valid within the config-dir boundary
that created it. `phase-loop.ts` already drops the tracked `currentSessionId`
when the **provider** changes between phases (FR-011). The LLM gateway model
routing epic (#1197) introduces a second axis — a **route** (subscription ⇄
gateway) — that crosses the same config-dir boundary even when the provider name
is unchanged. Without route-awareness, a route change would leave a stale
`currentSessionId` in place and the next phase's `--resume` would fail against a
session the new route's backend never created.

This feature extends the cross-phase session-invalidation check from keying on
`provider` alone to keying on the tuple `(provider, route)`, drops the session on
any route change, and adds structured `agent.route.transition` logging. It also
surfaces the resolved route in the phase-start log and in the direct
`agentLauncher.launch` callers' log lines so transcripts show which backend
served each phase.

## Context (from issue #1199)

- `packages/orchestrator/src/worker/phase-loop.ts:777-786` drops the CLI session
  on provider switch. `:793-803` emits `agent.model.transition` on a same-provider
  model change. Session/provider/model trackers: `currentSessionId`,
  `currentProvider`, `currentModel` (declared `:331-336`).
- `resolveRoute` is a public export of `@generacy-ai/generacy-plugin-claude-code`
  (delivered by the sibling plugin issue in epic #1197). The orchestrator already
  depends on this plugin (`packages/orchestrator/package.json:45`). The route rule
  MUST be consumed from the plugin — not reimplemented in the orchestrator — and
  the plugin MUST NOT import orchestrator types (dependency direction:
  orchestrator → plugin).
- Direct `agentLauncher.launch` callers start fresh sessions already and need only
  the route added to their launch log lines: `pr-feedback-handler.ts:883-925`,
  `merge-conflict-handler.ts:766-810`, `review-executor.ts:228-266`,
  `remediate-executor.ts:95-137`.

Part of epic generacy-ai/generacy#1197 (LLM gateway model routing). Full design:
`docs/llm-gateway-model-routing-plan.md` in generacy-ai/tetrad-development.

## Clarifications

### Session 2026-08-26 (Batch 1 — answers accepted from issue comments)

- Q1 → A: Route values are opaque canonical strings. generacy#1198 pins the
  contract as `resolveRoute(model?: string): 'subscription' | 'gateway'` — a
  two-member string union. The orchestrator compares with strict `===` and logs
  the string verbatim.
- Q2 → A: On a simultaneous provider + route change, emit BOTH the existing
  provider-switch line AND `agent.route.transition`; the session is dropped once.
- Q3 → A: `undefined → <route>` on the first CLI phase is NOT a transition — no
  `agent.route.transition` line, no session drop; trackers just initialize
  (mirrors the model-transition rule at `phase-loop.ts:788-798`, preserves SC-003).
- Q4 → A: Hard-block — this issue pauses/requeues until generacy#1198 (owner of
  the `resolveRoute` export) merges to develop; no code lands beforehand. P1
  serializes as #1198 → (#1199, #1200) → #1201.
- Q5 → A: FR-006's route appears in a log line at the CLI spawn site (adjacent to
  the spawn at `:807`), after provider/model/route resolution. The `:453`
  'Starting phase' line is unchanged.

## User Stories

### US1: Session survives valid resumes, drops on route change

**As a** cluster operator running a multi-phase speckit workflow,
**I want** the CLI session dropped whenever a phase resolves to a different route
(even for the same provider),
**So that** the next phase never attempts `--resume` against a session the new
route's backend cannot see, and phases silently start fresh instead of failing.

**Acceptance Criteria**:
- [ ] Same provider, model `claude-opus-4-8` → `openrouter/a/b` (route flips
      `subscription` → `gateway`) drops `currentSessionId` and logs
      `agent.route.transition`.
- [ ] Same provider, `claude-opus-4-8` → `claude-sonnet-5` on the **same** route
      keeps the session and logs `agent.model.transition` (existing behavior).
- [ ] When every phase resolves to the subscription route, there is no behavior
      change vs. today.

### US2: Transcripts show which backend served each phase

**As an** engineer debugging a run from logs,
**I want** the resolved route recorded in the phase-start log and in every direct
launch caller's log line,
**So that** I can tell from the transcript which backend (subscription or gateway)
served a given phase without reconstructing routing from config.

**Acceptance Criteria**:
- [ ] The phase-start log includes the resolved route for CLI phases.
- [ ] `agent.route.transition` carries `{phase, prevRoute, nextRoute, prevModel, nextModel}`.
- [ ] Each of the four direct launch callers includes the route in its launch log line.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Extend the cross-phase invalidation check in `phase-loop.ts` from `provider` to the tuple `(provider, route)`; track `currentRoute` alongside `currentProvider`/`currentModel`. | P1 | Route values are canonical strings (`'subscription' \| 'gateway'` per #1198); compare with strict `===` (Q1→A). Update trackers post-spawn like `currentProvider`/`currentModel`. `undefined → X` initializes, no drop (Q3→A). |
| FR-002 | Drop `currentSessionId` when the route changes between phases, regardless of provider. | P1 | Same semantics as the existing provider-switch drop. On simultaneous provider + route change, the session is dropped once (Q2→A). |
| FR-003 | Emit `agent.route.transition` with `{phase, prevRoute, nextRoute, prevModel, nextModel}` on a route change. | P1 | Fires on ANY route change, including cross-provider hops — both the provider-switch line and this line appear (Q2→A). Not emitted for `undefined → X` (Q3→A). Route strings logged verbatim (Q1→A). |
| FR-004 | Preserve the existing `agent.model.transition` line for same-route, same-provider model changes. | P1 | No regression to `:793-803`. |
| FR-005 | Resolve the route via `resolveRoute` imported from `@generacy-ai/generacy-plugin-claude-code`'s public export; do not duplicate the rule in the orchestrator. | P1 | Plugin must not import orchestrator types. |
| FR-006 | Include the resolved route in a log line at the CLI spawn site for CLI phases. | P2 | Q5→A: extend or add a line adjacent to the spawn at `:807`, after provider/model/route resolution; the `:453` 'Starting phase' line is unchanged. |
| FR-007 | Add the resolved route to the launch log lines of the four direct `agentLauncher.launch` callers; do not change their session behavior. | P2 | They already start fresh sessions. |
| FR-008 | No behavior change when every phase resolves to the subscription (default) route. | P1 | Backward-compatibility guarantee. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | phase-loop route-change test | Session dropped + `agent.route.transition` logged | Unit test: same provider, `claude-opus-4-8` → `openrouter/a/b`. |
| SC-002 | phase-loop same-route model-change test | Session kept + `agent.model.transition` logged | Unit test: `claude-opus-4-8` → `claude-sonnet-5`, same route. |
| SC-003 | Subscription-only regression | Byte-identical behavior to pre-change | Existing phase-loop tests remain green with all phases on subscription route. |
| SC-004 | Build + tests | Green | `pnpm -r build` and full test suite pass. |

## Assumptions

- `resolveRoute` is available as a stable public export of
  `@generacy-ai/generacy-plugin-claude-code` before this issue lands (delivered by
  generacy#1198 in epic #1197). Q4→A: this issue is HARD-BLOCKED until #1198
  merges to develop — no code lands beforehand (verified 2026-08-26: the export
  is still absent). P1 serializes as #1198 → (#1199, #1200) → #1201.
- The subscription route is the default/no-op route; a run with no gateway
  configuration resolves every phase to it.
- "Route" is derivable from the same inputs already available at the phase-loop
  spawn site (config + resolved provider/model for the phase).

## Out of Scope

- Implementing or defining `resolveRoute` itself (sibling plugin issue).
- Any change to session persistence, the `--resume` mechanism, or the direct
  callers' session-freshness behavior.
- Gateway authentication, credential wiring, or routing-rule configuration
  (covered elsewhere in epic #1197).

---

*Generated by speckit*
