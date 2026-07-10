# Quickstart: verify the `/health` version fix

**Feature**: #907
**Branch**: `907-symptom-connected-clusters`

---

## What this is

A one-page recipe to reproduce the pre-fix bug and verify the post-fix behavior locally, plus the FR-007 test invocation.

---

## Reproduce the pre-fix bug (baseline)

On the current `develop` branch, spin up the orchestrator and curl `/health`:

```bash
pnpm --filter @generacy-ai/orchestrator dev
# (in another terminal)
curl -s http://localhost:3100/health | jq .
```

**Observed** (pre-fix): the JSON body has `status`, `timestamp`, `services`, `codeServerReady`, `controlPlaneReady`, `displayName`, `clusterId` — but no `version`. Even if you set the env var:

```bash
ORCHESTRATOR_VERSION=sha-abc1234 pnpm --filter @generacy-ai/orchestrator dev
curl -s http://localhost:3100/health | jq .
```

The `version` field is still absent. This is the schema-strip: `fast-json-stringify` drops the undeclared field before serialization. Root cause per spec §Root Cause.

Downstream, `packages/cluster-relay/src/metadata.ts:57`'s `String(data['version'] ?? '0.0.0')` reads `undefined` → coerces to `"0.0.0"` → the cloud dashboard shows `Orchestrator: v0.0.0` for every cluster.

---

## Verify the post-fix behavior (after this PR)

### 1. Env-var-hit path

```bash
ORCHESTRATOR_VERSION=sha-abc1234 pnpm --filter @generacy-ai/orchestrator dev
curl -s http://localhost:3100/health | jq '.version'
# → "sha-abc1234"
```

### 2. Package.json fallback path

```bash
unset ORCHESTRATOR_VERSION
pnpm --filter @generacy-ai/orchestrator dev
curl -s http://localhost:3100/health | jq '.version'
# → "0.1.0"   (current packages/orchestrator/package.json .version)
```

### 3. Q1 guard — env var literal "0.0.0" falls through

```bash
ORCHESTRATOR_VERSION=0.0.0 pnpm --filter @generacy-ai/orchestrator dev
curl -s http://localhost:3100/health | jq '.version'
# → "0.1.0"   (env var didn't resolve — literal "0.0.0" — falls to package.json)
```

### 4. Sentinel path (requires temporarily editing package.json)

For local verification of the sentinel, temporarily set `packages/orchestrator/package.json` `.version` to `"0.0.0"` and unset the env var:

```bash
unset ORCHESTRATOR_VERSION
# (edit packages/orchestrator/package.json, set "version": "0.0.0", save)
pnpm --filter @generacy-ai/orchestrator dev
curl -s http://localhost:3100/health | jq '.version'
# → "unknown"
# (revert the package.json edit before committing)
```

The FR-007 test covers this case without on-disk mutation — see §Run the tests below.

---

## Run the tests

```bash
pnpm --filter @generacy-ai/orchestrator test health-version
```

Expected: three cases pass —

1. `emits ORCHESTRATOR_VERSION verbatim on happy path` — env var set, response `version` matches.
2. `treats env var "0.0.0" as unresolved and falls to package.json` — env var set to `"0.0.0"`, response `version` is package.json's value.
3. `emits "unknown" sentinel when no source resolves` — resolver mocked to simulate no source, response `version` is exactly `"unknown"`.

Also run the existing health test to confirm no regression:

```bash
pnpm --filter @generacy-ai/orchestrator test health-code-server
```

---

## Verify the schema-strip fix

The most easily-regressed part of this fix is the Fastify JSON schema declaration. To assert it:

```bash
curl -s http://localhost:3100/health | jq 'has("version")'
# → true
```

If this ever returns `false` after this PR ships, the Fastify JSON schema on either the 200 or 503 branch has lost its `version: { type: 'string' }` declaration. The FR-007 test catches this because it asserts against the raw response body (post-serialization), not the handler's return value.

---

## Verify downstream cluster-relay picks it up

If you're running the full cluster stack locally (`generacy launch` or the devcontainer's compose), tail the relay logs:

```bash
docker compose logs orchestrator | grep -i version
```

You should see the resolved version in the relay's periodic metadata messages. On the cloud dashboard (or Firestore emulator), the cluster's `orchestratorVersion` field should now show the real value instead of `"0.0.0"`.

---

## Troubleshooting

**"I set `ORCHESTRATOR_VERSION` but `/health` still shows the package.json value"**
- Confirm the env var reached the Node process: `docker compose exec orchestrator printenv ORCHESTRATOR_VERSION`.
- Confirm you're on the `907-*` branch and rebuilt (`pnpm --filter @generacy-ai/orchestrator build` if running from `dist`).

**"`/health` still doesn't have a `version` field"**
- Check `packages/orchestrator/src/routes/health.ts` response schema: both `200:` and `503:` branches must include `version: { type: 'string' }`. Fastify silently strips undeclared fields.

**"Dashboard still shows `Orchestrator: v0.0.0`"**
- The dashboard reads from cluster-relay's forwarded value. If the orchestrator is fine but the dashboard is wrong, check that the cluster reconnected after the orchestrator restart (cluster-relay's metadata is emitted on connect and periodically thereafter).
- Pre-fix images: if any cluster is still running an old image, it'll keep reporting `0.0.0`. Backfill isn't in scope (spec §Out of Scope).

**"I want the value to be `sha-<short>` in production, not `0.1.0`"**
- That's the cross-repo follow-up in cluster-base / cluster-microservices. Add `ENV ORCHESTRATOR_VERSION=$SHA` to the orchestrator Dockerfile, wire `$SHA` from the publish workflow's already-computed `sha=sha-$(git rev-parse --short=7 HEAD)`. Not part of this PR.

---

## Files changed by this PR (quick recap)

- `packages/orchestrator/src/routes/health.ts` — response schema + handler.
- `packages/orchestrator/src/types/api.ts` — `HealthResponseSchema` gains `version: z.string()`.
- `packages/orchestrator/src/services/orchestrator-version.ts` — NEW resolver.
- `packages/orchestrator/src/__tests__/health-version.test.ts` — NEW FR-007 test.

Files intentionally NOT changed:
- `packages/cluster-relay/src/metadata.ts` (FR-006).
- Publish workflows / cluster-base Dockerfile (cross-repo follow-up).
