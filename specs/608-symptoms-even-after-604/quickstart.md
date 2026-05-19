# Quickstart: Testing #608 tunnel name fix

## Unit Tests

```bash
cd packages/control-plane
pnpm test -- --run __tests__/vscode-tunnel-manager.test.ts
```

### Expected new test cases

1. **`deriveTunnelName` with standard UUID** — outputs `g-9e5c8a0d755e40b3b0` (20 chars)
2. **`deriveTunnelName` determinism** — same input always produces same output
3. **`deriveTunnelName` length** — output is <= 20 chars
4. **`loadOptionsFromEnv` returns derived name** — not the raw cluster ID

### Expected updated test cases

- `loadOptionsFromEnv` "returns options from env vars" — `tunnelName` assertion changes from raw ID to derived name

## Manual Test: Fresh Cluster

1. Start a fresh cluster (no cached `code_tunnel.json`)
2. Trigger "Start VS Code Tunnel" from the wizard
3. Verify device code prompt appears
4. Authorize at `https://github.com/login/device`
5. Verify `connected` event fires — tunnel name should be `g-<first18hex>`
6. Verify the `code tunnel` process is running with `--name g-<first18hex>`

```bash
docker exec <container> ps aux | grep "code tunnel"
# Should show: code tunnel --accept-server-license-terms --name g-9e5c8a0d755e40b3b0
```

## Verification Checklist

- [ ] `deriveTunnelName('9e5c8a0d-755e-40b3-b0c3-43e849f0bb90')` === `'g-9e5c8a0d755e40b3b0'`
- [ ] Output length <= 20 for any UUID input
- [ ] `code tunnel` process starts with the derived name
- [ ] `connected` relay event includes derived `tunnelName`
- [ ] Deep link URL contains derived name (companion issue — out of scope)
- [ ] All existing tests pass with updated assertions
