# Research: Route-aware session invalidation + transition logging

## Decision 1 — Where the route-change check lives

**Decision**: A standalone `if (currentRoute !== undefined && currentRoute !== nextRoute)`
block inserted between the existing provider-switch block (`phase-loop.ts:780-786`)
and the model-transition block (`:788-803`), with its own `currentRoute` tracker.

**Rationale**: The three checks (provider, route, model) are independent facts with
independent log lines (Q2→A mandates both provider-switch AND route-transition lines
on a simultaneous change). Folding route into the provider check would either suppress
one of the two lines or force a compound condition that obscures which axis changed.
`currentSessionId = undefined` is idempotent, so ordering between the provider and
route blocks doesn't matter for session semantics — the session is dropped once by
construction.

**Alternatives considered**:
- *Tuple tracker* `currentKey = `${provider}:${route}`` with a single comparison —
  rejected: loses the ability to emit distinct provider-switch vs route-transition
  lines, and the existing provider block would have to be rewritten (FR-004 forbids
  regressing existing lines).
- *Suppress `agent.model.transition` when a route transition fires* — rejected: a
  same-provider route flip is inherently a model change; both lines are diagnostically
  true, and the spec never asks for suppression. Suppression would also complicate the
  `:793-803` condition, risking SC-003.

## Decision 2 — First-phase (`undefined → route`) semantics

**Decision**: Mirror the model-transition rule — no transition line, no session drop;
the tracker just initializes post-spawn (Q3→A).

**Rationale**: `phase-loop.ts:788-798` already established that `undefined → X` is
initialization, not transition. Diverging for routes would emit a spurious first-phase
line on every run and break SC-003's byte-identical subscription-only guarantee.

**Alternative considered**: log with `prevRoute: undefined` for a complete transcript —
rejected by clarification Q3 (breaks SC-003).

## Decision 3 — FR-006 log placement: extend the spawn-site log vs new event

**Decision**: Thread `route` through `CliSpawnOptions` and add it to the payload of
`CliSpawner.spawnPhase`'s existing "Spawning/Resuming Claude CLI session for phase"
log (`cli-spawner.ts:53-63`). No new event name, no change to the `:453` 'Starting
phase' line (Q5→A).

**Rationale**: The `:453` line fires for ALL phases (including validate/review/
remediate, which never spawn the CLI) and fires before `resolveAgentForPhase`, so the
route is not resolvable there. The spawn-site log is the single line adjacent to the
spawn that already carries `resumeSessionId` — putting route on the same line shows
resume state and backend together, which is exactly the debugging need US2 describes.

**Alternatives considered**:
- *Hoist route resolution before `:453` and extend 'Starting phase'* — rejected by
  clarification Q5 (restructures the phase preamble, risks behavior change on non-CLI
  phases, for a logging requirement).
- *New `agent.route.resolved` log event in phase-loop* — rejected: adds a second
  per-phase line where an additive field on an existing line suffices; SC-003 favors
  no extra lines.

## Decision 4 — Test seam: mock the plugin export

**Decision**: phase-loop unit tests partially mock
`@generacy-ai/generacy-plugin-claude-code` via `vi.mock` (real module + stubbed
`resolveRoute`), steering route values per model. Default stub returns
`'subscription'` for everything.

**Rationale**: #1199's contract is "react to a route change", not "classify models".
#1198 owns the classification rule; encoding real model→route mappings in orchestrator
tests would couple the suites and break when #1198's rule evolves. The
subscription-for-everything default doubles as the SC-003 regression assertion:
all existing phase-loop tests must stay green under it.

**Alternative considered**: use the real `resolveRoute` with carefully chosen model
strings — rejected: re-encodes #1198's rule as test fixtures; a rule change in the
plugin would falsely fail orchestrator tests.

## Decision 5 — Hard-block verification (Q4→A)

**Verified 2026-08-26 during /plan**: repo-wide grep for `resolveRoute` finds only
cluster-relay's unrelated path-prefix dispatcher helper
(`packages/cluster-relay/src/dispatcher.ts:19`). `packages/generacy-plugin-claude-code/src/index.ts`
exports no route helper. The #1198 export has NOT landed.

**Consequence**: planning artifacts may proceed (no code lands), but the implement
phase MUST pause/requeue until #1198 merges to develop, then rebase and re-verify:
(a) the `resolveRoute` export exists, (b) whether #1198 also exports a named route
type (prefer it over `ReturnType<typeof resolveRoute>` if so).

**Alternatives rejected by clarification Q4**: defining the signature in this issue
(second owner of the rule — decomposition drift #1201 exists to catch) and a
temporary orchestrator-side no-op resolver (silently classifies everything as
subscription; all tests pass while the feature does nothing).

## Decision 6 — Direct-caller route computation (FR-007)

**Decision**: Each of the four direct `agentLauncher.launch` callers computes
`const route = resolveRoute(model)` from its own already-resolved model and adds
`route` to its launch log payload. No session behavior changes.

**Rationale**: Route is derivable from the resolved model alone (the
`resolveRoute(model?)` signature), and each caller already has the resolved model in
hand at its log site. Threading route from a central resolver would add plumbing for
no benefit — these callers always start fresh sessions, so only the log line matters.

**Site notes**:
- `merge-conflict-handler.ts`'s `spawnAgentForConflict` has **no pre-launch info log
  today** (verified — only `warnIfEffortDropped` fires near the launch). FR-007 for
  it means adding a new `logger.info` line, not extending an existing one.
- The other three (`pr-feedback-handler.ts:895-898`, `review-executor.ts:241-244`,
  `remediate-executor.ts:108-120`) get `route` added to existing payloads.

## Sources

- Issue generacy-ai/generacy#1199 (feature) / #1197 (epic) / #1198 (resolveRoute owner)
- `specs/1199-context-claude-code-sessions/spec.md`, `clarifications.md`
- `packages/orchestrator/src/worker/phase-loop.ts` (:331-336, :453, :771-827)
- `packages/orchestrator/src/worker/cli-spawner.ts` (:53-63)
- `docs/llm-gateway-model-routing-plan.md` (generacy-ai/tetrad-development) — epic design
