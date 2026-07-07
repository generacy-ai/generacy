# Quickstart: `cockpit advance` label-pair fix (#845)

## What changed for operators

Before the fix, `generacy cockpit advance --gate <name>` did three things: post a marker comment, add `completed:<gate>`, and remove `waiting-for:<gate>`. On poll-only clusters, the third step stranded the issue because the orchestrator's resume detector needs both labels present.

**After the fix**, `advance` posts the marker and adds `completed:<gate>`. It leaves `waiting-for:<gate>` in place. The worker removes both labels (plus `agent:paused`) itself on the next poll cycle when it detects the label pair and resumes.

## Verifying the fix locally

```bash
# On a poll-only cluster (no webhook delivery configured):
generacy cockpit advance <owner>/<repo>#<n> --gate clarification

# Immediately inspect labels:
gh issue view <owner>/<repo>#<n> --json labels -q '.labels[].name'
# Expected: BOTH `waiting-for:clarification` AND `completed:clarification` present.

# Wait one poll interval (default ~30s). Inspect again:
gh issue view <owner>/<repo>#<n> --json labels -q '.labels[].name'
# Expected: NEITHER label present; `agent:paused` removed; worker resumed.
```

## Rolling back a stranded issue (pre-fix bug)

If you have issues already stranded from the pre-fix behavior (`completed:<gate>` set but `waiting-for:<gate>` missing), restore the pair manually:

```bash
gh issue edit <owner>/<repo>#<n> --add-label "waiting-for:<gate>"
```

On the next poll, the worker will detect the pair and resume normally (removing all three labels itself).

## Running the tests

```bash
cd /workspaces/generacy
pnpm --filter @generacy-ai/generacy test src/cli/commands/cockpit/__tests__/advance.test.ts
pnpm --filter @generacy-ai/generacy test src/cli/commands/cockpit/__tests__/advance-marker.test.ts
```

Expected: all pass. The regression case `advance never removes waiting-for:*` guards against the bug returning.

## Output changes

**Stdout summary** (per clarifications Q1→C):

Before:
```
advanced <ref>: waiting-for:<gate> → completed:<gate> (comment: <url>)
```

After:
```
advanced <ref>: completed:<gate> added — waiting-for:<gate> left in place for the worker to clear on resume (comment: <url>)
```

**Marker comment body** (posted to the issue):

Before:
```
Manually advanced `waiting-for:<gate>` → `completed:<gate>` by **@<actor>**.
```

After:
```
Marked `completed:<gate>` by **@<actor>** — `waiting-for:<gate>` left in place for the worker to clear on resume.
```

The HTML prelude (`<!-- generacy-cockpit:manual-advance … -->`) is byte-stable — downstream comment scanners are unaffected.

## Idempotence and refusal (unchanged)

- Re-running `advance` on an issue that already has `completed:<gate>` prints `already advanced <ref>: completed:<gate> is present (no-op)` and exits 0.
- Running `advance --gate X` on an issue waiting on gate Y prints a refusal message and exits 3, with no side effects.

## Troubleshooting

**Symptom**: Issue stays paused after `advance` reports success.
- **Check**: `gh issue view <ref> --json labels`. If `waiting-for:<gate>` is missing but `completed:<gate>` is present, you may be running a pre-fix cockpit CLI. Verify with `generacy --version`.
- **Fix**: Update to the post-#845 CLI, or manually re-add `waiting-for:<gate>` to restore the pair.

**Symptom**: Worker never resumes even with both labels present.
- **Check**: `agent:paused` label present? If not, the pause state may have been cleared out-of-band. Inspect orchestrator logs for `completed:* label seen without matching waiting-for:*` (pre-fix orphan) or `resume` events.
- **Fix**: If the worker container is running, wait one poll cycle (default 30s). If not, ensure the cluster is up (`generacy status`).
