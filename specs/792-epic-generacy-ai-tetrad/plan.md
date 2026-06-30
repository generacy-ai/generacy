# Implementation Plan: Cockpit — Orchestrator API Status Tier (Queue Depth / Workers)

**Feature**: Wire the cockpit `status` and `watch` commands to the local orchestrator HTTP API at `127.0.0.1:3100`, surfacing queue depth and **active** worker counts as an additive footer (status) and an emit-on-transition NDJSON event (watch).
**Branch**: `792-epic-generacy-ai-tetrad`
**Status**: Complete

## Summary

The cockpit today only sees the GitHub-derived view (issue labels, PR check rollups). This feature adds a thin, read-only orchestrator tier that exposes two metrics the local cluster knows and GitHub does not:

1. **Jobs** — `len(GET /queue)`
2. **Active workers** — `(GET /dispatch/queue/workers).count`

The integration is purely additive: when the orchestrator is unreachable or `ORCHESTRATOR_API_TOKEN` is not set, both `status` and `watch` continue working and the orchestrator tier degrades to a one-line hint (in the footer / as an NDJSON `{type:"orchestrator-counts", available:false, reason}` event — see contracts/ for the exact shapes).

This issue also closes a latent always-`0` bug in `client.ts:144`: the orchestrator returns `{ count: <number> }` from `/dispatch/queue/workers`, but the current client tries to normalize it as a `WorkerSummary[]` list. We replace that with a `{ count }` consumer (Q1 → A).

## Scope (isolation)

Per spec front-matter:

- **Owns**: `packages/cockpit/src/orchestrator/**` + `packages/generacy/src/cli/commands/cockpit/status*`, `packages/generacy/src/cli/commands/cockpit/watch*`.
- **Does NOT touch**: orchestrator routes (`packages/orchestrator/src/routes/**`), cockpit `manifest`, `state`, `gh`, `config` packages (except a passthrough test fixture if needed), or any cluster-side process.

## Technical Context

| Aspect | Value |
|---|---|
| Language | TypeScript (ESM, `"type":"module"`) |
| Runtime | Node.js >=22 |
| Test runner | Vitest |
| HTTP | `node:http` / `node:https` via the existing `NativeHttpClient` in `packages/cockpit/src/orchestrator/http.ts` — no new dep |
| Validation | `zod` (already a cockpit dep, used by `CockpitEventSchema`) |
| CLI framework | `commander` (already used by `status` / `watch`) |
| Orchestrator endpoints consumed | `GET /queue` (returns `Item[]`), `GET /dispatch/queue/workers` (returns `{ count: number }`) |
| Auth | `Authorization: Bearer <token>` |
| Token source | `ORCHESTRATOR_API_TOKEN` env var (precedence A) > `cockpit.config.orchestrator.token` |
| Default base URL | `http://127.0.0.1:3100` (override: `cockpit.config.orchestrator.baseUrl`) |
| Timeout | 1500 ms per orchestrator call, raced via `Promise.race` (existing `getFooter` pattern) |

No new runtime dependencies. No new packages. No orchestrator route changes.

## Project Structure

Files modified / created (all inside the isolation scope above):

```
packages/cockpit/src/orchestrator/
  client.ts                                   # MODIFIED — getWorkers() returns { count: number }
  stub.ts                                     # unchanged shape — already returns no-token envelope
packages/cockpit/src/__tests__/
  orchestrator-client.test.ts                 # MODIFIED — assert { count } shape; remove WorkerSummary[] assertions
  orchestrator-token-precedence.test.ts       # NEW — env-var-wins precedence (lives at cli side, see below)

packages/generacy/src/cli/commands/cockpit/
  status.ts                                   # MODIFIED — resolveOrchestratorToken(), warnOnce sink
  watch.ts                                    # MODIFIED — construct orchestrator client, baseline emit, per-tick poll
  shared/
    orchestrator-footer.ts                    # MODIFIED — consume count; label "M active workers"
    orchestrator-token.ts                     # NEW — resolveOrchestratorToken(config, env) helper
    orchestrator-warn.ts                      # NEW — createFirstFailureWarner() one-shot stderr sink
  watch/
    orchestrator-counts.ts                    # NEW — pollOrchestratorCounts() + emit-on-transition state
  status/
    render-table.ts                           # MODIFIED (small) — footer label change carries through unchanged code

packages/generacy/src/cli/commands/cockpit/__tests__/
  status.footer.test.ts                      # MODIFIED — new label "M active workers"; first-failure stderr
  status.token-precedence.test.ts            # NEW — env > config; missing both → stub; trim whitespace
  watch.orchestrator-counts.test.ts          # NEW — baseline emit; emit on change; no emit on equal
  watch.orchestrator-failure.test.ts         # NEW — watch keeps polling GH when orchestrator unreachable
  helpers/ (existing)                        # reuse stubHttp / fake clock helpers
```

No file moves; all changes are additive or in-place edits.

## Key Technical Decisions

1. **Drop `getWorkers(): WorkerSummary[]`; introduce `getWorkers(): { count }`** (Q1 → A, FR-011)
   - Fixes the always-`0` bug.
   - Caller (`getFooter`) becomes simpler — no array length compute.
   - The exported type `WorkerSummary` is removed (it had no other consumers — confirmed via tree search in the isolation scope). Removal kept inside cockpit's orchestrator subpackage; `index.ts` re-exports updated.

2. **Token resolution helper** (Q3 → A, FR-008)
   - New pure function `resolveOrchestratorToken({ envValue, configValue }): string | undefined`.
   - Precedence: trimmed env > trimmed config > undefined. Empty / whitespace-only treated as unset for both inputs.
   - Lives next to status/watch in `shared/orchestrator-token.ts` so both commands consume the same logic.
   - The cockpit package's `createOrchestratorClient` factory does **not** read `process.env` — keeping it pure preserves testability. The CLI layer is the only place that touches `process.env`.

3. **First-failure stderr sink** (Q5 → B, FR-013)
   - New `createFirstFailureWarner()` returns `(reason: string) => void` that writes one line on first invocation and is silent thereafter.
   - One sink per command invocation. For `status` (one-shot), the second-call gate is trivially satisfied. For `watch`, the sink is created at startup and survives across ticks.
   - Stdout / `--json` output is never touched by the warner.

4. **`watch` emit-on-transition** (Q4 → A, FR-007)
   - New `pollOrchestratorCounts(client, prev, warn)` returns `{ event: OrchestratorCountsEvent | null, curr: OrchestratorCountsState }`.
   - Baseline emit at startup: prev = `null`, curr = first poll → always emit one line.
   - Subsequent ticks emit only when `jobs !== prev.jobs || workers !== prev.workers`. Unavailable→available, available→unavailable, and reason-change for unavailable→unavailable are all treated as transitions.
   - Wire format: `{"type":"orchestrator-counts","jobs":N,"workers":M}` when available; `{"type":"orchestrator-counts","available":false,"reason":"..."}` when not. Validated by a new `OrchestratorCountsEventSchema` (zod, lives next to `CockpitEventSchema`).

5. **Footer label** (Q2 → A, FR-010)
   - Available footer: `orchestrator: N jobs, M active workers` (literal `active workers`).
   - JSON envelope keeps existing field name `workers` (changing it would break #787 consumers; the label-vs-field split is explicit in the data-model).

6. **Timeout stays at 1500 ms** (FR-006, SC-004)
   - Already implemented in `getFooter`. No change to default; expose as parameter only.
   - `watch` reuses the same `getFooter` race so timeouts are bounded per tick — the GH poll loop is unaffected.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo; no governance rules to verify against. Aligns with these implicit project norms (visible in CLAUDE.md / surrounding code):

- ESM, Node >=22, vitest, zod, native `node:http` — ✓
- No new runtime dep — ✓
- Read-only consumer of orchestrator API (FR description) — ✓
- Pure functions for resolution / diff / render; side effects pushed to command edges — ✓
- Stable JSON envelope (#787 watch contract preserved by adding a new event type instead of mutating existing ones) — ✓

## Test Strategy

- **Unit (pure)**: `resolveOrchestratorToken`, `createFirstFailureWarner`, `pollOrchestratorCounts` diff state, footer label rendering, JSON envelope shape — all stubbed inputs, no I/O.
- **Integration (in-process HTTP)**: stub `HttpClient` (same pattern as `orchestrator-client.test.ts`) for the live-client paths: `/queue` returns array, `/dispatch/queue/workers` returns `{count}`, error / timeout / token-missing → unavailable.
- **CLI smoke**: keep behavior verified by `status.footer.test.ts` and a new `watch.orchestrator-counts.test.ts` that drives the watch loop with a stub orchestrator + stub gh wrapper for one full poll cycle.

Success-criteria mapping:
- SC-001 / SC-002 / SC-003 → `status.footer.test.ts` (footer text in 3 states)
- SC-004 → `getFooter` timeout test (already exists; assert reason: 'timeout' and elapsed ≤ 1600 ms)
- SC-005 → `watch.orchestrator-failure.test.ts` (no skipped poll, exit code 0 on SIGTERM)
- SC-006 → `status.render.test.ts` JSON envelope parse + `orchestrator.available` assertion

## Risks / Open Questions

None blocking. Token rotation behavior is out of scope (FR-008 covers discovery only); operators restart `watch` to pick up a new token. This is acceptable for a v3-polish read-only tier — documented in `quickstart.md`.

## Next Step

Run `/speckit:tasks` to materialize the per-file work breakdown.
