# Quickstart: `/cockpit:auto` doorbell webhook-config discovery

Verify the doorbell reaches `source=smee` end-to-end from an operator session that does not share the cluster's filesystem, without exporting `COCKPIT_DOORBELL_SMEE_URL`.

## Prerequisites

- A cluster whose orchestrator has registered a smee webhook against at least one repo the operator can query. Verify from the operator devcontainer:
  ```
  gh api repos/<owner>/<repo>/hooks --jq '.[] | {id, url: .config.url, active}'
  ```
  Expect at least one entry with `active: true` and `url` matching `https://smee.io/…`.
- The operator's `gh auth token` MUST have `admin:repo_hook` read scope on the target repo. Verify:
  ```
  gh auth status
  ```
  If the scope is missing, `/cockpit:auto` will still start — it will just fall through to the existing FS stages / poll fallback per FR-006.

## Installation

Local build from the repo root:

```
pnpm install
pnpm --filter @generacy-ai/generacy build
```

Or use the shipped bin from `.changeset` releases:

```
npx @generacy-ai/generacy@latest cockpit auto <owner>/<repo>#<issue>
```

## Golden-path usage

From an operator devcontainer that does **not** share the cluster's `/workspaces` or `/var/lib/generacy` mount:

```
unset COCKPIT_DOORBELL_SMEE_URL
generacy cockpit doorbell <owner>/<repo>#<issue> --tracking
```

Expected stderr on startup:
```
cockpit doorbell: source=smee reason=startup-smee-selected
```

Expected stdout on startup:
```
armed
```

Then one JSON line per emitted `CockpitStreamEvent` as webhook events arrive on the shared smee channel.

## Verification checklist

- [ ] With `COCKPIT_DOORBELL_SMEE_URL` unset and no shared cluster FS, stderr contains `source=smee reason=startup-smee-selected` (SC-001).
- [ ] `gh api repos/<owner>/<repo>/hooks` is called **once** at startup — count with `NODE_DEBUG=1` or by instrumenting a wrapper (SC-002).
- [ ] Delete the operator's `admin:repo_hook` scope, re-run: expect exit code 0 and a stderr line `source=poll-fallback reason=startup-no-channel` (SC-003).
- [ ] Simulate a hung `gh api` call (e.g., `PATH=/tmp/hang-gh:$PATH` where `/tmp/hang-gh/gh` is a shell script that sleeps): expect the stage to time out at ~5s and stderr to show a webhook-config warn line followed by fall-through to walk-up (SC-005).
- [ ] Register a second stale smee hook on the target repo (disabled or older `updated_at`); re-run: expect the currently-active newest hook's URL, not the stale one (SC-004).

## Available commands

Unchanged. This feature does not add new CLI verbs.

```
generacy cockpit doorbell <ref>            # form 1: track ref + emit events
generacy cockpit doorbell <ref> --tracking # form 2: same, tracking mode
generacy cockpit doorbell --new '<title>'  # form 3: bootstrap-new
```

## Troubleshooting

**Problem**: Stderr says `source=poll-fallback reason=startup-no-channel` even though the orchestrator has a webhook registered.

**Diagnose**:
1. Confirm the token scope: `gh auth status`. Missing `admin:repo_hook` → 403 fall-through (expected).
2. Confirm the webhook is smee-shaped: `gh api repos/<owner>/<repo>/hooks --jq '.[] | .config.url'`. If the URL is not `https://smee.io/…`, the stage ignores it by design (FR-002).
3. Confirm the epic's ref set resolves: `gh api repos/<owner>/<repo>/issues/<issue> --jq .body` — if the body is empty or has no ref-shaped lines, `resolveWebhookTargets` returns `[]` and the stage no-ops.
4. Run with `--verbose` (if available) or `NODE_DEBUG=1` to see the webhook-config warn lines.

**Problem**: `cockpit doorbell: webhook-config stage failed for <owner>/<repo>: exit=124` in stderr.

**Cause**: The `gh api` call took longer than 5s. Common reasons: proxy stalls, GitHub degraded status, corporate MITM inspection.

**Workaround**: Export `COCKPIT_DOORBELL_SMEE_URL=https://smee.io/<channel>` — env override is still tier-1 (unchanged from #978).

**Problem**: Two active smee hooks on the same repo, doorbell picks the wrong one.

**Cause**: Tie-break sorts by `updated_at` desc. If both hooks were PATCHed at the same second (extremely rare), ordering falls back to `pickSmeeHook`'s sort stability (implementation-dependent).

**Workaround**: Delete the stale hook (`gh api -X DELETE /repos/<owner>/<repo>/hooks/<id>`).

## Removed workaround

Once this change ships, the interim `export COCKPIT_DOORBELL_SMEE_URL=…` step from the #980 rollout notes is no longer required for operator sessions that lack a shared cluster FS mount. Keep it documented as an escape hatch for the timeout / scope-lack cases above.
