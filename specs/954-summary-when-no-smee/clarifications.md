# Clarifications

## Batch 1 — 2026-07-16

### Q1: Health endpoint field scope
**Context**: FR-008 marks the `/health` `smeeConfigured` field as SHOULD (P2), and SC-005 is conditionally worded ("if FR-008 implemented"). This ambiguity blocks decisions on `packages/orchestrator/src/routes/health.ts` schema changes, plumbing from `createServer()` (`server.ts:460-497`) into the health handler, and cockpit/cloud consumer coupling.
**Question**: Should this feature ship the `/health` observability half (FR-008) or defer it to a follow-up issue and land only the log-warning half (FR-001..FR-007, FR-009)?
**Options**:
- A: Ship both — add `smeeConfigured: boolean` to `HealthResponse` and the Fastify 200/503 schemas in `health.ts`, plumb from `config.smee.channelUrl` at construction time
- B: Log-warning only — defer the `/health` field entirely; drop FR-008 and SC-005 from the acceptance surface (create a follow-up issue linked from this spec)
- C: Ship both, but expose the whole smee config summary — `smee: { configured: boolean; mode: 'webhook' | 'polling'; pollIntervalMs: number; completedLatencyMs: number }` — so the cockpit can render the same numbers the warning states

**Answer**: *Pending*

### Q2: Which latency number the warning states
**Context**: FR-002 requires the warning to state "the observed detection latency for `completed:*` labels expressed from the effective `pollIntervalMs` and `COMPLETED_CHECK_INTERVAL=3`". The proposed message says "up to ~90s (poll interval 30000ms × COMPLETED_CHECK_INTERVAL 3)". But `process:*` labels are checked every cycle (max ~30s at the default) and `completed:*` labels every 3rd cycle (max ~90s) — see `label-monitor-service.ts:83`. Which number goes in the warning changes what operators recognize when their cluster feels stuck.
**Question**: What latency should the warning line state?
**Options**:
- A: `completed:*` max only — one worst-case number, e.g. `up to ~90s (30000ms × 3)`. Matches the "why is my cluster stuck for ~90s" recognition the spec calls out
- B: Both classes — state both `process:*` (~30s max) and `completed:*` (~90s max), so operators can distinguish label-class latency
- C: Formula-only — state the formula `pollIntervalMs × COMPLETED_CHECK_INTERVAL` and let the operator compute; concrete numbers only in structured log fields

**Answer**: *Pending*

### Q3: Worker-mode behaviour
**Context**: The smee receiver and label monitor are constructed inside `if (!isWorkerMode && config.labelMonitor && config.repositories.length > 0)` at `server.ts:464`. Worker processes never poll and never receive webhook events regardless of `config.smee.channelUrl`. FR-001 says "the orchestrator emits" but doesn't distinguish full-mode vs worker-mode. If the warning fires in worker mode, it makes a false claim ("falling back to polling") because workers don't poll at all.
**Question**: Should the warning fire only when the label monitor is actually being constructed, or on every orchestrator process (full + worker)?
**Options**:
- A: Full-mode only — gate the else branch on the same conditions as the surrounding block (`!isWorkerMode && config.labelMonitor && config.repositories.length > 0`). Workers stay silent
- B: All orchestrator processes — fire unconditionally; workers emit the warning too, on the theory that any process without smee is "degraded" from the cluster's perspective
- C: Full-mode only for the log warning, but `/health` `smeeConfigured` (if Q1=A/C) still reports the config value on all processes

**Answer**: *Pending*

### Q4: Webhook-setup skip observability
**Context**: FR-009 says the skip at `server.ts:824` must be observable. The actual guard is `if (config.webhookSetup.enabled && config.smee.channelUrl)` — so the skip fires for **two** independent reasons: (a) `smee.channelUrl` empty (already covered by the new startup warning), or (b) `webhookSetup.enabled === false` (a deliberate operator opt-out; not "degraded"). Treating both the same could produce noisy warnings on operator-chosen configurations.
**Question**: What does "skip-path must be observable" cover?
**Options**:
- A: Only the smee-empty half — the single startup warning covers case (a); case (b) stays silent because it's a deliberate opt-out, not a degradation. Simplest, honours "warn = degraded mode" (FR-005 rationale)
- B: Both halves — add a second startup log line covering `webhookSetup.enabled === false`. Log at `info` (deliberate opt-out) not `warn`, to match the "warn = degraded" rationale
- C: Both halves as warn — treat any missed webhook creation as degraded; one combined warn line if either condition is true

**Answer**: *Pending*

### Q5: Log-line shape (structured vs prose)
**Context**: The proposed message in the issue is a single sentence of prose ("No smee channel configured — falling back to polling. …"). SC-004 asserts substring presence in tests — which works for either shape but pushes the test toward asserting on `msg` text. Pino elsewhere in the orchestrator (e.g. `server.ts:496` — `server.log.info({ channelUrl: ... }, 'Smee webhook receiver configured')`) uses short messages plus structured fields, which cockpit/observability consumers can parse. Choice affects both the code shape and the test shape.
**Question**: Should the warning be a single prose message or a short message plus structured fields?
**Options**:
- A: Prose message only — one `server.log.warn('No smee channel configured — falling back to polling. Label events detected in up to ~90s ... Set SMEE_CHANNEL_URL or orchestrator.smeeChannelUrl.')`. Simplest, matches the issue verbatim
- B: Short message + structured fields — `server.log.warn({ pollIntervalMs, completedCheckInterval, completedLatencyMs, remediation: ['SMEE_CHANNEL_URL', 'orchestrator.smeeChannelUrl'] }, 'No smee channel configured; polling fallback active')`. Grep still hits (`smee`, `polling`, both remediation names appear as JSON field values), machine-parseable
- C: Both — structured fields **and** the full prose sentence as the message. Redundant but maximises grep-ability and machine-readability; slightly noisier log

**Answer**: *Pending*
