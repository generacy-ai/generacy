# Quickstart: Verify the wired-up smee doorbell

Confirms end-to-end that (a) the operator session's doorbell selects
`source=smee` from the shared workspace mirror and (b) a simulated
transient `gh` blip at startup no longer strands the run on the heartbeat.

## Prerequisites

- A cluster with a smee-live channel (verify via
  `orchestrator.log | grep 'Resolved smee channel URL'` — expect
  `source=persisted` or `source=provisioned`).
- Operator devcontainer/tunnel with cwd inside a workspace under the
  shared `*_workspace` volume (typical `/workspaces/<repo>/…`).
- Doorbell CLI built and installed
  (`pnpm --filter @generacy-ai/generacy build`).

## Step 1 — Confirm the workspace-mirror file exists

Inside the operator session:

```bash
cat /workspaces/.generacy/cockpit/smee-channel
# → https://smee.io/<channel-id>
stat -c '%a' /workspaces/.generacy/cockpit/smee-channel
# → 644
```

If the file is missing, restart the orchestrator (the resolver writes the
mirror on tier-2 persisted-read and tier-3 provisioning). If it still doesn't
appear, check orchestrator logs for a `Workspace mirror write failed` warn
line — verify the workspace-volume root is writable by the orchestrator uid.

## Step 2 — Run the doorbell from the operator session

```bash
cd /workspaces/<some-repo>
generacy cockpit doorbell <owner>/<repo>#<epic-number>
```

Expected stderr (first ~3s):

```
armed
cockpit doorbell: source=smee reason=startup-smee-selected
```

**No** `source=poll-fallback` line — the doorbell selected smee via the
shared mirror. Any label change on a scope-issue should surface a matching
event to stdout within ~3s (SC-001).

## Step 3 — Trigger a transient `gh` blip at startup (SC-002)

Point `gh` at an invalid host briefly, then restore:

```bash
export GH_HOST=nope.invalid   # forces DNS failures / ECONNREFUSED
timeout 30 generacy cockpit doorbell <epic-ref> &
sleep 5
unset GH_HOST
wait
```

Expected stderr sequence:

```
armed
cockpit doorbell: startup-retry label=resolveEpic reason=enotfound attempt=1
# … repeated retries within ~2 min initial window …
cockpit doorbell: source=smee reason=startup-smee-selected
```

**Never** an `exit(2)` line and no immediate `poll-fallback` transition —
the retry envelope kept the process alive across the transient failure and
recovered when DNS came back.

## Step 4 — Trigger a permanent failure (SC-004)

Invalidate the operator PAT to induce a `401 Bad credentials`:

```bash
export GITHUB_TOKEN=ghp_invalid
generacy cockpit doorbell <epic-ref>
echo "exit=$?"
```

Expected stderr:

```
armed
cockpit doorbell: permanent-error label=resolveEpic reason=bad-credentials
```

Expected exit code: **3** (distinct from arg-parse `exit(2)`). Restore the
real token to continue.

## Step 5 — Confirm no regression on smee-less clusters (SC-005)

On a cluster without a smee channel (no `/var/lib/generacy/smee-channel`,
no `/workspaces/.generacy/cockpit/smee-channel`, no
`COCKPIT_DOORBELL_SMEE_URL`):

```bash
generacy cockpit doorbell <epic-ref>
```

Expected stderr:

```
armed
cockpit doorbell: source=poll-fallback reason=startup-no-channel
```

Poll-cost characteristics unchanged from #970 (SC-005).

## Rollback

The changes are additive: reverting `SmeeChannelResolver`,
`channel-discovery.ts`, and `runDoorbell` to the pre-#980 revisions
restores today's behavior. The mirror file at
`/workspaces/.generacy/cockpit/smee-channel` becomes a harmless stray file;
`rm` it if desired.

## Troubleshooting

- **`source=poll-fallback reason=startup-no-channel` from the operator
  session but `cat /var/lib/generacy/smee-channel` shows a URL inside the
  orchestrator container**: the mirror file was not written to the shared
  volume. Check orchestrator logs for `Workspace mirror write failed`
  warnings; verify volume writability.
- **Doorbell exits `3` on a "known-good" token**: read the `reason=<class>`
  on the stderr line. If it's `unknown`, the classifier didn't match — file
  an issue with the `gh` error output.
- **Late-window recovery took longer than expected**: the late-window
  cadence is 5 min by default; if you need faster recovery, either wait or
  restart `/cockpit:auto`.
