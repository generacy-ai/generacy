# Research: Cockpit ↔ Orchestrator API Status Tier

## R1. Worker-count endpoint shape

**Question** — Is the worker count surfaced from `/dispatch/queue/workers` (returns `{count}`) or from a list-returning route, and is there a latent bug today?

**Findings**:
- `packages/orchestrator/src/routes/dispatch.ts:54-66` defines:
  ```ts
  server.get('/dispatch/queue/workers', ..., async (...) => {
    const count = await queueManager.getActiveWorkerCount();
    return reply.send({ count });
  });
  ```
  Confirmed: response shape is `{ count: number }`.
- `packages/cockpit/src/orchestrator/client.ts:144-152` calls `/dispatch/queue/workers` then does:
  ```ts
  const workers = normalizeWorkers(pickArrayField(result.data, 'workers', 'items'));
  ```
  `pickArrayField` returns `[]` because the body has no `workers`/`items` array key, so the live client always reports zero workers. Latent bug confirmed.
- `getActiveWorkerCount()` semantics are visible in `packages/orchestrator/src/queue/in-memory-queue-adapter.ts:203` and `redis-queue-adapter.ts:275` — counts workers holding ≥1 claimed item. This is "busy", not "registered".

**Decision** — Adopt the spec's Q1 → A: rework the client to consume `{ count }` directly. Drop the unused `WorkerSummary` type. Footer label becomes `"M active workers"` (Q2) to make the semantic explicit.

**Alternatives considered**:
- Extend the orchestrator route to also return a `WorkerSummary[]` — rejected: out of isolation scope and adds an unbounded list to a hot path.
- Use `/workflows` (literal issue body) — rejected: workflows are work units, not worker registrations, and the spec resolves this in Q1.

## R2. Jobs endpoint shape

**Findings**:
- `packages/orchestrator/src/routes/queue.ts:21-43` defines `GET /queue` returning the decision-queue array directly (no wrapper object).
- `pickArrayField(data, ...)` short-circuits on `Array.isArray(data)` and returns it as-is — already correct for this endpoint.
- `normalizeJobs` accepts each item with `{id, status}` strings; orchestrator queue items satisfy this (verified via `QueueService.getQueue` type).

**Decision** — No client change needed for `getJobs()`. `footer.jobs = jobsResult.jobs.length` continues to read correctly.

## R3. Token discovery — env-var precedence

**Question** — Where to read `ORCHESTRATOR_API_TOKEN`, and how to combine with `cockpit.config.orchestrator.token`?

**Findings**:
- Today `status.ts:75-77` only reads `loaded.config.orchestrator?.token`.
- `packages/cockpit/src/config/schema.ts` declares `orchestrator.token` as optional string.
- The cockpit core package has no `process.env` reads — it is pure and reusable. Adding env reads inside the factory would couple it to a CLI runtime.
- Twelve-factor convention: secrets via env override config (the same model #549 uses for `GENERACY_API_URL`).

**Decision** — Resolution lives in the CLI layer, not in `createOrchestratorClient`. New `shared/orchestrator-token.ts` exports `resolveOrchestratorToken({ envValue, configValue })`. Empty / whitespace-only treated as unset on both sides. Both `status.ts` and `watch.ts` consume it and pass the resolved value into the factory.

**Alternatives considered**:
- Add env read to `createOrchestratorClient` — rejected: breaks test isolation and pollutes a pure factory.
- Drop config entirely (Q3 → C) — rejected by the spec.

## R4. `watch` wire format — emit-on-transition

**Question** — How does watch emit orchestrator counts without spamming the NDJSON stream?

**Findings**:
- `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` and `emit.ts` implement the existing emit-on-transition model for GH events (per #787).
- `CockpitEventSchema` is the validated schema for those events; new event types should follow the same `zod`-validated pattern for forward compat.
- The poll loop in `watch.ts` already maintains a `prev: SnapshotMap` across ticks — adding a second `prevOrchestrator: OrchestratorCountsState | null` follows the same pattern.

**Decision** — Add new event type with its own zod schema:
- Available: `{ type: "orchestrator-counts", jobs: number, workers: number }`
- Unavailable: `{ type: "orchestrator-counts", available: false, reason: string }`

Baseline emit at startup is a "transition from null", so the first poll always emits. Subsequent polls compare the available branch (`jobs`+`workers`) and the unavailable branch (`reason`). Any change → emit.

The new event is a sibling of `CockpitEvent`, not a member of its discriminated union — that keeps the GH event schema byte-stable for existing consumers.

**Alternatives considered**:
- Annotate every poll-tick event with `orchestratorJobs`/`orchestratorWorkers` (Q4 → B) — rejected: emits stale data when nothing changed.
- Emit once at startup and never again (Q4 → C) — rejected: counts go stale immediately under `watch`.

## R5. Stderr failure logging — first-failure-only

**Findings**:
- `watch.ts` polls every 5s by default; even one stderr warning per failing poll would mean ~12/min of spam if the orchestrator is down for a while.
- `status.ts` is one-shot; first-failure-only and always-warn behave identically there.
- Stderr is the only safe channel: stdout carries the JSON envelope (status) or NDJSON stream (watch) and must stay parseable.

**Decision** — Create `createFirstFailureWarner()` returning `(reason: string) => void`. Internal boolean `fired` flips on first call; subsequent calls are no-ops. One sink per CLI invocation, plumbed into both the `getFooter` race (for status) and the watch orchestrator poll (for watch).

**Alternatives considered**:
- Always warn (Q5 → C) — rejected: floods stderr under watch.
- Always silent (Q5 → A) — rejected: removes the debugging breadcrumb operators want.

## R6. Timeout knob

**Findings**:
- `getFooter` already accepts `timeoutMs` (default 1500). SC-004 sets the overhead budget at ≤1600 ms beyond baseline.
- The race is per-call (`getJobs` and `getWorkers` race independently against the timeout) — total wall-clock is bounded by max(1500, 1500) = 1500 ms because they run via `Promise.all`.

**Decision** — Reuse the existing `getFooter` race for both `status` and `watch`. No new timeout helper. In watch, the per-tick orchestrator poll runs in parallel with the GH poll, so a hung orchestrator never delays GH events.

## R7. Type / re-export surface

**Findings**:
- `packages/cockpit/src/orchestrator/client.ts` exports `WorkerSummary`.
- Repo-wide grep within the isolation scope: `WorkerSummary` is referenced only inside `client.ts` itself (the live-client `normalizeWorkers` path).
- `packages/cockpit/src/index.ts` re-exports `OrchestratorClient`, `createOrchestratorClient`, and the result types.

**Decision** — Remove `WorkerSummary` and `normalizeWorkers`. Update `WorkersResult` to the new shape. Re-export remains source-compatible for `OrchestratorClient`, `JobsResult`, `WorkersResult`.

## R8. Test helpers

**Findings**:
- `packages/cockpit/src/__tests__/orchestrator-client.test.ts` has a working `stubHttp(responses)` helper. Reuse it for the workers-count test.
- `packages/generacy/src/cli/commands/cockpit/__tests__/helpers/` has fake-time + capture-stream helpers used by other watch tests. The new `watch.orchestrator-counts.test.ts` can build on those.

**Decision** — No new shared test helpers needed.

## Key Sources

| Reference | Why it matters |
|---|---|
| `packages/orchestrator/src/routes/dispatch.ts:54-66` | Canonical `{count}` response shape (R1) |
| `packages/orchestrator/src/routes/queue.ts:21-43` | Canonical array response shape (R2) |
| `packages/cockpit/src/orchestrator/client.ts:144-152` | Latent always-`0` bug (R1) |
| `packages/cockpit/src/orchestrator/http.ts` | Re-use, no new transport (R6) |
| `packages/generacy/src/cli/commands/cockpit/shared/orchestrator-footer.ts` | Existing race + render (R6) |
| `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` | Emit-on-transition pattern (R4) |
| `packages/generacy/src/cli/commands/cockpit/watch/emit.ts` | Zod-validated NDJSON write pattern (R4) |
| Spec clarifications Q1–Q5 | Locked answers used to remove ambiguity |
