# Contract: `HealthResponse.smeeConfigured`

Normative shape for the additive `/health` field.

## Zod schema (`packages/orchestrator/src/types/api.ts`)

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
  smeeConfigured: z.boolean().optional(),           // NEW
});
```

## Fastify route schema (`packages/orchestrator/src/routes/health.ts`)

Both the 200 and 503 response schemas gain:

```ts
smeeConfigured: { type: 'boolean' },
```

Placed alongside `codeServerReady` / `controlPlaneReady`. Not in any `required[]`.

## Population

**Where**: `packages/orchestrator/src/routes/health.ts:setupHealthRoutes`, immediately after `controlPlaneReady`:

```ts
const response: HealthResponse = {
  status: overallStatus,
  timestamp: new Date().toISOString(),
  services,
  version: resolvedVersion,
  codeServerReady,
  controlPlaneReady,
};
if (options.smeeConfigured !== undefined) {
  response.smeeConfigured = options.smeeConfigured;
}
```

**Guard rationale**: matches the `githubAuth`/`cluster` conditional-attach pattern already in the file. Consumers that call `setupHealthRoutes` without passing `smeeConfigured` — e.g. test harnesses or future callers — get no field at all rather than a misleading `false`.

## Wire-through

Two callsites in `packages/orchestrator/src/server.ts`:

- `:669` (worker branch): add `smeeConfigured: !!config.smee.channelUrl` inside the `setupHealthRoutes(server, { … })` bag.
- `:702` (full-mode branch): add `smeeConfigured: !!config.smee.channelUrl` inside the `healthCheckOptions: { … }` bag passed to `registerRoutes`.

Both use `!!config.smee.channelUrl`, not `config.smee.channelUrl !== undefined` — an empty string coerces to `false`, matching the runtime check at `server.ts:487` (`if (config.smee.channelUrl)`).

## Test invariants (SC-002)

Two boots against the same handler wiring:

- `smee.channelUrl: undefined`  →  `GET /health` body has `smeeConfigured: false`.
- `smee.channelUrl: 'https://smee.io/abc'`  →  `GET /health` body has `smeeConfigured: true`.

Fastify's response-schema validation must pass on both — proves the schema-update covered 200 and 503.

Worker mode: `smee.channelUrl: undefined`, `mode: 'worker'`  →  `smeeConfigured: false` still surfaces. This is the "configuration statement, not degradation claim" invariant from clarifications Q3 → C.

## Appendix: Webhook-setup opt-out `info` line

Contract-of-record for the second observability line (`data-model.md` §4). Kept here for locality with the other observability contracts.

**Emit site**: `packages/orchestrator/src/server.ts:824` — the `if (config.webhookSetup.enabled && config.smee.channelUrl)` block. Add:

```ts
else if (config.smee.channelUrl && !config.webhookSetup.enabled) {
  server.log.info(
    { remediation: ['GENERACY_WEBHOOK_SETUP_ENABLED', 'orchestrator.webhookSetup.enabled'] },
    'Webhook auto-setup disabled; no GitHub webhooks will be created for monitored repos',
  );
}
```

- **Fires only when smee is set and setup is disabled** — the smee-unset case is already covered by the §1 warning ("polling fallback active" implies no webhook).
- **`info`, not `warn`** — deliberate operator opt-out is not degradation.
- **Not covered by the `/health` `smeeConfigured` field** — that boolean does not encode the `webhookSetup.enabled` axis. A future widening (`smee: {...}`) could add it; not this feature.
