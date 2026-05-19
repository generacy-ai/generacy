# Quickstart: #519 Cluster-Side IDE Tunnel Support

## Prerequisites

```bash
pnpm install
```

## Files to Create / Modify

| # | File | Change |
|---|------|--------|
| 1 | `packages/cluster-relay/src/messages.ts` | Add 4 tunnel message Zod schemas + interfaces, update `RelayMessageSchema` union |
| 2 | `packages/control-plane/src/services/tunnel-handler.ts` | **NEW** — `TunnelHandler` class with `handleOpen`, `handleData`, `handleClose`, `cleanup` |
| 3 | `packages/control-plane/src/index.ts` | Export `TunnelHandler` and `RelayMessageSender` |
| 4 | `packages/orchestrator/src/types/relay.ts` | Add tunnel types to `RelayMessage` union |
| 5 | `packages/orchestrator/src/services/relay-bridge.ts` | Add `setTunnelHandler()` + tunnel dispatch in `handleMessage()` |
| 6 | `packages/orchestrator/src/server.ts` | Wire `TunnelHandler` at boot, cleanup on disconnect/shutdown |

## Build

```bash
# Build in dependency order
pnpm --filter @generacy-ai/cluster-relay build
pnpm --filter @generacy-ai/control-plane build
pnpm --filter @generacy-ai/orchestrator build
```

## Run Tests

```bash
# Unit tests for cluster-relay schema changes
pnpm --filter @generacy-ai/cluster-relay test

# Unit tests for tunnel handler
pnpm --filter @generacy-ai/control-plane test

# Unit tests for relay-bridge dispatch
pnpm --filter @generacy-ai/orchestrator test

# All tests
pnpm test
```

## Manual Verification

### 1. Schema Acceptance

Verify tunnel messages parse correctly:
```typescript
import { parseRelayMessage } from '@generacy-ai/cluster-relay';

// Should parse successfully
const open = parseRelayMessage({
  type: 'tunnel_open',
  tunnelId: 'tun-123',
  target: '/run/code-server.sock',
});
console.log(open); // { type: 'tunnel_open', tunnelId: 'tun-123', target: '/run/code-server.sock' }

// Should still return null for unknown types
const bad = parseRelayMessage({ type: 'unknown_type' });
console.log(bad); // null
```

### 2. Target Restriction

Verify the handler rejects non-code-server targets:
```typescript
import { TunnelHandler } from '@generacy-ai/control-plane';

const messages: unknown[] = [];
const handler = new TunnelHandler(
  { send: (msg) => messages.push(msg) },
  mockCodeServerManager,
);

await handler.handleOpen({ tunnelId: 'tun-1', target: '/etc/shadow' });
// messages[0] should be: { type: 'tunnel_open_ack', tunnelId: 'tun-1', status: 'error', error: 'invalid target' }
```

### 3. Full E2E (with running cluster)

1. Start the development stack:
   ```bash
   /workspaces/tetrad-development/scripts/stack start
   source /workspaces/tetrad-development/scripts/stack-env.sh
   ```

2. Start the dev server:
   ```bash
   pnpm dev
   ```

3. Navigate to the bootstrap Ready screen and click "Open IDE"

4. Verify code-server opens in a new tab within 15 seconds

5. Verify extended editing session (30+ min) doesn't disconnect

6. Close the IDE tab, then verify socket cleanup:
   ```bash
   # Inside the cluster container
   ss -x | grep code-server
   # Should show no lingering connections
   ```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Open IDE" still hangs in "Connecting..." | Tunnel messages still being dropped | Verify `RelayMessageSchema` includes tunnel schemas; rebuild cluster-relay |
| `tunnel_open_ack { status: 'error', error: 'invalid target' }` | Cloud sending wrong target path | Verify cloud sends `/run/code-server.sock` as target |
| `tunnel_open_ack { status: 'error', error: 'code-server failed to start' }` | Code-server binary missing or socket timeout | Check `CODE_SERVER_BIN` env var; verify code-server is installed in container |
| Tunnel opens but IDE shows blank page | Socket connected but code-server not serving | Check code-server logs; verify it's bound to the correct socket path |
| Tunnel drops after 30 minutes | `touch()` not resetting idle timer | Verify `handleData` calls `codeServerManager.touch()` on each inbound message |
| After relay reconnect, IDE doesn't resume | Cloud not re-sending `tunnel_open` | This is a cloud-side issue; cluster correctly cleaned up on disconnect |
| TypeScript build errors in orchestrator | `RelayMessage` union missing tunnel types | Verify tunnel interfaces added to `types/relay.ts` |
