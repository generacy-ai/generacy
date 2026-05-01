# Quickstart: Control-plane 401 Guard

## What Changed

Three mutator routes now require the `x-generacy-actor-user-id` header:
- `PUT /credentials/:id`
- `PUT /roles/:id`
- `POST /lifecycle/:action`

Requests without this header receive a `401 Unauthorized` response.

## Testing Locally

```bash
cd packages/control-plane
pnpm test
```

## Manual Verification

Start the control-plane (requires socket path):

```bash
CONTROL_PLANE_SOCKET_PATH=/tmp/cp-test.sock pnpm start
```

Test rejection (no actor header):
```bash
curl -X PUT --unix-socket /tmp/cp-test.sock \
  -H "Content-Type: application/json" \
  -d '{"type":"api-key"}' \
  http://localhost/credentials/test-1

# Expected: 401 {"error":"Missing actor identity","code":"UNAUTHORIZED"}
```

Test acceptance (with actor header):
```bash
curl -X PUT --unix-socket /tmp/cp-test.sock \
  -H "Content-Type: application/json" \
  -H "x-generacy-actor-user-id: user-123" \
  -d '{"type":"api-key"}' \
  http://localhost/credentials/test-1

# Expected: 200 {"ok":true}
```

GET routes still work without headers:
```bash
curl --unix-socket /tmp/cp-test.sock http://localhost/state
# Expected: 200 (cluster state JSON)
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| 401 on PUT/POST requests | Missing `x-generacy-actor-user-id` header | Ensure relay proxy injects actor headers |
| Existing integration tests fail | Tests call PUT/POST without actor headers | Add `x-generacy-actor-user-id` header to test fixtures |
| Internal routes returning 401 | Accidentally calling external route path | Use `/internal/` prefix for in-cluster calls |
