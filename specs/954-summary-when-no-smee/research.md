# Research: Smee-less startup surfaces a warning + `/health` field

Constraints from clarifications (`clarifications.md` Batch 1) are load-bearing. This file records the *why* behind each decision so an implementer facing an edge case knows which invariant to preserve.

## §1 — Where the warning fires

**Decision**: Guard the warning **inside** the label-monitor construction block at `server.ts:464`, on `!config.smee.channelUrl`. Not as an `else` on the block.

**Rationale**: The block condition is `!isWorkerMode && config.labelMonitor && config.repositories.length > 0`. An `else` fires for three distinct conditions, and only one is "smee is missing":

1. `isWorkerMode === true` — workers never poll. "Falling back to polling" is false.
2. `config.repositories.length === 0` — the monitor is disabled outright. This is the **normal pre-activation state of every wizard-bootstrap cluster** — `snappoll`'s first boot logged `Label monitor requested but no repositories configured — disabling.` A warning here would misdirect operators mid-activation.
3. `config.labelMonitor === false` — deliberate opt-out.

Only condition (a-inverse: block-entered ∧ `!smee.channelUrl`) is degradation. Guarding *inside* the block matches the existing pattern at `server.ts:487` (`if (config.smee.channelUrl) { … receiver … }`) — same gating shape, opposite branch.

**Reference**: clarifications.md Q3 → C.

## §2 — What the warning says

**Decision**: Short Pino message + structured fields. Both label-class latencies stated, **computed from the effective `pollIntervalMs`** at the moment the warning fires. Do not hardcode 30 000 / 90 000.

**Payload shape** (see `contracts/log-warning.md` for the normative version):

```ts
server.log.warn(
  {
    pollIntervalMs,                              // config.monitor.pollIntervalMs (effective)
    completedCheckInterval,                      // LabelMonitorService.COMPLETED_CHECK_INTERVAL = 3
    processLatencyMs: pollIntervalMs,            // process:* checked every cycle
    completedLatencyMs: pollIntervalMs * completedCheckInterval,  // completed:* every Nth cycle
    remediation: ['SMEE_CHANNEL_URL', 'orchestrator.smeeChannelUrl'],
  },
  'No smee channel configured; polling fallback active',
);
```

**Rationale**:

- **Matches the surrounding convention.** `server.ts:496` is `server.log.info({ channelUrl }, 'Smee webhook receiver configured')`, and `Starting label monitor polling` at :791 is `{ intervalMs, repos }`. A prose-only warning would be the odd one out in its own file.
- **Both label classes**, because operators recognise different symptoms: `process:*` (up to `~pollIntervalMs`) and `completed:*` (up to `~pollIntervalMs × 3`). Stating only the worst case (Q2 → A) invites an operator whose `process:speckit-feature` label was picked up in ~30s to read "up to ~90s" and conclude the warning describes something else.
- **Computed, not hardcoded** — a warning that lies is worse than the silence it replaces. An operator who sets `pollIntervalMs: 60000` must see `processLatencyMs: 60000` / `completedLatencyMs: 180000`.
- **Grep-ability preserved.** `msg` contains `smee`, `polling`. Field values contain `SMEE_CHANNEL_URL`, `orchestrator.smeeChannelUrl`. SC-004 substring assertions still hold against the serialised JSON line.

**Alternatives considered**:

- **Prose-only** (Q5 → A): rejected — inconsistent with file convention; harder to render server-side.
- **Prose + structured** (Q5 → C): rejected — the structured JSON values already grep as the same substrings the prose would; the redundancy buys nothing measurable.
- **Formula-only** (Q2 → C): rejected — the person grepping at 2am wants the number, not homework.

**Reference**: clarifications.md Q2 → B, Q5 → B.

**`COMPLETED_CHECK_INTERVAL` visibility**: currently `private static readonly` at `label-monitor-service.ts:83`. Two viable exports for reading from `server.ts`:

- Promote to `public static readonly` on `LabelMonitorService`. Zero-risk — a compile-time constant.
- Re-export as a module-level `export const COMPLETED_CHECK_INTERVAL = 3;` in `label-monitor-service.ts` and reference the class-static from it.

The first is smaller. Both are acceptable; the tasks phase picks one.

## §3 — What `/health` exposes

**Decision**: One boolean `smeeConfigured: boolean` on `HealthResponse` (`types/api.ts:210`) and in the Fastify 200 + 503 route schemas (`routes/health.ts`). Plumbed through `HealthCheckOptions` from `createServer()`, populated from `!!config.smee.channelUrl` at construction time.

**Rationale**:

- A boolean is the **minimum consumer commitment**. Widening to `smee: { configured; mode; pollIntervalMs; completedLatencyMs }` is an additive change we can make when a cockpit consumer asks for it — and three of those four fields are derivable from `configured` + `MonitorConfig` (which the cockpit already knows how to fetch).
- **Reported on all processes** (workers included). Workers never poll, but the field is a *configuration statement* ("is this cluster configured with a smee URL"), not a degradation claim ("is this specific process degraded"). Consumers who want the degradation answer should read the log line, which is full-mode-only.
- **Additive schema change**, so no consumer break. Not in `required[]`; declared as `type: 'boolean'` alongside `codeServerReady` / `controlPlaneReady`.

**Alternatives considered**:

- **Nested object** (Q1 → C): rejected — locks a shape into the health schema before there is a consumer asking for it.
- **Defer entirely** (Q1 → B): rejected — the field is a one-liner once the warning's plumbing exists, and it's the only machine-readable signal for cockpit rendering.

**Reference**: clarifications.md Q1 → A, Q3 → C.

## §4 — Second skip reason (webhook-setup opt-out)

**Decision**: Emit an `info` line inside `server.ts:824` covering the case `config.webhookSetup.enabled === false`. Not `warn` — that would erode the "warn = degraded" signal.

**Rationale**: `if (config.webhookSetup.enabled && config.smee.channelUrl)` silently short-circuits for two reasons:

- (a) `!config.smee.channelUrl` — degradation; already covered by §1.
- (b) `!config.webhookSetup.enabled` — deliberate opt-out.

Silence on (b) reproduces this issue's failure mode in miniature: an operator inherits a config with `webhookSetup` disabled, wonders why no webhook exists on their repo, and source-dives to find the flag. One `info` line prevents that.

The two must be logged at **different levels**. Warning on the opt-out would train people to ignore the warning — the fastest way to make the FR-005 "warn = degraded" rationale meaningless.

**Shape** (mirror of §2, appropriately quieter):

```ts
// Case (b): smee URL is set but the operator disabled auto-setup
if (config.smee.channelUrl && !config.webhookSetup.enabled) {
  server.log.info(
    { remediation: ['GENERACY_WEBHOOK_SETUP_ENABLED', 'orchestrator.webhookSetup.enabled'] },
    'Webhook auto-setup disabled; no GitHub webhooks will be created for monitored repos',
  );
}
```

Emitted **only when smee is configured** — otherwise it's redundant with §1 (which already tells the operator no webhook will be created). Case (a ∧ ¬b) does not need a second line; §1 covers it.

**Reference**: clarifications.md Q4 → B.

## §5 — Test strategy

Three new test files, each isolating one behaviour:

### `packages/orchestrator/src/__tests__/server-smee-fallback-warning.test.ts`

- Build a minimal `OrchestratorConfig` with `labelMonitor: true`, `repositories: [{owner, repo}]`, `smee.channelUrl: undefined`, `mode: 'full'`.
- Stub Pino via `pino({ level: 'warn' })` piped to a buffer, or spy on `server.log.warn`.
- Assert exactly one `warn` fires with:
  - `msg` contains `smee` (case-insensitive) and `polling`.
  - Fields include `pollIntervalMs`, `completedCheckInterval: 3`, `processLatencyMs`, `completedLatencyMs`, `remediation` array containing both env-var and yaml-path strings.
  - `completedLatencyMs === pollIntervalMs * 3` (SC-004 core invariant — the "computed, not hardcoded" test).
- Negative: set `smee.channelUrl: 'https://smee.io/abc'` and assert **zero** warns with the diagnostic message.

### `packages/orchestrator/src/__tests__/server-smee-opt-out-info.test.ts`

- Config: `smee.channelUrl: 'https://smee.io/abc'`, `webhookSetup.enabled: false`. Rest as above.
- Assert exactly one `info` fires with `msg` containing `webhook` and `disabled`, and `remediation` containing `GENERACY_WEBHOOK_SETUP_ENABLED`.
- Negative: `webhookSetup.enabled: true` → zero info logs matching that message.

### `packages/orchestrator/src/routes/__tests__/health-smee-field.test.ts`

- Boot server (via existing test harness pattern) with `smee.channelUrl: undefined` → `GET /health` → response body has `smeeConfigured: false`.
- Second run with `smee.channelUrl: 'https://smee.io/abc'` → `smeeConfigured: true`.
- Assert Fastify's response validation passes (proves the schema was updated for both 200 and 503).

### Worker-mode negative test

Either fold into the fallback-warning test as a third case (`mode: 'worker'` → zero warns), or split. Same assertion either way: the warning must not fire in worker mode even when `smee.channelUrl` is empty (Q3 rationale — workers don't poll, so the warning would lie).

**Reference**: SC-004 substring assertions, Q3 → C false-warning matrix.

## §6 — Sources

- `packages/orchestrator/src/server.ts:464` — label-monitor block condition.
- `packages/orchestrator/src/server.ts:487` — existing `if (config.smee.channelUrl)` receiver construction (mirror pattern).
- `packages/orchestrator/src/server.ts:824` — webhook-setup guard (both skip reasons).
- `packages/orchestrator/src/services/label-monitor-service.ts:83` — `COMPLETED_CHECK_INTERVAL = 3`.
- `packages/orchestrator/src/routes/health.ts` — Fastify 200/503 schemas + response construction.
- `packages/orchestrator/src/types/api.ts:210` — `HealthResponseSchema`.
- `packages/orchestrator/src/config/schema.ts:238` — `SmeeConfigSchema`. `channelUrl` is optional (undefined = fallback).
- `packages/orchestrator/src/config/schema.ts:249` — `WebhookSetupConfigSchema`. `enabled` defaults to `false`.
- Related issues: #952 (auto-provision smee), #953 (adaptive polling never engages without a webhook).
