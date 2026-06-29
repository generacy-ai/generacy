# Clarifications

## Batch: 2026-06-29

### Q1: Worker-count endpoint
**Context**: The issue body names `/workflows` as a source for worker info, but `packages/orchestrator/src/routes/dispatch.ts:54` exposes `GET /dispatch/queue/workers` returning `{ count: <number> }`. The current client (`packages/cockpit/src/orchestrator/client.ts:144`) hits `/dispatch/queue/workers` but then runs `normalizeWorkers(pickArrayField(result.data, 'workers', 'items'))` against it, which will always yield `[]` because the response is `{ count }` not a list — so today `workers` is silently `0`. We need a single canonical endpoint and shape before implementation.
**Question**: Which endpoint is canonical for the "worker" count surfaced in the footer, and what is its response shape?
**Options**:
- A: Keep `GET /dispatch/queue/workers` (returns `{ count }`); rework client + footer to consume the number directly (drop the `WorkerSummary[]` path entirely).
- B: Keep `GET /dispatch/queue/workers` but extend the orchestrator route to return `{ workers: WorkerSummary[] }` so the existing `getWorkers()` client signature works unchanged.
- C: Use `/workflows` (as the issue body literally states) and derive worker count from it (e.g. count distinct in-flight assignees).

**Answer**: *Pending*

### Q2: Definition of "workers"
**Context**: `getActiveWorkerCount()` in the orchestrator counts only workers that currently hold one or more claimed queue items (`in-memory-queue-adapter.ts:203`, `redis-queue-adapter.ts:275`). FR-010 says the footer's "workers" number MUST be unambiguous: total registered vs. only busy. The current behaviour is "busy only", but the issue body says "active-worker counts" which is ambiguous.
**Question**: What number should `M workers` in the footer represent?
**Options**:
- A: Active/busy workers only — workers currently holding ≥1 claimed queue item (current orchestrator semantics).
- B: Total registered workers regardless of whether they're idle or busy.
- C: Both, e.g. footer reads `orchestrator: N jobs, M/T workers` (busy/total).

**Answer**: *Pending*

### Q3: Token discovery precedence
**Context**: FR-008 requires the token come from cockpit config (`orchestrator.token`) and/or `ORCHESTRATOR_API_TOKEN` env var. `status.ts:75` currently reads only `loaded.config.orchestrator?.token`. We need a deterministic precedence rule so behaviour is predictable when both are set and so test fixtures can lock the order in.
**Question**: When both `cockpit.config.orchestrator.token` and `ORCHESTRATOR_API_TOKEN` are present, which wins?
**Options**:
- A: Env var wins (`ORCHESTRATOR_API_TOKEN` overrides cockpit config) — matches twelve-factor; lets operators override per shell without editing config.
- B: Cockpit config wins — explicit project config is the source of truth; env var is the fallback for "no config".
- C: Env var only — drop cockpit-config support entirely; token always comes from environment.

**Answer**: *Pending*

### Q4: `watch` wire format
**Context**: US3/FR-007 says `generacy cockpit watch` MUST surface orchestrator queue/worker state but lists three plausible shapes and defers the choice to `/clarify`. The decision drives the NDJSON schema downstream consumers will parse, so it must be settled before `watch.ts` is wired.
**Question**: How should `watch` emit orchestrator state into the NDJSON stream?
**Options**:
- A: A new NDJSON event type emitted only when jobs/workers counts change between polls, e.g. `{"type":"orchestrator-counts","jobs":N,"workers":M}`.
- B: Annotate every periodic poll/heartbeat line with current counts (e.g. add `orchestratorJobs`/`orchestratorWorkers` fields to existing tick events), even when unchanged.
- C: Emit once at startup (footer-equivalent) and never again from `watch` — counts only refresh via re-running `watch` or running `status`.

**Answer**: *Pending*

### Q5: Failure logging on stderr
**Context**: Today `getFooter()` returns `{ available: false, reason }` and the footer renders the reason inline; nothing is written to stderr. Operators debugging "why doesn't my orchestrator show up?" benefit from a stderr breadcrumb, but pipeline consumers benefit from silent footer-only behaviour. This decision affects the `--json` envelope's coexistence with stderr and the noise level under `watch`.
**Question**: When the orchestrator footer is `unavailable` due to `cloud-unreachable` or `http-error`, should the command also write a one-line warning to stderr?
**Options**:
- A: Always silent — the footer/JSON field is the only signal. Stderr stays clean.
- B: One-line stderr warning on the first failure per command invocation; subsequent failures (e.g. in `watch`) suppressed.
- C: Warn on every failure (each `status` invocation and every failing `watch` tick).

**Answer**: *Pending*
