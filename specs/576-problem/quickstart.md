# Quickstart: Expose `routes` in ClusterRelayClientOptions

**Feature**: #576

## Verification

### 1. Run tests

```bash
cd packages/cluster-relay
pnpm test
```

All existing tests should pass, plus 2 new tests:
- `accepts routes via ClusterRelayClientOptions`
- `defaults routes to empty array via ClusterRelayClientOptions`

### 2. Build check

```bash
cd packages/cluster-relay
pnpm build
```

Should type-check and compile without errors.

### 3. Manual verification (node REPL)

```typescript
import { ClusterRelay } from '@generacy-ai/cluster-relay';

// With routes
const relay = new ClusterRelay({
  apiKey: 'test',
  cloudUrl: 'wss://example.com/relay',
  routes: [
    { prefix: '/control-plane', target: 'unix:///run/generacy-control-plane/control.sock' },
  ],
});
// relay['config'].routes should contain the route

// Without routes (backward compatible)
const relay2 = new ClusterRelay({
  apiKey: 'test',
  cloudUrl: 'wss://example.com/relay',
});
// relay2['config'].routes should be []
```

## Usage (orchestrator side — future #574)

```typescript
const relay = new ClusterRelay({
  apiKey: config.relay.apiKey,
  cloudUrl: config.relay.cloudUrl,
  orchestratorUrl: config.relay.orchestratorUrl,
  orchestratorApiKey: config.relay.orchestratorApiKey,
  routes: [
    { prefix: '/control-plane', target: 'unix:///run/generacy-control-plane/control.sock' },
  ],
});
```

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Routes not dispatching | Routes not sorted | Verify `sortRoutes()` is called after parse |
| Route prefix validation error | Prefix doesn't start with `/` | Ensure all prefixes start with `/` |
| TypeScript error on `routes` field | Stale type declarations | Run `pnpm build` to regenerate `.d.ts` |
