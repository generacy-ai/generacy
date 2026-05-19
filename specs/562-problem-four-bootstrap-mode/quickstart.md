# Quickstart: bootstrap-complete lifecycle action

**Feature**: #562 | **Date**: 2026-05-10

## What Changed

Two files modified in `packages/control-plane`:
1. `src/schemas.ts` — added `'bootstrap-complete'` to `LifecycleActionSchema`
2. `src/routes/lifecycle.ts` — added handler that writes sentinel file

## Running Tests

```bash
cd packages/control-plane
pnpm test
```

To run only the lifecycle tests:
```bash
pnpm vitest run __tests__/routes/lifecycle.test.ts
```

## Manual Verification

### In-cluster (via Unix socket)

```bash
curl -X POST \
  --unix-socket /run/generacy-control-plane/control.sock \
  -H "x-generacy-actor-user-id: test-user" \
  http://localhost/lifecycle/bootstrap-complete

# Expected: {"accepted":true,"action":"bootstrap-complete","sentinel":"/tmp/generacy-bootstrap-complete"}
# Verify: ls -la /tmp/generacy-bootstrap-complete
```

### With custom sentinel path

```bash
POST_ACTIVATION_TRIGGER=/tmp/test-sentinel curl -X POST \
  --unix-socket /run/generacy-control-plane/control.sock \
  -H "x-generacy-actor-user-id: test-user" \
  http://localhost/lifecycle/bootstrap-complete

# Verify: ls -la /tmp/test-sentinel
```

### Idempotency check

Run the same curl command twice — both should return 200 with the same response.

## End-to-End Verification (Staging)

1. Start a fresh cluster via `generacy launch --claim=<code>`
2. Complete the onboarding wizard through the ReadyStep
3. Verify `/tmp/generacy-bootstrap-complete` exists in the orchestrator container
4. Verify `post-activation-watcher.sh` fires and runs `entrypoint-post-activation.sh`
5. Verify cluster transitions from `bootstrapping` to `ready` state

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `UNKNOWN_ACTION` error | Schema not updated | Ensure `'bootstrap-complete'` is in `LifecycleActionSchema` |
| Sentinel not created | Handler not wired | Check `lifecycle.ts` has the `bootstrap-complete` branch |
| Watcher doesn't fire | Wrong sentinel path | Ensure `POST_ACTIVATION_TRIGGER` matches between control-plane and watcher |
| 401 Unauthorized | Missing actor header | Ensure relay injects `x-generacy-actor-user-id` header |
