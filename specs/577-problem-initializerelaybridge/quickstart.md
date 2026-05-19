# Quickstart: Register /control-plane Unix-Socket Route on Relay Client

## Prerequisites

1. Issue #576 merged (`ClusterRelayClientOptions` accepts `routes`)
2. `@generacy-ai/cluster-relay` package updated in monorepo

## Implementation Steps

### 1. Modify `initializeRelayBridge` in `packages/orchestrator/src/server.ts`

At line ~635, change:

```typescript
const relayClient = new RelayClientImpl({
  apiKey: config.relay.apiKey,
  cloudUrl: config.relay.cloudUrl,
  orchestratorUrl: `http://127.0.0.1:${config.server.port}`,
  orchestratorApiKey: relayInternalKey,
});
```

To:

```typescript
const relayClient = new RelayClientImpl({
  apiKey: config.relay.apiKey,
  cloudUrl: config.relay.cloudUrl,
  orchestratorUrl: `http://127.0.0.1:${config.server.port}`,
  orchestratorApiKey: relayInternalKey,
  routes: [
    {
      prefix: '/control-plane',
      target: `unix://${controlPlaneSocket}`,
    },
  ],
});
```

`controlPlaneSocket` is already defined on line 618.

### 2. Add unit test

Create `packages/orchestrator/src/__tests__/relay-route-config.test.ts`:

- Mock `@generacy-ai/cluster-relay` to capture constructor args
- Call the code path that constructs the relay client
- Assert `routes` contains `{ prefix: '/control-plane', target: 'unix:///run/generacy-control-plane/control.sock' }`
- Test with custom `CONTROL_PLANE_SOCKET_PATH` env var

### 3. Verify

```bash
# Run unit tests
cd packages/orchestrator
pnpm test -- --run relay-route-config

# Run existing relay tests (regression)
pnpm test -- --run relay-integration

# TypeScript compile check
pnpm tsc --noEmit
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| TypeScript error: `routes` not in `ClusterRelayClientOptions` | #576 not merged | Merge #576 first, update cluster-relay dependency |
| `ENOENT` on Unix socket at runtime | Control-plane not started | Ensure `cluster-base#24` is deployed (control-plane process) |
| 404 on `/control-plane/credentials/foo` | Routes not passed or prefix stripping wrong | Check relay client was constructed with routes; verify dispatcher strips prefix |
