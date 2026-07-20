# Quickstart: Verifying the fix

This feature has no user-visible install / config surface — the field is emitted automatically by the orchestrator and the gate is applied automatically by the control-plane. The only observable change on a working cluster is that the pre-restart tunnel button never lets you burn a device code that will be silently destroyed.

## Preconditions

- A fresh wizard-provisioned Generacy cluster (either `cluster-base` or `cluster-microservices` variant) on the target build.
- Cluster-image entrypoint writes `/var/lib/generacy/post-activation-restart-done` immediately before `docker restart` (already true on current images per Q1/A).
- Companion `generacy-cloud` PR merged (for FR-006 UI gating — otherwise the tunnel button appears but the server-side skip still protects the auth flow).

## Verifying `postActivationReady` on `/health`

Inside the orchestrator container of a freshly activated wizard cluster, during the pre-restart window:

```bash
curl -s http://localhost:3100/health | jq '{postActivationReady, codeServerReady, controlPlaneReady}'
```

Expected during pre-restart:
```json
{
  "postActivationReady": false,
  "codeServerReady": false,
  "controlPlaneReady": true
}
```

After the post-activation self-restart completes:
```json
{
  "postActivationReady": true,
  "codeServerReady": true,
  "controlPlaneReady": true
}
```

On a local (`generacy launch`) cluster, `postActivationReady` should be `true` immediately after boot (SC-004):

```bash
# From host
docker exec <local-cluster>-orchestrator-1 curl -s http://localhost:3100/health | jq '.postActivationReady'
# → true
```

## Verifying the `vscode-tunnel-start` skip

Directly POST to the control-plane socket from inside the orchestrator container during the pre-restart window:

```bash
curl -sS --unix-socket /run/generacy-control-plane/control.sock \
  -X POST http://x/lifecycle/vscode-tunnel-start \
  -H 'Content-Type: application/json' \
  -H 'x-generacy-actor-user-id: quickstart' \
  -H 'x-generacy-actor-session-id: quickstart' \
  -d '{}'
```

Expected response (pre-restart):
```json
{
  "accepted": false,
  "action": "vscode-tunnel-start",
  "deferred": false,
  "reason": "post-activation-not-settled",
  "message": "Cluster is still starting up; retry once postActivationReady is true"
}
```

Verify **no** `code tunnel` child process was spawned:
```bash
docker exec <cluster>-orchestrator-1 pgrep -f 'code tunnel'
# → (no output; exit 1)
```

## Verifying the `bootstrap-complete` step (d) skip

Look at control-plane logs during the pre-restart window after `bootstrap-complete` fires:

```
info: Skipped tunnelManager.start() in bootstrap-complete: cluster pre-restart (postActivationReady=false)
```

The response body from `POST /lifecycle/bootstrap-complete` is unchanged (`{ accepted: true, action: 'bootstrap-complete', sentinel: '<path>' }`). Only the internal step (d) is skipped.

## End-to-end scenario (SC-001 — first-time tunnel connect on fresh wizard cluster)

1. Provision a new cluster via the cloud wizard.
2. Watch the UI: "Connect with VS Code Desktop" button is disabled (companion cloud PR) until `postActivationReady === true` propagates.
3. Wait for the post-activation self-restart to complete. The button re-enables within seconds (target SC-002: ≤5s p95 from marker write to cloud-received update).
4. Click the button, complete the GitHub device-code authorization in the browser tab.
5. Verify token persisted:
   ```bash
   docker exec <cluster>-orchestrator-1 ls -la /home/node/.vscode/cli/
   # → token.json present, mtime after the auth
   ```
6. Verify tunnel connected:
   ```bash
   docker exec <cluster>-orchestrator-1 curl -sS --unix-socket /run/generacy-control-plane/control.sock \
     http://x/health | jq
   # (or listen for cluster.vscode-tunnel: { status: 'connected' } on the relay)
   ```

Expected metric: single `authorization_pending` event emitted on `cluster.vscode-tunnel` between fresh activation and `connected` (SC-003). No device codes burned to timeout.

## Reproducing the pre-fix bug (for regression verification)

To confirm the fix addresses the actual failure mode:

1. On a build **without** the fix, provision a wizard cluster.
2. Immediately after the "Active/Connected" UI state appears, click "Connect with VS Code Desktop" and complete GitHub device-code auth as fast as possible.
3. Observe: modal shows "Timed out waiting for device-code authorization" ~5 minutes later.
4. Check `token.json` absent from `/home/node/.vscode/cli/` inside the orchestrator container despite successful browser auth.
5. Check orchestrator logs for a SIGTERM near the auth completion timestamp.

On the same build **with** the fix, step 2's button click is either UI-gated (returns nothing to click) or, if bypassed, returns the skip response — no auth is initiated, so nothing is destroyed.

## Rollback

Feature is additive:
- The new `postActivationReady` field on `/health` and metadata is optional; removing it is safe (older consumers that ignored it are unaffected).
- The lifecycle-handler gate is a conditional wrapper around existing code; removing the conditional restores pre-fix behavior.

There's no data migration to unwind, no persistent state introduced, no cross-service protocol version bumps beyond the additive schema field.

## Troubleshooting

**Symptom**: `postActivationReady === false` forever on a wizard cluster.
- Check that `/var/lib/generacy/post-activation-restart-done` gets written by `entrypoint-post-activation.sh` (log line: "Wrote restart marker"). If not, the cluster-image entrypoint is misbehaving — unrelated to this repo's fix.
- Check that `/var/lib/generacy` is mounted from the `generacy-data` volume on the orchestrator container.
- Check that `/var/lib/generacy/cluster-api-key` exists (proof that `activated === true`; if absent, the fallback `!activated` branch should have made `postActivationReady === true` immediately).

**Symptom**: `postActivationReady === true` but tunnel button still disabled in UI.
- Companion cloud PR is not deployed. The server side is correct; only the UI gate is missing.

**Symptom**: `postActivationReady === true` on cluster metadata is delayed >30s past the marker-file write.
- The `fs.watch`-based push may have missed the create event (rare on Linux). Check that the periodic 60s heartbeat eventually surfaces the bit. File a follow-up issue if repeatable.

**Symptom**: Local (`generacy launch`) cluster reports `postActivationReady: false`.
- The predicate is `(NOT activated) OR (marker present)`. If `activated` is somehow `true` on a local cluster (`cluster-api-key` file was written incorrectly), the gate activates. Check whether the local cluster accidentally holds a stale key file from a prior cloud activation.
