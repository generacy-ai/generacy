# Quickstart: Journal-based stuck detection (G5.2)

**Branch**: `793-epic-generacy-ai-tetrad`

## What this gives you

When a worker is assigned to an issue (label `agent:in-progress`) but its
conversation journal has not advanced in a while, `cockpit status` shows it
as **STALE** and `cockpit watch` emits a `stuck` event. When the journal
advances again, `cockpit watch` emits a `recovered` event.

No timers, no daemons — it's a read-only sensor that runs on every
`cockpit status` invocation and every `cockpit watch` poll.

## Configure the threshold

Edit `.generacy/config.yaml`:

```yaml
cockpit:
  owner: generacy-ai
  repos:
    - generacy-ai/generacy
  stuckThresholdMinutes: 15      # default
```

- Default: **15 minutes**.
- Increase if your phases routinely have long quiescent periods (large `validate`
  waits, slow CI, long human reviews).
- Decrease if you want faster detection of crashed/hung workers.
- Must be a positive integer.

There is no per-invocation CLI override in this iteration (clarif. Q5=A).

## See it in action

### `cockpit status`

```bash
$ pnpm --filter @generacy-ai/generacy build
$ node packages/generacy/bin/generacy.js cockpit status --repos generacy-ai/generacy
REPO                #NUM    STATE      STUCK   SOURCE                           PR ...
generacy-ai/generacy #793   active             agent:in-progress                PR ...
generacy-ai/generacy #794   active     STALE   agent:in-progress                PR ...
```

JSON envelope:

```bash
$ node packages/generacy/bin/generacy.js cockpit status --repos generacy-ai/generacy --json | jq '.rows[] | select(.stuck)'
{
  "repo": "generacy-ai/generacy",
  "number": 794,
  "state": "active",
  "sourceLabel": "agent:in-progress",
  "stuck": true,
  "stuckReason": "stale",
  "...": "..."
}
```

### `cockpit watch`

```bash
$ node packages/generacy/bin/generacy.js cockpit watch --repos generacy-ai/generacy
cockpit: watching generacy-ai/generacy; emitting on transition (interval=5000ms)
{"ts":"2026-06-29T20:15:00Z","event":"stuck","number":794,"sourceLabel":"agent:in-progress","stuckReason":"stale","...":"..."}
{"ts":"2026-06-29T20:21:30Z","event":"recovered","number":794,"sourceLabel":"agent:in-progress","...":"..."}
```

## What counts as "in progress"?

Only issues classified `active` with `sourceLabel === 'agent:in-progress'`
trigger the sensor. PRs, issues `waiting-for:*`, `terminal`, `error`,
`pending`, etc., never trip a `stuck` flag.

## What counts as "stuck"?

The sensor reads `specs/{issueNumber}/conversation-log.jsonl` and looks at
the **timestamp of the most recent parseable entry**. If that timestamp is
older than `stuckThresholdMinutes`, the issue is `stuck` with reason
`'stale'`.

If the file is missing entirely, the issue is **not stuck** (`stuck=false`,
`stuckReason=null`). Rationale (clarif. Q1=A): the journal is written
shortly after dispatch, so "missing" is transient — not a useful signal.

If the file exists but is unreadable or corrupt, the issue is **not stuck**
but `stuckReason='no-journal'`, and the cause is written to stderr
(clarif. Q4=A).

## Recovery

Two ways a stuck issue stops being stuck:

1. **Journal advances** — `cockpit watch` emits `recovered`.
2. **Issue leaves `agent:in-progress`** (label change, agent finishes,
   phase advances) — `cockpit watch` emits `label-change` *only*. No
   separate `recovered` event (clarif. Q2=A).

`cockpit status` shows the resulting state in either case.

## Troubleshooting

### "I expected `stuck` but the issue is not flagged"

Check, in order:

1. Is the issue's label set really `agent:in-progress`? Other labels
   (`agent:dispatched`, `agent:paused`) do not trigger the sensor.
2. Does the file `specs/{issueNumber}/conversation-log.jsonl` exist? If
   not, the sensor returns `not stuck` per Q1=A.
3. Has the threshold elapsed? Compute `now - lastEntry.timestamp` and
   compare to `stuckThresholdMinutes`.

### "I see `stuckReason='no-journal'` in `cockpit status`"

The file exists but cockpit could not read it. Check stderr for the
specific cause. Common causes:

- The file is owned by the worker (different uid) and the cockpit caller
  cannot read it. Fix the perms.
- The file is mid-write and produced a partial line. Re-run after the
  worker's next flush (≤ 30s).

### "I am getting double-fire of `label-change` and `recovered`"

You should not. If you do, file a bug — the `diffIssue` dedupe logic in
`packages/generacy/src/cli/commands/cockpit/watch/diff.ts` is meant to
prevent it (Q2=A).

### "I want a CLI flag to override the threshold for one run"

Deferred (clarif. Q5=A). If you want this, open a follow-up issue with
your use case.

## Related files

- `packages/cockpit/src/journal.ts` — the sensor
- `packages/cockpit/src/config/schema.ts` — config field
- `packages/generacy/src/cli/commands/cockpit/status.ts` — status wiring
- `packages/generacy/src/cli/commands/cockpit/watch.ts` — watch wiring
- `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` — event emission
