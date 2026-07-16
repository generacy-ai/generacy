# Quickstart: verifying the smee channel auto-provisioning

**Feature**: #952 | **Branch**: `952-summary-no-automated-cluster` | **Date**: 2026-07-16

Short runbook for validating the fix end-to-end on a live cluster. Assumes cluster-base image containing this orchestrator version is deployed.

## Prerequisites

- A cluster provisioned via `generacy launch` or `generacy deploy` (or the cloud onboarding flow). Confirmed to be webhook-less pre-fix: `docker exec <cluster>-orchestrator-1 sh -c 'env | grep -i smee'` prints `SMEE_CHANNEL_URL=` (empty).
- Access to `docker logs` and `docker exec` for the orchestrator container.
- The cluster is post-activation (repositories configured, credentials seeded). Pre-activation wizard boots do not trigger the resolver.

## Repro the pre-fix bug (baseline)

On a cluster running the pre-fix orchestrator:

```bash
docker exec <cluster>-orchestrator-1 sh -c 'env | grep -i smee'
# SMEE_CHANNEL_URL=
# ORCHESTRATOR_SMEE_CHANNEL_URL=

docker logs <cluster>-orchestrator-1 2>&1 | grep -ci smee
# 0
```

- Zero smee log lines → `SmeeWebhookReceiver` was never constructed.
- Label monitoring falls back to polling. Add a `process:speckit-feature` label to an assigned issue and observe up to 30s latency; add a `completed:*` label and observe up to 90s latency (`COMPLETED_CHECK_INTERVAL = 3`).

## Deploy and verify the fix

### Step 1 — pull the updated cluster-base image

```bash
generacy update
# or manually: docker compose pull && docker compose up -d
```

### Step 2 — verify the resolver fired on boot

```bash
docker logs <cluster>-orchestrator-1 2>&1 | grep -i smee
```

Expected on a **first-boot-after-fix** cluster (no prior file):

```
{"msg":"Provisioned new smee channel URL","channelUrl":"https://smee.io/<newid>","source":"provisioned"}
{"msg":"Resolved smee channel URL — starting pipeline","channelUrl":"https://smee.io/<newid>","source":"provisioned"}
{"msg":"Smee webhook receiver configured","channelUrl":"https://smee.io/<newid>"}
{"msg":"Connected to smee.io channel","channelUrl":"https://smee.io/<newid>"}
```

If you see instead:

```
{"msg":"Failed to provision smee channel after 2 attempts …","attempts":2,"lastError":"..."}
{"msg":"No smee channel URL available — cluster is webhook-less, falling back to polling"}
```

→ smee.io was unreachable during boot. The cluster is degraded (as designed, per FR-006). Wait for the guaranteed post-activation restart or manually restart: `docker compose restart orchestrator`. The next boot will retry.

### Step 3 — verify the file was persisted

```bash
docker exec <cluster>-orchestrator-1 ls -la /var/lib/generacy/smee-channel
# -rw-------  1 node node   32  Jul 16 12:34 /var/lib/generacy/smee-channel

docker exec <cluster>-orchestrator-1 cat /var/lib/generacy/smee-channel
# https://smee.io/<newid>
```

Expected:
- Mode `600` (rw for owner only).
- Owner `node:node` (uid 1000).
- Exactly the URL, no trailing newline.

### Step 4 — verify the GitHub webhook was created

On the monitored repo(s):

```bash
gh api repos/<owner>/<repo>/hooks --jq '.[].config.url'
# https://smee.io/<newid>
```

Or via the GitHub UI: Settings → Webhooks → the URL matches the one from step 2.

### Step 5 — verify near-instant label detection

Add a `process:speckit-feature` label to an assigned open issue. Watch:

```bash
docker logs -f <cluster>-orchestrator-1 2>&1 | grep -i 'label\|webhook'
```

Expected: label processed within ~1s (vs. up to 30s with polling). Look for a log line like `Received webhook event` or `Label event enqueued` within a second of the label being added.

### Step 6 — verify idempotency across restart

```bash
docker compose restart orchestrator
docker logs <cluster>-orchestrator-1 2>&1 | grep -i smee | head -5
```

Expected on boot 2:

```
{"msg":"Reusing persisted smee channel URL","channelUrl":"https://smee.io/<newid>","source":"persisted"}
{"msg":"Resolved smee channel URL — starting pipeline","channelUrl":"https://smee.io/<newid>","source":"persisted"}
{"msg":"Smee webhook receiver configured","channelUrl":"https://smee.io/<newid>"}
```

The `source` field flipped from `provisioned` to `persisted` — same URL, zero HTTP calls, zero writes. `gh api repos/.../hooks` still shows the same URL (no orphan created).

### Step 7 — verify wizard-mode boot 1 does NOT provision

On a **fresh** cluster (not yet through activation):

```bash
docker logs <cluster>-orchestrator-1 2>&1 | grep -i smee
```

Expected: no smee lines at all. The cluster's boot 1 has no repositories configured (`config.repositories.length === 0`) and the gate short-circuits before the resolver runs. The log line `Label monitor requested but no repositories configured — disabling.` is expected instead.

After activation completes and the post-activation restart fires, step 2 applies.

## Troubleshooting

### "Provisioned new smee channel URL but failed to persist"

Log line:
```
{"msg":"Provisioned smee channel URL but failed to persist — dropping URL to avoid orphaned GitHub webhook accumulation","path":"/var/lib/generacy/smee-channel","error":"..."}
```

Root cause: `/var/lib/generacy/` is not writable by the `node` user in the container. Since the same directory holds `cluster-api-key`, `credentials.dat`, `master.key`, and other load-bearing files, this indicates a broken volume mount or permission drift.

Check:

```bash
docker exec <cluster>-orchestrator-1 ls -ld /var/lib/generacy
# drwxr-xr-x  5 node node ...   <-- owner MUST be node

docker exec <cluster>-orchestrator-1 mount | grep generacy
# tmpfs on /var/lib/generacy type tmpfs (rw,...)   <-- must be rw
```

Fix at the compose-file level. The smee channel drop is a symptom; the underlying `/var/lib/generacy` permission issue will break other things.

### "Persisted smee channel file has malformed content — re-provisioning"

Log line:
```
{"msg":"Persisted smee channel file has malformed content — re-provisioning","path":"/var/lib/generacy/smee-channel","contentPreview":"..."}
```

Root cause: torn write from a prior crash (rare given atomic `.tmp` + `rename()`), or hand-edit of the file with wrong shape.

Fix: none needed. The resolver overwrites the file atomically on the next successful provision. If you want to force it immediately: `docker exec <cluster>-orchestrator-1 rm -f /var/lib/generacy/smee-channel && docker compose restart orchestrator`.

### "Failed to provision smee channel after 2 attempts"

Log line:
```
{"msg":"Failed to provision smee channel after 2 attempts — cluster is webhook-less, falling back to polling","attempts":2,"lastError":"..."}
```

Root cause: smee.io was unreachable during both attempts (10-second window). Common cause on fresh containers: DNS not yet warm. Uncommon: smee.io outage or upstream network filter blocking smee.io.

Fix: retry via `docker compose restart orchestrator`. On the retry, tier 3 runs again. If it still fails after several restarts, check `curl -v https://smee.io/new` from inside the container:

```bash
docker exec <cluster>-orchestrator-1 curl -v -X POST https://smee.io/new
```

A working smee.io returns a `302 Found` with `Location: https://smee.io/<id>`. Any other response indicates external network trouble, not a bug in this feature.

### "cluster is still webhook-less after the fix landed"

Check the gate:

```bash
docker exec <cluster>-orchestrator-1 sh -c 'env | grep -E "SMEE|LABEL"'
```

If `SMEE_CHANNEL_URL` is non-empty, tier 1 wins — the resolver did nothing because env supplied a URL. Verify that URL is not stale/dead: `curl -v https://smee.io/<id-from-env>`.

If `LABEL_MONITOR` env is `false` or unset AND `.generacy/config.yaml` doesn't enable `orchestrator.labelMonitor: true`, the outer gate fails and NO smee logic runs (as designed — a cluster with no label monitoring has no reason to receive webhooks).

## Offline / air-gapped operation

If the cluster runs behind a network filter that blocks smee.io, provisioning fails at tier 3 (see Troubleshooting above). Behavior:

1. Cluster continues to boot normally.
2. `SmeeWebhookReceiver` is not started.
3. `WebhookSetupService.ensureWebhooks()` is not called.
4. Cluster falls back to polling with the default `pollIntervalMs` (30s), not the smee-active `fallbackPollIntervalMs` (300s).
5. Warn log lines are emitted every boot until the network filter is lifted or an env var URL is provided.

There is no way to disable the resolver from running (short of setting `orchestrator.labelMonitor: false`, which disables all label monitoring). This is intentional — the resolver is cheap when it succeeds (one HTTP call) and even cheaper when it fails (two failed attempts + fallback). For long-term air-gapped operation, hand-set `SMEE_CHANNEL_URL` in `.generacy/.env` to an internal webhook-forwarder URL or omit `orchestrator.labelMonitor` from `.generacy/config.yaml`.

## Available commands (none new)

This feature ships zero new user-facing commands. All observation is via existing `docker logs` / `docker exec` / `gh api`.

Future observability (out of scope for this feature, see #954): a `/health` field surfacing `smeeReady: boolean` and/or a relay-side telemetry event for "cluster is webhook-less."
