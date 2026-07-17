# Research: Cockpit doorbell subscribes to smee stream

## Question 1: Reuse `SmeeWebhookReceiver` vs. build a slim SSE client

**Decision**: Build a slim SSE client (`SmeeDoorbellSource`) inside
`packages/generacy/src/cli/commands/cockpit/doorbell/`.

**Why**:
- `SmeeWebhookReceiver` requires a `LabelMonitorService` collaborator and is
  hard-wired to feed label events into `parseLabelEvent` / `processLabelEvent`
  on the orchestrator side. It handles only `issues.labeled`
  (`smee-receiver.ts:210` filters to that action).
- The doorbell needs all six of `issues.labeled | issues.unlabeled |
  issues.closed | pull_request.closed | check_run.completed |
  check_suite.completed` (Q1=A). Extending `SmeeWebhookReceiver` to cover
  them would require:
  1. A new `AnyWebhookHandler` collaborator interface (currently only
     `monitorService.processLabelEvent`).
  2. Ref-set filtering (currently only `watchedRepos` — an
     `owner/repo` string set), which is doorbell-specific.
  3. A new `onEvent` emitter shape (currently side-effects only).
- Both classes are ≤ ~250 LOC. Duplication is acceptable per the "three
  similar lines is better than a premature abstraction" project rule. If a
  third consumer emerges, factor to a shared package.

**Alternatives considered**:
- **A**: Extend `SmeeWebhookReceiver` in `packages/orchestrator/` with an
  optional event sink. Rejected: cross-package coupling from
  `packages/generacy/` back into orchestrator internals; the doorbell would
  need to import orchestrator classes that already carry a heavy
  dependency graph (Fastify logger, LabelMonitorService, etc.).
- **B**: Extract a shared `SseSmeeClient` in `@generacy-ai/cockpit`.
  Rejected: `@generacy-ai/cockpit` is a pure library today (parsers,
  resolvers, gh wrapper); adding a filesystem-and-fetch runtime consumer
  broadens its surface. Reserve for later if a third caller appears.

**Sources**:
- `packages/orchestrator/src/services/smee-receiver.ts` — canonical SSE
  parser + reconnect ladder.
- `packages/orchestrator/src/services/smee-channel-resolver.ts` — canonical
  URL validation regex.

## Question 2: Where does the doorbell find the smee channel URL?

**Decision**: Read the persisted channel file at
`config.smee.channelFilePath` (default `/var/lib/generacy/smee-channel`),
with a `COCKPIT_DOORBELL_SMEE_URL` env override for tests/manual use.

**Why**:
- `SmeeChannelResolver` (`smee-channel-resolver.ts:170`) atomically writes
  the URL to that path with mode 0600 at orchestrator boot. The path is the
  single source of truth on running clusters.
- The doorbell process runs in the orchestrator container (verified: the
  agency skill spawns `generacy cockpit doorbell` from
  `.claude/skills/cockpit:auto/`, which runs inside the same container as
  the orchestrator). Filesystem read is a no-op cost.
- Env override provides a test seam and lets operators point at a bespoke
  channel URL without touching the orchestrator config.

**Alternatives considered**:
- **A**: Import `SmeeConfigSchema` from `@generacy-ai/orchestrator` and
  re-parse `config.yaml`. Rejected: doorbell would need workspace-config
  loading (`.agency/config.yaml` discovery) at startup, doubling the
  discovery surface for zero gain. The persisted file already encodes the
  resolved URL after all four resolver tiers (env-or-yaml → persisted →
  provisioned).
- **B**: Query the orchestrator's `/health` endpoint for a `smeeChannelUrl`
  field. Rejected: adds an HTTP dependency and a new response field for a
  filesystem-adjacent process. Doorbell startup would become dependent on
  orchestrator liveness in a way the poll fallback isn't today.
- **C**: Read `.agency/config.yaml` for `orchestrator.smeeChannelUrl`.
  Rejected: `SmeeChannelResolver` supersedes the config's presetUrl with
  a provisioned URL in the common case, so config-read alone would miss
  auto-provisioned clusters.

**Sources**:
- `packages/orchestrator/src/config/schema.ts:239-247` — `SmeeConfigSchema`
  with `channelFilePath` default.
- `packages/orchestrator/src/services/smee-channel-resolver.ts:171-188` —
  atomic write with mode 0600.
- `packages/orchestrator/src/server.ts:522-585` — orchestrator's own
  discovery loop (env → yaml → persisted → provisioned).

## Question 3: Q1=A — no `CockpitEventSchema` change

**Decision**: Do not extend the `event` enum in `emit.ts`.

**Why**:
- Q1=A explicitly rules review / comment events out of scope. Adding new
  enum values would require:
  1. A revision to `CockpitEventSchema` in
     `packages/generacy/src/cli/commands/cockpit/watch/emit.ts` (public
     shape).
  2. A forward-compatibility update in `agency#431`'s skill payload
     handling (out of this repo's scope).
  3. A rev bump for the `@generacy-ai/cockpit` package if the schema is
     re-exported (it isn't — schema lives in `packages/generacy/`).
- The doorbell stdout line is `event.type\n` (per `lineForEvent`). Even if
  we did emit a new event type in-process, the wake signal reaching the
  skill is just the type name. On-sibling-review wake (Q1 option B/C) is a
  separate capability — file it as a follow-up if wanted.

**Sources**:
- `packages/generacy/src/cli/commands/cockpit/watch/emit.ts:5-15` — enum
  today.
- `packages/generacy/src/cli/commands/cockpit/doorbell/subscribe.ts:22-24` —
  `lineForEvent` emits only `event.type`.

## Question 4: Ref-set discovery cost

**Decision**: One `resolveEpic` call at smee-source startup + on-epic-payload
+ 10-min safety-net (Q2=D). Matches poll mode's steady-state cost after
#970's cadence gate.

**Why**:
- Poll mode calls `resolveEpic` every 10th cycle (~5 min at 30 s cadence)
  post-#970. Smee-mode's hybrid — startup + on-epic-payload + 10-min timer —
  is at parity or better in the common case.
- Sub-second scope-add currency is the reason for the on-epic-payload path:
  `cockpit_scope_add` edits the epic body, which fires `issues.edited`, so
  the ref-set refresh runs within milliseconds of the operator adding a
  child.
- The 10-min safety-net bounds worst-case staleness for `gh api` PATCH-based
  edits that don't fire `issues.edited` (e.g., some GitHub GraphQL
  mutations). This is the same failure mode poll mode covers via its
  every-Nth-cycle refresh.

**Sources**:
- Clarifications Q2 in `clarifications.md`.
- `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts:438-450`
  — poll-mode refresh cadence.

## Question 5: Runtime demotion policy

**Decision**: Q3=D — 5 consecutive reconnect failures OR 5 min elapsed
demotes to poll-fallback; re-promote attempted every 5 min.

**Why**:
- Q3=A (reconnect forever, never demote) matches the orchestrator's
  `SmeeWebhookReceiver` but strands `/cockpit:auto` on prolonged smee.io
  outages: the doorbell writes zero stdout lines while the poll bus (unused)
  would still be surfacing events every 30 s.
- Q3=D preserves latency during transient blips (5-min re-promotion means a
  minute-scale outage doesn't permanently downgrade) while capping worst-
  case wake latency at the poll cadence during sustained failure.
- The `ScheduleWakeup` heartbeat (FR-011) remains the ultimate backstop under
  either mode.

**Sources**:
- Clarifications Q3 in `clarifications.md`.
- `packages/orchestrator/src/services/smee-receiver.ts:83-108` — orchestrator's
  forever-reconnect loop.

## Question 6: Aggregate event computation cost budget

**Decision**: Q4=A — recompute only on completion signals (`completed:*`
label, `issues.closed`, `pull_request.closed`), with a 500 ms debounce.

**Why**:
- Poll mode computes `phase-complete` / `epic-complete` every 30 s from a
  `SnapshotMap` diff. Smee mode has no snapshot; producing aggregates
  requires reconstructing one.
- The only webhook events that can *complete* a phase are label additions
  that mark completion and issue/PR close events. All other payloads can
  safely skip aggregate recomputation with zero risk of missing a
  completion.
- 500 ms debounce collapses fan-out during epic-completion bursts (e.g., a
  final PR merge that triggers `pull_request.closed` and immediately
  after `check_run.completed`) — the aggregate is idempotent, so one
  refresh per debounce window is enough.

**Sources**:
- Clarifications Q4 in `clarifications.md`.
- `packages/generacy/src/cli/commands/cockpit/watch/aggregate.ts:49-93` —
  pure `computeAggregateEvents`.

## Question 7: `armed\n` timing

**Decision**: Q5=A — unconditional, immediately after argument validation.

**Why**:
- Preserves the shipped contract with agency#431 (no skill change).
- Skill's startup sweep re-checks live state, so treating `armed\n` as a
  pure liveness signal costs nothing.
- Deferring `armed\n` until source is settled (Q5=B) would add SSE-connect
  latency (~50–500 ms) to skill startup on smee-live clusters —
  observable slowness on the happy path.

**Sources**:
- Clarifications Q5 in `clarifications.md`.
- `packages/generacy/src/cli/commands/cockpit/doorbell.ts:205` — current
  `armed\n` site.

## Question 8: Node runtime compatibility

**Decision**: No new runtime dependencies. `fetch` and
`ReadableStream` are Node >=22 built-ins, already used by
`SmeeWebhookReceiver`. `package.json` `engines.node` is `>=22`.

**Sources**:
- `packages/generacy/package.json:72` — `"node": ">=22"`.
- `packages/orchestrator/src/services/smee-receiver.ts:130-140` — native
  `fetch` + `response.body.getReader()` pattern.

## Question 9: Test seams for SSE

**Decision**: Inject `fetch` and `now` into `SmeeDoorbellSource` for tests.
Integration test spins up a `node:http` server on `127.0.0.1:0` that streams
SSE frames matching smee.io's format.

**Why**:
- Mocking `fetch` alone is fragile because the SSE parser reads
  `response.body.getReader()` — the mock needs a full `ReadableStream`.
- In-process HTTP server on ephemeral port keeps the test hermetic (no
  real smee.io calls) and exercises real SSE framing.
- Same pattern used by orchestrator's `server-smee-provisioning.test.ts`.

**Sources**:
- `packages/orchestrator/src/services/__tests__/smee-receiver.test.ts` —
  pattern reference.
