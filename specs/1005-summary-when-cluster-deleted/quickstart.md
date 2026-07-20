# Quickstart: Adopt existing smee channel on cluster delete→relaunch

**Issue**: [#1005](https://github.com/generacy-ai/generacy/issues/1005)
**Branch**: `1005-summary-when-cluster-deleted`

Operator-facing playbook for verifying the fix on a real cluster. Not part of the shipped codebase — a validation script and a troubleshooting guide.

## What the fix does

- **Before:** `cluster destroy` + `cluster up` on the same repo → new smee channel → old GitHub webhook is orphaned → label events degrade to a 5-min polling fallback until ops intervenes.
- **After:** `cluster destroy` + `cluster up` on the same repo → resolver inspects the repo's existing hooks → adopts the surviving smee channel URL → new cluster listens on the same channel GitHub already delivers to → label events arrive within seconds.

## Repro / validation

### 0. Preconditions

- A test repo with the Generacy GitHub App installed (`admin:repo_hook` scope granted per #972).
- A workstation with `generacy` CLI installed (Node ≥ 22).
- `gh` CLI authenticated to a token that can list the repo's webhooks (for verification).

### 1. Baseline: run an initial cluster

```bash
cd ~/generacy-clusters
generacy launch --claim=<code>
# ... wait for cluster to reach "ready"
```

Verify a smee-mode label event lands within seconds by adding `process:speckit-feature` to an issue on the test repo. The orchestrator log should show:

```
source=webhook  parsedName=process:speckit-feature
```

Record the smee channel URL from the log line `Provisioned new smee channel URL   channelUrl=https://smee.io/<X>`.

### 2. Destroy the cluster

```bash
generacy destroy --yes
# volumes wiped → /var/lib/generacy/smee-channel is gone
```

Confirm the repo's webhook still exists:

```bash
gh api /repos/<owner>/<repo>/hooks --jq '.[] | {id, url: .config.url, active}'
# → prints hook id + URL matching https://smee.io/<X>
```

### 3. Relaunch on the same repo

```bash
generacy launch --claim=<code>   # or generacy up if the .generacy/ dir survived
```

**Watch the orchestrator log during boot.** With the fix, you should see:

```
info  Adopted existing smee channel URL from repo webhook   channelUrl=https://smee.io/<X>  source=adopted
info  Smee receiver connected — monitors flipped to webhook mode
```

You should NOT see:

```
info  Provisioned new smee channel URL   ...   source=provisioned
warn  Foreign webhook present; not modifying   foreignUrl=https://smee.io/<X>
```

The presence of the second pair is the pre-fix failure signature.

### 4. Add a label, expect near-instant delivery

```bash
gh issue edit <n> --add-label process:speckit-feature
```

The orchestrator log should show a webhook-mode event within seconds (well under 30 s, matching SC-001):

```
Processing label event   issueNumber=<n>  source=webhook   parsedName=process:speckit-feature
```

If instead you see `source=poll` at the 5-min mark, the fix is not active — see Troubleshooting.

## Regression: healthy `docker restart` (US2)

```bash
docker compose -f .generacy/docker-compose.yml restart
```

Verify the orchestrator log shows:

```
info  Reusing persisted smee channel URL   source=persisted
```

And NOT any `list-hooks` GitHub API call (grep the log for `_listRepoWebhooks` invocation; should be absent on this path). This confirms SC-003 — zero extra API calls on the healthy-restart path.

## Regression: operator smee.io hook untouched (US3)

Not usable as a live test because Generacy considers all `smee.io` hooks on a Generacy repo as Generacy-owned (per clarification Q1-A). If you have a non-`smee.io` foreign webhook (e.g., a Slack notifier), verify after relaunch that:

```bash
gh api /repos/<owner>/<repo>/hooks --jq '.[] | {id, url: .config.url, active}'
```

shows your foreign webhook untouched (same id, same URL, same active flag) and additionally the Generacy smee.io hook pointing at the adopted channel.

## Troubleshooting

### `source=provisioned` after cluster destroy → relaunch on the same repo

The adopt tier didn't fire. Common causes:

- **Persisted file survived** (`docker restart` instead of `generacy destroy`) — check `docker exec <orchestrator> ls -la /var/lib/generacy/smee-channel`. If present, that's why persisted-tier hit first — this is correct behavior, not a bug.
- **GitHub API 403 during adopt discovery** — grep orchestrator log for `Failed to list webhooks during smee channel discovery`. If present, the `admin:repo_hook` scope is missing (see #972); resolve that first, then relaunch.
- **Multiple Generacy smee hooks on the repo** (legacy cruft from pre-fix clusters) — the adopt tier picks the first one, but if that hook itself is a dead channel and GitHub only delivers to the newer live one, adopt may pick the wrong URL. Ops sweep: `gh api /repos/<owner>/<repo>/hooks --jq '.[] | select(.config.url | startswith("https://smee.io/")) | .id'` — delete extras manually to converge.

### `Foreign webhook present; not modifying` on relaunch

Take-over branch (B) bailed. Common causes:

- **≥2 stale Generacy smee hooks on the repo** (Q3-A / Q5-C guarantee) — the take-over branch bails when there is more than one Generacy smee hook to avoid duplicate-delivery. Ops sweep as above.
- **The hook's URL doesn't start with `https://smee.io/`** — the take-over branch only targets Generacy hooks; a genuinely foreign URL is skipped as intended (US3).

### Multi-repo divergence warning at boot

```
warn  Repo Generacy smee channel disagrees with first-repo winner — deferring to take-over on next self-heal
```

This is expected legacy state — repos disagree because different prior clusters wrote different channels. The take-over branch will converge the divergent repos onto the adopted channel over subsequent self-heal passes. No action required unless you see the same warning after several self-heal cycles, in which case one of the divergent repos may have ≥2 hooks and needs ops sweep.

## Rollback

The fix is a resolver-tier addition. To disable (should never be needed), stop passing `discoverExistingChannel` and `repos` to `SmeeChannelResolver`'s options. The resolver will skip tier 3 and fall through to tier 4 (provision) exactly as pre-fix.

Since this is a `patch` bump for `@generacy-ai/orchestrator` with no public API change, rollback via version pin does not affect any consumer.

## Related work

- **#972** — the persisted-URL healing path (branch 2 of `_selectExistingHookForUpdate`) landed via the snappoll fail-loud fix. This issue extends the decision matrix with the take-over branch (branch 3) that targets the "persisted file didn't survive at all" case.
- **#952** — original resolver tier structure. This fix inserts tier 3 into that structure.
- **cluster-base entrypoint** — no changes needed; the fix is entirely in-process on the orchestrator.
