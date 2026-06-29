# Feature Specification: Cockpit — Orchestrator API Status Tier (Queue Depth / Workers)

**Branch**: `792-epic-generacy-ai-tetrad` | **Date**: 2026-06-29 | **Status**: Draft
**Epic**: generacy-ai/tetrad-development#85 — Phase P5, Tier v3-polish, Issue G5.1
**Owns (isolation)**: `packages/cockpit/src/orchestrator/**` + `packages/generacy/src/cli/commands/cockpit/status*`, `packages/generacy/src/cli/commands/cockpit/watch*`
**Depends on**: G0.1, G1.1

## Summary

The cockpit currently sees only the GitHub side of the world (issue labels, PR check rollups). When a cluster orchestrator is running locally, it knows things GitHub cannot: how many jobs are queued for processing, and how many workers are currently busy.

This feature wires the cockpit `status` and `watch` commands to the orchestrator's HTTP API on `127.0.0.1:3100`, surfacing **queue depth** and **active-worker counts** as a single supplementary line/field beneath the existing GitHub-derived view. The integration is purely additive: if the orchestrator is not reachable or the API token is not available, status/watch continue to work and the orchestrator tier silently degrades to an informative "unavailable" hint.

## User Stories

### US1: Operator sees cluster pressure alongside epic state

**As a** human operator running `generacy cockpit status` for an epic,
**I want** to see queue depth and worker counts beneath the issue/PR table,
**So that** I can tell at a glance whether the cluster is idle, busy, or backed up — without context-switching to a separate `orchestrator` CLI or curl call.

**Acceptance Criteria**:
- [ ] When the orchestrator API is reachable and a token is configured, the status output ends with a single footer line of the form `orchestrator: N jobs, M workers`.
- [ ] When `--json` is set, the JSON envelope includes an `orchestrator` field with `{ available: true, jobs, workers }` (or `{ available: false, reason }`).
- [ ] The footer appears below the existing issue/PR table without changing column widths or row ordering.

### US2: Cockpit keeps working when the orchestrator is absent

**As a** human operator running cockpit on a machine where no cluster is up (or where the API token has not been discovered),
**I want** the status/watch commands to print their GitHub-derived output normally and degrade the orchestrator tier to a one-line hint,
**So that** missing orchestrator credentials never block my view of epic progress.

**Acceptance Criteria**:
- [ ] When no token can be located, the footer reads exactly `orchestrator: (no token; set ORCHESTRATOR_API_TOKEN to enable)` and exit code is unchanged.
- [ ] When the token is present but the API is unreachable, the footer reads `orchestrator: (unavailable — <reason>)` and exit code is unchanged.
- [ ] Orchestrator queries time out cleanly within ~1.5s so a hung daemon cannot stall the table render.

### US3: Watch surfaces orchestrator pressure on each tick

**As a** human operator running `generacy cockpit watch`,
**I want** orchestrator queue/worker counts emitted on the same cadence as GitHub-derived events,
**So that** my NDJSON stream is a single source of truth I can pipe into one downstream consumer.

**Acceptance Criteria**:
- [ ] `watch` either (a) emits an additional NDJSON event type when queue depth or worker count changes between polls, or (b) annotates the periodic startup/poll lines with current counts — exact shape to be decided in `/clarify`.
- [ ] Like `status`, `watch` never blocks or crashes if the orchestrator is unreachable.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Cockpit MUST provide a typed `OrchestratorClient` interface in `packages/cockpit/src/orchestrator/` with at minimum `getJobs()` and `getWorkers()` methods returning a discriminated `{ available: true, ... } \| { available: false, reason }` shape. | P1 | Foundation exists in `client.ts`; keep shape backward-compatible. |
| FR-002 | The client factory MUST return a stub (every method resolves to `{ available: false, reason: 'no-token' }`) when no token is configured. | P1 | Stub path keeps callers branch-free. |
| FR-003 | The client MUST translate HTTP errors to `{ available: false, reason: 'http-error', statusCode }` and network errors to `{ available: false, reason: 'cloud-unreachable' }`. The client MUST NOT throw. | P1 | Already implemented in `client.ts`. |
| FR-004 | `generacy cockpit status` MUST render a footer line summarizing jobs and workers, or an unavailable reason, using a shared `renderFooter()` helper. | P1 | Already wired in `status.ts`. |
| FR-005 | `generacy cockpit status --json` MUST include an `orchestrator` field in the envelope mirroring the footer's `FooterData`. | P1 | Already in `renderJsonEnvelope`. |
| FR-006 | The status footer MUST race the orchestrator calls against a configurable timeout (default 1500 ms) and report `reason: 'timeout'` on timeout. | P1 | Implemented in `getFooter`. |
| FR-007 | `generacy cockpit watch` MUST surface orchestrator queue/worker state without blocking the GitHub poll loop — exact wire format TBD in `/clarify`. | P2 | Not yet wired in `watch.ts`. |
| FR-008 | The orchestrator API token MUST be discoverable from at least: (a) cockpit config (`orchestrator.token`), (b) `ORCHESTRATOR_API_TOKEN` env var. Precedence and any additional sources to be settled in `/clarify`. | P1 | Currently only (a) is wired. |
| FR-009 | The orchestrator base URL MUST default to `http://127.0.0.1:3100` and be overridable via cockpit config (`orchestrator.baseUrl`). | P1 | Default already set; override already supported. |
| FR-010 | "Workers" surfaced in the footer MUST be defined unambiguously (total registered, or only those with status `busy`/`running`). | P1 | Per issue body: "active-worker counts" suggests filtering; current code reports total. Resolve in `/clarify`. |
| FR-011 | The exact orchestrator endpoints consumed MUST be limited to read-only paths and documented. The issue body names `/queue` and `/workflows`; current implementation uses `/queue` and `/dispatch/queue/workers`. Reconcile in `/clarify`. | P1 | Endpoint set is the contract surface. |
| FR-012 | Footer rendering MUST be plain ASCII (no color codes) so the JSON envelope and non-TTY pipes stay byte-stable. | P2 | Existing helper already plain. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `status` exit code with orchestrator reachable + token set | 0; footer contains `orchestrator: N jobs, M workers` | Integration test against a stub HTTP server. |
| SC-002 | `status` exit code with no token | 0; footer contains `(no token` substring | Unit test on `renderFooter` + integration test with `ORCHESTRATOR_API_TOKEN` unset. |
| SC-003 | `status` exit code with token set but orchestrator down | 0; footer contains `(unavailable —` substring | Integration test with `baseUrl` pointed at an unbound port. |
| SC-004 | Status command wall-clock overhead added by orchestrator footer when orchestrator is hung | ≤ 1600 ms beyond baseline | Manual timing against a server that never responds; assert via Promise.race timeout test. |
| SC-005 | `watch` continues emitting GitHub events on its configured interval when the orchestrator is down | No skipped polls; no non-zero exit | Integration test with orchestrator unreachable. |
| SC-006 | `status --json` envelope is parseable JSON in all three orchestrator states (ok / no-token / unreachable) | `JSON.parse` succeeds; `orchestrator.available` field present | Unit test on `renderJsonEnvelope`. |

## Assumptions

- The orchestrator HTTP API at `http://127.0.0.1:3100` is the only target; cockpit does not need to reach a cloud-hosted orchestrator in this issue's scope.
- The orchestrator's `/queue`, `/workflows`, and `/dispatch/queue/workers` endpoints already exist and are stable enough for read-only consumption (they do — see `packages/orchestrator/src/routes/`).
- The API token, when present, is a bearer token used in the `Authorization: Bearer <token>` header.
- "Queue depth" means the count of items returned by `/queue` (or the relevant subset of `/workflows`), not a deeper queue-internal metric.
- The cockpit user has read permission on the orchestrator API; we do not differentiate between "no token" and "wrong token" beyond the `http-error` reason code.

## Out of Scope

- Writing to the orchestrator API (e.g., creating workflows, responding to decisions) — cockpit's surface here is read-only.
- Surfacing per-job or per-worker detail (IDs, current step, age). Only aggregate counts in this issue.
- A standalone `generacy cockpit orchestrator` subcommand — counts appear via `status` and `watch` only.
- Authentication discovery from cloud-managed clusters (`/var/lib/generacy/cluster-api-key`, GitHub installation tokens, etc.). This stays under `ORCHESTRATOR_API_TOKEN` + cockpit config for v3-polish.
- SSE / streaming consumption of orchestrator events. `status` is one-shot; `watch` polls.
- Color/TTY styling of the footer line.

## Open Questions (to be settled in `/clarify`)

1. **Endpoint set**: Issue body names `/queue` and `/workflows`; current client uses `/queue` and `/dispatch/queue/workers`. Which is canonical for "worker count"?
2. **"Active" workers**: Total registered workers, or only workers with `status === 'busy'` / `'running'`?
3. **Token discovery order**: cockpit-config > env var, env var > cockpit-config, or env var only?
4. **`watch` wiring shape**: New event type on count change, periodic annotation, or footer-on-startup only?
5. **Failure logging**: Should `cloud-unreachable` / `http-error` write a one-line warning to stderr, or stay silent (footer only)?

---

*Generated by speckit*
