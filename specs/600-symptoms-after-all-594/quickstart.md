# Quickstart: #600 Fix EventMessage Shape

## The Fix

Two files, ~5 changed lines total.

### 1. Fix field mapping

`packages/orchestrator/src/routes/internal-relay-events.ts` — lines 42-46:

```diff
  client.send({
    type: 'event',
-   channel,
-   event: payload,
- } as unknown as RelayMessage);
+   event: channel,
+   data: payload,
+   timestamp: new Date().toISOString(),
+ } as unknown as RelayMessage);
```

### 2. Update test assertion

`packages/orchestrator/src/routes/__tests__/internal-relay-events.test.ts` — lines 58-62:

```diff
  expect(relayClient.send).toHaveBeenCalledWith({
    type: 'event',
-   channel: 'cluster.vscode-tunnel',
-   event: { status: 'starting' },
+   event: 'cluster.vscode-tunnel',
+   data: { status: 'starting' },
+   timestamp: expect.any(String),
  });
```

## Verification

```bash
# Run orchestrator tests
pnpm --filter @generacy-ai/orchestrator test

# Manual: start cluster, click "Start Tunnel" in wizard, verify device code appears
```

## Troubleshooting

**Q: Why keep `as unknown as RelayMessage`?**
A: The local `EventMessage` interface doesn't match the wire format. Full type alignment is tracked in #572.

**Q: How do I know events are reaching the cloud?**
A: Check cloud logs for `cluster.vscode-tunnel` events, or observe the wizard UI transitioning from spinner to device code display after clicking "Start Tunnel".
