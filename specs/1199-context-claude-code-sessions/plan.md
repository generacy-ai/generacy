# Implementation Plan: Route-aware session invalidation + transition logging

**Feature**: Extend cross-phase CLI session invalidation from `provider` to the tuple `(provider, route)`, add `agent.route.transition` logging, and surface the resolved route in spawn-site and direct-caller log lines
**Branch**: `1199-context-claude-code-sessions`
**Status**: Complete

## Summary

`phase-loop.ts` drops the tracked `currentSessionId` when the **provider** changes
between phases (`phase-loop.ts:777-786`). Epic #1197 introduces a second axis —
a **route** (`'subscription' | 'gateway'`) — that crosses the same config-dir
boundary even when the provider name is unchanged. This feature:

1. Tracks `currentRoute` alongside `currentProvider`/`currentModel` and drops the
   session on any route change (FR-001/FR-002).
2. Emits `agent.route.transition` `{phase, prevRoute, nextRoute, prevModel, nextModel}`
   on any route change, including cross-provider hops (FR-003, Q2→A).
3. Surfaces the resolved route in the spawn-site log line (FR-006, Q5→A) and in
   the four direct `agentLauncher.launch` callers' launch log lines (FR-007).
4. Consumes `resolveRoute` from `@generacy-ai/generacy-plugin-claude-code` — the
   rule is never reimplemented orchestrator-side (FR-005).

**⚠ HARD-BLOCK (Q4→A)**: implementation MUST NOT land until generacy#1198 (owner
of the `resolveRoute` export) merges to `develop`. Verified 2026-08-26 during
/plan: the export is still absent — the only `resolveRoute` in the repo is
cluster-relay's unrelated dispatcher helper (`packages/cluster-relay/src/dispatcher.ts:19`).
The implement phase must pause/requeue until #1198 lands, then rebase and bind
against the real export. P1 serializes as #1198 → (#1199, #1200) → #1201.

## Technical Context

- **Language/runtime**: TypeScript (ESM), Node >= 22, Vitest.
- **Packages touched**: `@generacy-ai/orchestrator` only. The plugin
  (`@generacy-ai/generacy-plugin-claude-code`) is consumed, not modified —
  dependency direction stays orchestrator → plugin (FR-005). Orchestrator already
  depends on the plugin (`packages/orchestrator/package.json:45`).
- **Route contract (pinned by #1198, Q1→A)**:
  `resolveRoute(model?: string): 'subscription' | 'gateway'` — an opaque
  canonical string union. Compare with strict `===`; log verbatim. The
  orchestrator types the tracker as `ReturnType<typeof resolveRoute>` (or the
  named type if #1198 exports one — bind at implement time after rebase).
- **Route inputs**: route is derivable from the resolved model alone (the
  `resolveRoute(model?)` signature), so it is computed immediately after
  `resolveAgentForPhase` at the spawn site — no phase-preamble restructuring
  (Q5→A keeps the `:453` 'Starting phase' line unchanged).

## Design

### D-1: phase-loop tracker + invalidation block (FR-001/FR-002/FR-003/FR-004)

All line refs at develop as of this plan.

1. **Tracker** — declare `let currentRoute: ReturnType<typeof resolveRoute> | undefined;`
   next to `currentProvider`/`currentModel` (`phase-loop.ts:331-336`).
2. **Resolution** — after `resolveAgentForPhase` (`:771-775`):
   `const nextRoute = resolveRoute(nextModel);`
3. **Route-change check** — inserted AFTER the existing provider-switch block
   (`:780-786`, unchanged) and BEFORE the model-transition block (`:788-803`,
   unchanged):

   ```ts
   // Drop session on route change (#1199 FR-002). Sessions live inside a
   // route's config-dir boundary; a route flip (subscription ⇄ gateway)
   // crosses it even when the provider name is unchanged.
   if (currentRoute !== undefined && currentRoute !== nextRoute) {
     this.logger.info(
       { phase: cliPhase, prevRoute: currentRoute, nextRoute, prevModel: currentModel, nextModel },
       'agent.route.transition',
     );
     currentSessionId = undefined;
   }
   ```

   - `undefined → X` initializes only — no line, no drop (Q3→A, mirrors the
     model rule at `:788-798`).
   - Simultaneous provider + route change: both the provider-switch line and
     `agent.route.transition` fire; `currentSessionId = undefined` is
     idempotent, so the session is dropped once by construction (Q2→A).
   - `prevModel`/`nextModel` are read before the post-spawn tracker update, so
     they carry the correct prior/next values.
   - A same-provider route flip is inherently a model change, so the existing
     `agent.model.transition` line ALSO fires (`:793-803` condition is true).
     This is intentional — FR-004 preserves that line and the spec never asks
     to suppress it; both facts are diagnostically true.
4. **Post-spawn update** — `currentRoute = nextRoute;` alongside
   `currentProvider`/`currentModel` at `:826-827` (failures don't strand state).
5. `previousModel` computation (`:805`) and spawn options are otherwise
   unchanged apart from D-2's `route` field.

### D-2: spawn-site route log (FR-006, Q5→A)

Extend the existing spawn-site log rather than adding a new event name:

- `CliSpawnOptions` (`packages/orchestrator/src/worker/types.ts`) gains
  optional `route?: string`.
- phase-loop passes `route: nextRoute` in the `spawnPhase` options (`:807-823`).
- `CliSpawner.spawnPhase`'s existing "Spawning/Resuming Claude CLI session for
  phase" log (`cli-spawner.ts:53-63`) adds `route: options.route` to its
  payload. This is the log line adjacent to the spawn; the `:453` 'Starting
  phase' line is untouched.
- SC-003 note: subscription-only runs gain a `route: 'subscription'` field on
  this one line. That additive field is mandated by FR-006/US2; "byte-identical"
  in SC-003 is scoped (per Q3's rationale) to session semantics and the absence
  of extra transition *lines* — existing phase-loop tests must remain green.

### D-3: four direct callers (FR-007)

Each caller computes `const route = resolveRoute(model)` from its already-resolved
model and adds `route` to its launch log payload. **No session behavior changes**
(they already start fresh sessions).

| Caller | Site | Change |
|---|---|---|
| `pr-feedback-handler.ts` | `:895-898` 'Spawning Claude CLI for PR feedback' | add `route` to payload |
| `review-executor.ts` | `:241-244` 'Spawning Claude CLI for review phase' | add `route` to payload |
| `remediate-executor.ts` | `:108-120` 'Spawning Claude CLI for remediate phase' | add `route` to payload |
| `merge-conflict-handler.ts` | `spawnAgentForConflict` (`:766-812`) — **has no pre-launch info line today** | add a new `logger.info({ cwd, provider, model, effort, route }, 'MergeConflictHandler: spawning agent CLI for conflict resolution')` adjacent to the launch |

### D-4: test seam — mock the plugin export, don't re-encode the rule

phase-loop unit tests `vi.mock('@generacy-ai/generacy-plugin-claude-code')`
(partial mock: real module + stubbed `resolveRoute`) and steer route values per
model directly. This keeps #1199's tests independent of #1198's classification
rule — the orchestrator's contract is "react to a route change", not "classify
models". The default mock returns `'subscription'` for everything, which is
also how SC-003 (subscription-only regression) is asserted: all existing
phase-loop tests stay green under the default.

## Project Structure

```
packages/orchestrator/src/worker/
├── phase-loop.ts                    # MOD: currentRoute tracker, resolveRoute call,
│                                    #      route-change drop + agent.route.transition,
│                                    #      post-spawn tracker update, route in spawn opts
├── types.ts                         # MOD: CliSpawnOptions gains route?: string
├── cli-spawner.ts                   # MOD: route in the spawn-site log payload
├── pr-feedback-handler.ts           # MOD: route in launch log line
├── merge-conflict-handler.ts        # MOD: new launch log line incl. route
├── review-executor.ts               # MOD: route in launch log line
├── remediate-executor.ts            # MOD: route in launch log line
└── __tests__/
    ├── phase-loop.route-transition.test.ts   # NEW: SC-001/SC-002 + Q2/Q3 matrix
    └── (existing phase-loop suites)          # MOD only if spawn-log assertions
                                              # need the additive route field

.changeset/1199-route-aware-session-invalidation.md   # NEW: orchestrator patch
```

## Test Plan

`phase-loop.route-transition.test.ts` (NEW):
- **SC-001**: same provider, model `claude-opus-4-8` → `openrouter/a/b`, mocked
  route `subscription` → `gateway`: second spawn receives
  `resumeSessionId: undefined`; `agent.route.transition` logged with
  `{phase, prevRoute: 'subscription', nextRoute: 'gateway', prevModel, nextModel}`.
- **SC-002**: `claude-opus-4-8` → `claude-sonnet-5`, both `subscription`:
  session kept (second spawn resumes), `agent.model.transition` logged, NO
  `agent.route.transition`.
- **Q2→A**: provider A/`subscription` → provider B/`gateway`: provider-switch
  line AND `agent.route.transition` both logged; session dropped once.
- **Q3→A**: first CLI phase (`currentRoute` undefined): no transition line, no
  drop.
- **FR-006**: spawn-site log payload includes `route`.

Direct-caller suites: assert `route` present in each launch log payload
(and the new merge-conflict line exists); assert no change to launch options.

**SC-003**: existing phase-loop suites green with the default subscription-only
mock. **SC-004**: `pnpm -r build` + full test suite green.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo — check skipped.

## Dependencies & Sequencing

- **Blocked by**: generacy#1198 (`resolveRoute` export) — hard-block, no code
  lands beforehand (Q4→A). Re-verify the export exists (and whether a named
  route type is exported) immediately after rebase at implement time.
- **Siblings**: #1200 (parallel, same phase), #1201 (P1 integration, catches
  decomposition drift).

## Changeset

`.changeset/1199-route-aware-session-invalidation.md` —
`@generacy-ai/orchestrator` **patch**: internal session-invalidation wiring +
log fields; no new public exports, no new label vocabulary. The plugin is not
modified, so no bump there. Single file.
