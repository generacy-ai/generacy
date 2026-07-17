# Quickstart — #972 Webhook-Registration Fail-Loud

## Repair path for an existing cluster (US2)

Prereq: the Generacy GitHub App manifest has been updated with repository `Webhooks: Read & write` (`admin:repo_hook`). See "GitHub App manifest change" below.

1. In `github.com/settings/apps/<generacy-app>/installations`, the installation banner will read _"New permissions requested"_. Approve.
2. On the operator machine, restart the affected cluster:
   ```bash
   generacy stop
   generacy up
   ```
3. Verify healing:
   ```bash
   # In the cluster's monitored repo:
   gh api /repos/<owner>/<name>/hooks --jq '.[] | select(.config.url | startswith("https://smee.io/")) | {id, active, url: .config.url, events}'
   ```
   Expected output:
   ```json
   {
     "id": 123456789,
     "active": true,
     "url": "https://smee.io/<current-channel-id>",
     "events": ["issues", "pull_request", "check_run", "check_suite"]
   }
   ```
4. Confirm the dashboard banner cleared (cluster status returns to `ready`).
5. Confirm poll-fallback stopped: watch `docker compose logs -f orchestrator` for 60 s and grep for `API rate limit already exceeded for installation ID` — expect zero hits.

## Verifying the fail-loud path on a mis-provisioned cluster

To confirm the loud-failure signals fire correctly (SC-002 anchor), simulate a 403 on a scratch cluster:

1. Boot a cluster whose Generacy App installation is **missing** the `admin:repo_hook` scope (i.e., the pre-fix state, or a scratch App install where the scope is deliberately not granted).
2. Watch orchestrator logs during startup:
   ```bash
   docker compose logs -f orchestrator | grep -i webhook
   ```
   Expected — one line per repo:
   ```
   {"level":"warn","msg":"Webhook registration forbidden: missing admin:repo_hook scope","owner":"<owner>","repo":"<repo>","installationId":<id>,"missingScope":"admin:repo_hook","reason":"webhook-registration-forbidden","ghStderr":"gh: Resource not accessible by integration (HTTP 403)"}
   ```
3. Watch the cloud UI dashboard for the cluster — expect the status to transition to `degraded` with reason `webhook-registration-forbidden` and a banner explaining the missing scope.
4. Inspect the relay-event stream (on the cloud side, or by tailing the orchestrator's relay outbound if instrumented):
   ```jsonc
   {
     "type": "event",
     "event": "cluster.bootstrap",
     "data": {
       "status": "failed",
       "reason": "webhook-registration-forbidden",
       "repo": "<owner>/<repo>",
       "installationId": <id>,
       "missingScope": "admin:repo_hook"
     },
     "timestamp": "2026-07-17T..."
   }
   ```
5. All three signals (log line, relay event, degraded status) MUST be present for the same 403. If any one is missing, the fix is incomplete.

## Scratch-repo end-to-end validation (SC-003 + FR-007)

Prove that granting `admin:repo_hook` on a scratch App install actually fixes the failure end-to-end:

1. Create a scratch GitHub App with only the permissions Generacy needs plus `Webhooks: Read & write`. Install it on a throwaway repo (`<you>/generacy-scratch-972`).
2. Boot a Generacy cluster pointed at `<you>/generacy-scratch-972`:
   ```bash
   mkdir /tmp/scratch-972 && cd /tmp/scratch-972
   generacy launch --claim <claim-from-cloud>
   ```
3. Verify webhook creation:
   ```bash
   gh api /repos/<you>/generacy-scratch-972/hooks --jq '.[] | {id, url: .config.url, events, active}'
   ```
   Expect a single hook with `config.url` equal to the cluster's provisioned smee channel URL (visible in `/var/lib/generacy/smee-channel` inside the container), events `["issues","pull_request","check_run","check_suite"]`, `active: true`.
4. Verify the initial `ping`:
   ```bash
   # In the orchestrator container logs:
   docker compose logs orchestrator | grep -i "ping"
   ```
   Expect at least one log line from `SmeeWebhookReceiver` acknowledging receipt of a GitHub `ping` event through the smee channel.
5. Trigger a follow-up event to prove end-to-end delivery:
   ```bash
   gh label create test-972 --repo <you>/generacy-scratch-972
   gh issue create --repo <you>/generacy-scratch-972 --title "smoke" --body "" --label test-972
   ```
   Expect the orchestrator's `LabelMonitorService` to receive the `labeled` action through smee within 2 s (not via a poll after 30 s).

## GitHub App manifest change (out of this repo)

The Generacy GitHub App manifest is edited at `github.com/settings/apps/<generacy-app>`. Under **Permissions → Repository**, set **Webhooks** to **Read & write**. Save. Existing installations show a "New permissions requested" banner and must approve once.

This edit is a manual operator action and is **not** performed by any code in this issue.

## Troubleshooting

**Symptom: after restart, the hook is created but no events arrive at smee.**
- Verify the smee channel URL is reachable: `curl -I https://smee.io/<channel-id>` should return `200`.
- Verify the hook's `config.url` equals the cluster's current provisioned channel URL:
  ```bash
  cat /var/lib/generacy/smee-channel   # inside the orchestrator container
  gh api /repos/<owner>/<name>/hooks --jq '.[].config.url'
  ```
  If they differ, the persisted-URL match (row 6 in `contracts/ensure-webhooks-behavior.md`) should have PATCHed the hook — check orchestrator logs for `Updated Generacy webhook to current channel URL`.

**Symptom: after restart, `ensureWebhooks` still returns 403.**
- The App-manifest edit did not save, or the installation did not accept the new permission. In `github.com/settings/apps/<generacy-app>/permissions`, confirm `Webhooks: Read & write` is present.
- In `github.com/settings/installations/<installation-id>`, confirm the banner is cleared (i.e., the operator accepted the new permission on the installation, not just on the App).

**Symptom: `Foreign webhook present; not modifying` on a repo we own.**
- A hook already exists on the repo whose `config.url` matches neither the current provisioned smee channel nor the previously-persisted one. Either the hook is genuinely third-party (leave alone), or it's a Generacy hook from a cluster that was destroyed before the persisted file was carried forward.
- Remediation: manually delete the stale hook via `gh api -X DELETE /repos/<owner>/<name>/hooks/<id>` and restart — the next boot will hit row 9 (create) instead of row 8 (skip).

**Symptom: `installationId: null` on the relay event.**
- Non-fatal — `.agency/credentials.yaml` does not have a resolvable `github-app` entry. The event is still actionable from `reason` + `repo` + `missingScope`.

## Available commands / points of observation

| What | Where |
|------|-------|
| Structured warn log line (FR-002 log-half) | `docker compose logs orchestrator \| grep "Webhook registration forbidden"` |
| Relay event (FR-002 event-half, FR-006) | Cloud dashboard cluster page; or tail relay outbound if instrumented |
| Degraded status (FR-003) | Cloud dashboard cluster status widget; or `gh api` on control-plane's `/state` route if exposed |
| Current provisioned channel URL | `cat /var/lib/generacy/smee-channel` (inside container) |
| Registered hooks on a repo | `gh api /repos/<owner>/<name>/hooks` |
| Poll-vs-webhook confirmation (SC-001) | 1-hour tail of orchestrator logs grep for `API rate limit already exceeded for installation ID` — expect 0 |
