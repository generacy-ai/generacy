# Quickstart: Verifying the Canonical Relay Event Schema Fix

## Prerequisites

- Node >= 22
- pnpm installed
- Development stack running (see CLAUDE.md)

## Build and Test

```bash
# Install dependencies
pnpm install

# Build cluster-relay (canonical schema lives here)
pnpm --filter @generacy-ai/cluster-relay build

# Build dependent packages
pnpm --filter @generacy-ai/control-plane build
pnpm --filter @generacy-ai/orchestrator build

# Run cluster-relay unit tests (includes round-trip schema test)
pnpm --filter @generacy-ai/cluster-relay test
```

## Verification Checklist

### 1. No duplicate EventMessage definitions
```bash
# Should return exactly 1 result (in cluster-relay/src/messages.ts)
grep -r "interface EventMessage" packages/*/src/
```

### 2. No RelayEvent/RelayJobEvent in orchestrator
```bash
# Should return 0 results
grep -r "RelayEvent\|RelayJobEvent" packages/orchestrator/src/types/relay.ts
```

### 3. No as RelayMessage casts on event sends
```bash
# Should return 0 results for event send sites
grep -n "as RelayMessage\|as unknown as RelayMessage" \
  packages/orchestrator/src/services/relay-bridge.ts \
  packages/orchestrator/src/routes/internal-relay-events.ts \
  packages/orchestrator/src/server.ts
```

### 4. Canonical shape used everywhere
```bash
# All event sends should use {type: 'event', event, data, timestamp}
grep -A4 "type: 'event'" \
  packages/orchestrator/src/services/relay-bridge.ts \
  packages/orchestrator/src/routes/internal-relay-events.ts \
  packages/orchestrator/src/server.ts
```

### 5. PushEventFn uses canonical names
```bash
# Should show (event: string, data: unknown), not (channel, payload)
grep "PushEventFn" packages/control-plane/src/relay-events.ts
```

### 6. Schemas exported
```bash
# Should show both exports
grep "export.*EventMessageSchema\|export.*RelayMessageSchema" \
  packages/cluster-relay/src/messages.ts
```

## Troubleshooting

**TypeScript compilation errors after type changes**: Build packages in dependency order — cluster-relay first, then control-plane and orchestrator.

**Tests fail on timestamp validation**: Ensure all event sends include `timestamp: new Date().toISOString()`. The schema uses `z.string().datetime()` which requires ISO 8601 format.

**IPC events still dropped**: Verify `bin/control-plane.ts` sends `{event, data, timestamp}` (not `{channel, payload}`), and `internal-relay-events.ts` Zod schema expects the same fields.
