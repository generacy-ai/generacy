# Data Model: Smee-less startup surfaces a warning + `/health` field

Types touched. All changes are additive; no field renames, no removals.

## 1. `HealthResponse` — additive field

**File**: `packages/orchestrator/src/types/api.ts:210`

```ts
export const HealthResponseSchema = z.object({
  status: HealthStatusSchema,
  timestamp: z.string().datetime(),
  services: z.record(ServiceStatusSchema),
  version: z.string(),
  codeServerReady: z.boolean().optional(),
  controlPlaneReady: z.boolean().optional(),
  displayName: z.string().optional(),
  clusterId: z.string().optional(),
  githubAuth: GitHubAuthSnapshotSchema.optional(),
  smeeConfigured: z.boolean().optional(),           // NEW — additive, optional
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
```

**Semantics**: `true` iff `config.smee.channelUrl` is a non-empty URL at `createServer()` construction. Present on **all** processes (workers included). Absent when the server was constructed via a code path that does not pass `healthCheckOptions.smeeConfigured` — treat as "unknown" downstream; do not conflate with `false`.

**Validation**: `z.boolean()`. Fastify 200 + 503 route schemas add `smeeConfigured: { type: 'boolean' }` at the same level as `codeServerReady`. Not in `required[]`.

## 2. `HealthCheckOptions` — new field on the options bag

**File**: `packages/orchestrator/src/routes/health.ts:11`

```ts
export interface HealthCheckOptions {
  checks?: Record<string, () => Promise<ServiceStatus>>;
  cluster?: { id?: string; displayName?: string };
  githubAuth?: () => GitHubAuthSnapshot | undefined;
  smeeConfigured?: boolean;                          // NEW
}
```

**Population**:

- `server.ts:669` (worker-mode branch) — pass `smeeConfigured: !!config.smee.channelUrl`.
- `server.ts:702` (full-mode branch, inside `registerRoutes(server, { …, healthCheckOptions: { … } })`) — same.

**No getter/callback**: `config.smee.channelUrl` cannot change at runtime, so a value snapshot at construction is sound. This diverges from `githubAuth?: () => GitHubAuthSnapshot | undefined` (which *does* need a live getter because credentials rotate).

## 3. Warning log payload — Pino record shape

**Emit site**: `packages/orchestrator/src/server.ts` — new `else` branch on `if (config.smee.channelUrl)` at line ~487, inside the label-monitor construction block.

**Contract** (see `contracts/log-warning.md` for normative version):

```ts
interface SmeeFallbackWarningPayload {
  pollIntervalMs: number;              // config.monitor.pollIntervalMs (effective)
  completedCheckInterval: number;      // 3 — LabelMonitorService.COMPLETED_CHECK_INTERVAL
  processLatencyMs: number;            // = pollIntervalMs
  completedLatencyMs: number;          // = pollIntervalMs * completedCheckInterval
  remediation: readonly string[];      // ['SMEE_CHANNEL_URL', 'orchestrator.smeeChannelUrl']
}
// msg: 'No smee channel configured; polling fallback active'
// level: 'warn'
```

**Invariants**:

- `processLatencyMs === pollIntervalMs`.
- `completedLatencyMs === pollIntervalMs × completedCheckInterval`.
- `completedCheckInterval === 3` (the constant from `label-monitor-service.ts:83`). If that constant ever changes, this warning silently follows — that is the point of reading it from the class.
- `remediation.length >= 2` and includes both `'SMEE_CHANNEL_URL'` (env var) and `'orchestrator.smeeChannelUrl'` (yaml key).

## 4. Webhook-setup opt-out info payload — Pino record shape

**Emit site**: `packages/orchestrator/src/server.ts:824` — new branch `else if (config.smee.channelUrl && !config.webhookSetup.enabled) { server.log.info(…) }`.

**Contract**:

```ts
interface WebhookSetupOptOutPayload {
  remediation: readonly string[];      // ['GENERACY_WEBHOOK_SETUP_ENABLED', 'orchestrator.webhookSetup.enabled']
}
// msg: 'Webhook auto-setup disabled; no GitHub webhooks will be created for monitored repos'
// level: 'info'
```

**Only fires when `smee.channelUrl` is set** — otherwise the §3 warning already communicates that no webhook will be created; a second line would be redundant.

## 5. Relationships

```
config.smee.channelUrl (undefined | URL)
   │
   ├── determines § 3 payload (warn, full-mode only, inside label-monitor block)
   ├── determines § 4 payload gating (info fires only when this is set)
   └── determines HealthResponse.smeeConfigured (all processes)

config.webhookSetup.enabled (boolean, default false)
   └── determines § 4 payload (info fires when smee set ∧ this false)

config.monitor.pollIntervalMs (number)
   └── feeds § 3 processLatencyMs + completedLatencyMs

LabelMonitorService.COMPLETED_CHECK_INTERVAL (const 3)
   └── feeds § 3 completedCheckInterval + completedLatencyMs multiplier
```

## 6. Backward compatibility

- `smeeConfigured` is `optional()` on `HealthResponse`. Older consumers ignore unknown fields.
- Fastify's response schemas add the field without `required[]`. `additionalProperties` behaviour is unchanged (default false in existing 200/503 schemas → the field must be declared, which we do; it does not close off other declared fields).
- No breakage of the existing `if (config.smee.channelUrl)` receiver-construction branch or the existing webhook-setup guard — new branches sit alongside them, not inside.

## 7. Out of scope for this feature

- Widening `smeeConfigured: boolean` into `smee: { configured; mode; pollIntervalMs; completedLatencyMs }` (deferred until a cockpit consumer requests it — clarifications Q1 → A).
- Consuming `smeeConfigured` on the cockpit / cloud UI side (separate feature).
- Auto-provisioning a smee channel when none is configured (#952).
- Adaptive polling engagement for polling-only clusters (#953).
