# Quickstart: Complete Cluster Control-Plane Lifecycle Handlers

## Development Setup

```bash
cd packages/control-plane
pnpm install
pnpm build
```

## Running Tests

```bash
# All control-plane tests
pnpm --filter @generacy-ai/control-plane test

# Specific test files
pnpm --filter @generacy-ai/control-plane test -- __tests__/routes/lifecycle.test.ts
pnpm --filter @generacy-ai/control-plane test -- __tests__/services/peer-repo-cloner.test.ts
pnpm --filter @generacy-ai/control-plane test -- __tests__/services/default-role-writer.test.ts
```

## Manual Testing

### Start the development stack

```bash
/workspaces/tetrad-development/scripts/stack start
source /workspaces/tetrad-development/scripts/stack-env.sh
pnpm dev
```

### Test set-default-role

```bash
# Create a test role file
mkdir -p .agency/roles
echo "name: developer" > .agency/roles/developer.yaml

# Call the endpoint (via Unix socket)
curl --unix-socket /run/generacy-control-plane/control.sock \
  -X POST http://localhost/lifecycle/set-default-role \
  -H "Content-Type: application/json" \
  -H "x-generacy-actor-user-id: test-user" \
  -d '{"role": "developer"}'

# Expected: {"accepted":true,"action":"set-default-role"}

# Verify config written
cat .generacy/config.yaml
# Expected: defaults:\n  role: developer

# Test invalid role
curl --unix-socket /run/generacy-control-plane/control.sock \
  -X POST http://localhost/lifecycle/set-default-role \
  -H "Content-Type: application/json" \
  -H "x-generacy-actor-user-id: test-user" \
  -d '{"role": "nonexistent"}'

# Expected: 400 {"error":"Role 'nonexistent' not found","code":"INVALID_REQUEST"}
```

### Test clone-peer-repos

```bash
# Test with empty repos (no-op)
curl --unix-socket /run/generacy-control-plane/control.sock \
  -X POST http://localhost/lifecycle/clone-peer-repos \
  -H "Content-Type: application/json" \
  -H "x-generacy-actor-user-id: test-user" \
  -d '{"repos": []}'

# Expected: {"accepted":true,"action":"clone-peer-repos"}
# Expected relay event: {"status":"done","message":"no peer repos"}

# Test with a public repo
curl --unix-socket /run/generacy-control-plane/control.sock \
  -X POST http://localhost/lifecycle/clone-peer-repos \
  -H "Content-Type: application/json" \
  -H "x-generacy-actor-user-id: test-user" \
  -d '{"repos": ["https://github.com/octocat/Hello-World.git"]}'

# Expected: {"accepted":true,"action":"clone-peer-repos"}
# Expected relay events:
#   {"repo":"https://github.com/octocat/Hello-World.git","status":"cloning"}
#   {"repo":"https://github.com/octocat/Hello-World.git","status":"done"}

# Verify clone
ls /workspaces/Hello-World
```

### Test schema extension

```bash
# Test 'stop' action (stub)
curl --unix-socket /run/generacy-control-plane/control.sock \
  -X POST http://localhost/lifecycle/stop \
  -H "Content-Type: application/json" \
  -H "x-generacy-actor-user-id: test-user"

# Expected: {"accepted":true,"action":"stop"}
```

## Key Files to Modify

| File | Change |
|------|--------|
| `src/schemas.ts` | Add `set-default-role` and `stop` to enum; add body schemas |
| `src/routes/lifecycle.ts` | Wire new handlers into switch statement |
| `src/services/peer-repo-cloner.ts` | New file: clone logic + event emission |
| `src/services/default-role-writer.ts` | New file: role validation + config write |
| `src/relay-events.ts` | New file: extract `setRelayPushEvent`/`getRelayPushEvent` from `audit.ts` |
| `src/routes/audit.ts` | Import from `relay-events.ts` instead of local definition |
| `package.json` | Add `yaml` dependency |

## Troubleshooting

### "UNKNOWN_ACTION" error
The schema hasn't been updated. Ensure `LifecycleActionSchema` has all 5 entries.

### Relay events not emitting
`setRelayPushEvent` may not be wired. Check that orchestrator calls `setRelayPushEvent(fn)` on control-plane startup. For tests, mock via direct function injection.

### Role file not found
Ensure `.agency/roles/<role>.yaml` exists in the workspace root. These are committed to the project repo, not generated.

### Clone hangs
Check network connectivity from the container. For private repos, ensure the cloud-provided token is valid. Token is short-lived (typically 1 hour).
