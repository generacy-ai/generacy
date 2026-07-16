# Quickstart: smee.io provisioner fix (#965)

Small bugfix in `SmeeChannelResolver.provision()`. This page documents how to reproduce the bug locally, apply the fix, and verify it end-to-end.

## Reproducing the bug (pre-fix)

The current (broken) provisioner issues `POST https://smee.io/new` and expects `302` + `Location`. Live smee.io now responds with `200 content-length: 0` — a no-op.

You can reproduce the exact live behavior by hand:

```bash
# Verify current smee.io behavior (2026-07-16):
curl -sI -X POST https://smee.io/new    # → HTTP/2 200,   content-length: 0,  no Location  ← the bug
curl -sI -X GET  https://smee.io/new    # → HTTP/2 307,   location: https://smee.io/<channel>
curl -sI -X HEAD https://smee.io/new    # → HTTP/2 307,   location: https://smee.io/<channel>
```

To see the bug manifest against a real cluster:

1. Boot a fresh cluster from the preview channel without setting `SMEE_CHANNEL_URL`:
   ```bash
   # From a scaffolded generacy project directory
   pnpm --filter @generacy-ai/generacy build
   docker compose -f .generacy/docker-compose.yml up -d
   docker compose -f .generacy/docker-compose.yml logs orchestrator | grep -E 'smee|webhook|polling'
   ```
2. Expected (broken) log lines:
   ```
   {"level":40,"attempts":2,"lastError":"unexpected status 200","msg":"Failed to provision smee channel after 2 attempts — cluster is webhook-less, falling back to polling"}
   {"level":40,"remediation":["SMEE_CHANNEL_URL","orchestrator.smeeChannelUrl"],"msg":"No smee channel configured; polling fallback active"}
   {"level":30,"intervalMs":10000,"reason":"webhooks-not-configured","msg":"Webhooks appear unhealthy, increasing poll frequency"}
   ```

## Applying the fix

Three edits inside `packages/orchestrator/src/services/smee-channel-resolver.ts` in the `provision()` method:

1. **Line 137**: `method: 'POST'` → `method: 'GET'`.
2. **Line 141**: `if (response.status !== 302) {` → `if (response.status < 300 || response.status >= 400) {`.
3. **Line 142**: `` lastError = `unexpected status ${response.status}`; `` → `` lastError = `expected 3xx with Location, got ${response.status}`; ``.

Everything else in the file stays as-is: `redirect: 'manual'`, `SMEE_URL_PATTERN` on `Location`, retry envelope (2 attempts, 1s backoff, 5s timeout), catch branch, warn log, and the 4-tier `resolve()` precedence.

Optional cosmetic touch-up: the file's top-of-file docstring at lines 6-7 mentions "`POST https://smee.io/new`" — update the one word "POST" to "GET" to keep the file self-consistent.

## Unit tests

Update `packages/orchestrator/src/services/__tests__/smee-channel-resolver.test.ts`:

1. Generalize `make302(location)` at lines 10-15 into `makeRedirect(status, location)`. Keep `make302` as a thin wrapper (`make302 = (l) => makeRedirect(302, l)`) OR migrate existing call sites — either shape is fine, existing tests must continue to pass unchanged.

2. Add three new tests (see `contracts/provision-response.md` for the exact fixtures):
   - **`307`-with-valid-`Location` → success**: `makeRedirect(307, 'https://smee.io/abc123')` returns `'https://smee.io/abc123'` on attempt 1.
   - **`200`-empty → failure, retries exhausted, correct diagnostic**: `makeRedirect(200, null)` returns `null` after 2 attempts; assert the final warn log's `lastError` field equals `'expected 3xx with Location, got 200'` (SC-003).
   - **`3xx`-with-invalid-`Location` → failure via `SMEE_URL_PATTERN` check**: `makeRedirect(307, 'https://evil.com/x')` returns `null` after 2 attempts; assert `lastError` equals `'Location does not match SMEE_URL_PATTERN'`.

3. Run the affected test suite:
   ```bash
   pnpm --filter @generacy-ai/orchestrator test smee-channel-resolver
   ```
   Expected: all existing tests pass unchanged; three new tests pass green.

## Changeset

Add `.changeset/965-smee-provisioner-fix.md`:

```markdown
---
"@generacy-ai/orchestrator": patch
---

Fix `SmeeChannelResolver.provision()` to match smee.io's current live `/new` behavior. Provisioner now issues `GET` and accepts any 3xx redirect status with a valid `Location` header (was `POST` + strict `302`). Every fresh preview-channel cluster booted without `SMEE_CHANNEL_URL` was falling back to polling because smee.io silently flipped both the accepted method (`POST → GET`) and the redirect status (`302 → 307`). Introduced in #952.
```

The bump is `patch` (defect fix, `workflow:speckit-bugfix`). Only one package is touched (`@generacy-ai/orchestrator`); no public API surface change.

## End-to-end verification (SC-001)

After landing the fix and publishing a new preview build:

1. Boot a fresh cluster from `ghcr.io/generacy-ai/cluster-base:preview` with no `SMEE_CHANNEL_URL` / `orchestrator.smeeChannelUrl` configured.
2. Grep orchestrator logs for absence of:
   - `"Failed to provision smee channel after 2 attempts"`
   - `"No smee channel configured; polling fallback active"`
   - `"webhooks-not-configured"`
3. Grep for presence of a `"Provisioned new smee channel URL"` log line with a resolved `channelUrl` matching `https://smee.io/[A-Za-z0-9_-]+`.
4. Confirm the smee pipeline starts and receives webhook events (label change on an issue in the project's monitored repo should reach the orchestrator sub-second, not 10s).

## Troubleshooting

**`provision()` fails with `expected 3xx with Location, got 200`**
Smee.io has changed its `/new` behavior again. Verify the current shape with `curl -sI -X GET https://smee.io/new`. If the method or status has flipped, this is a new upstream drift — apply the same shape of fix (broad predicate hedge), and consider whether the alternative-forwarder work in spec §Out of Scope has become tractable.

**`provision()` fails with `Location does not match SMEE_URL_PATTERN`**
Smee.io's URL shape has changed. Inspect the returned `Location` header; if it's still a smee-hosted URL, update `SMEE_URL_PATTERN` accordingly. Do NOT relax the regex to accept arbitrary redirect targets — the pattern is a safety gate against redirect chains pointing to attacker-controlled hosts.

**`provision()` fails with `timeout after 5000ms`**
Network path to smee.io is degraded. Retry envelope handles a single transient timeout; sustained timeouts indicate cluster egress problems, not a bug in this resolver. Set `SMEE_CHANNEL_URL` manually as the workaround while investigating egress.

**Fresh cluster still falls back to polling after fix**
Confirm the deployed image includes this fix (`ghcr.io/generacy-ai/cluster-base:preview` must be a build newer than the fix's merge commit). Confirm `SMEE_CHANNEL_URL` is unset — the `presetUrl` path bypasses `provision()` entirely. If a stale persisted channel file exists at the resolver's `channelFilePath` and it holds a broken URL, `readPersistedFile` returns it and skips provisioning — check the file and delete if stale.

## Commands

| Command | Purpose |
|---|---|
| `pnpm --filter @generacy-ai/orchestrator test smee-channel-resolver` | Run the resolver test suite (includes the three new SC-002 fixtures). |
| `pnpm --filter @generacy-ai/orchestrator build` | Type-check the change. |
| `pnpm changeset` | Interactive changeset creation (or hand-write `.changeset/965-*.md` per the CLAUDE.md rules). |
| `curl -sI -X GET https://smee.io/new` | Verify live smee.io behavior matches the assumptions in this fix. |
