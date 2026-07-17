# Quickstart: Cockpit doorbell smee-mode

## What changed

`generacy cockpit doorbell <epic-ref>` used to always fall back to a 30 s
GitHub poll loop for its wake source, capping notification latency at ~25 s.
It now subscribes to the cluster's smee.io SSE channel when one is
configured, cutting p95 latency to ~3 s.

## Requirements

- Node >=22 (already required by `@generacy-ai/generacy`).
- A smee channel URL that the orchestrator has resolved and persisted.
  Standard cluster boot writes it to `/var/lib/generacy/smee-channel`.
- Repository webhook registered (blocked by #972 until that lands). Without
  the repo webhook, smee.io delivers zero events — the doorbell falls
  through to the poll safety net.

## Running the doorbell

Same command surface as before:

```bash
generacy cockpit doorbell owner/repo#123
```

On smee-live clusters, expect an immediate:

```
armed
```

on stdout, followed by:

```
cockpit doorbell: source=smee reason=startup-smee-selected
```

on stderr. Each subsequent line on stdout is a wake signal (`label-change`,
`issue-closed`, `pr-merged`, `pr-closed`, `pr-checks`, `phase-complete`,
`epic-complete`).

On webhook-less clusters, the stderr line reads:

```
cockpit doorbell: source=poll-fallback reason=startup-no-channel
```

and behavior is identical to today's ship (30 s poll).

## Overriding the channel URL

For tests or bespoke setups, set:

```bash
export COCKPIT_DOORBELL_SMEE_URL=https://smee.io/your-channel-id
generacy cockpit doorbell owner/repo#123
```

The env var takes precedence over the persisted file. Invalid values
warn to stderr and fall through to file discovery.

## Interpreting the `source=…` stderr line

Every source change writes one line. Grep for `cockpit doorbell: source=`
to see the transition timeline:

```
cockpit doorbell: source=smee reason=startup-smee-selected      # armed on smee
cockpit doorbell: source=poll-fallback reason=smee-runtime-lost # 5 failed reconnects or 5 min without success
cockpit doorbell: source=smee reason=smee-re-promoted           # re-promoted after 5-min retry
```

Reasons:
- `startup-smee-selected` — a valid channel URL was found at startup.
- `startup-no-channel` — no valid channel URL; running poll-mode from boot.
- `smee-runtime-lost` — smee session was established then lost.
- `smee-re-promoted` — after a runtime loss, smee re-connected.

## Troubleshooting

### "I have a smee channel, but the doorbell says `startup-no-channel`"

Check the discovery precedence:

1. `echo "$COCKPIT_DOORBELL_SMEE_URL"` — must be empty or a valid
   `https://smee.io/<id>` URL.
2. `cat /var/lib/generacy/smee-channel` — must contain a
   `https://smee.io/<id>` URL, mode 0600. If the file is missing or has a
   different mode, the orchestrator's `SmeeChannelResolver` hasn't
   provisioned it yet.
3. Confirm the orchestrator is running smee: check orchestrator logs for
   `Starting smee.io webhook receiver`.

### "Doorbell keeps flipping between smee and poll"

- Look for `source=smee reason=smee-re-promoted` immediately followed by
  `source=poll-fallback reason=smee-runtime-lost` — that's oscillation.
- Check `SmeeWebhookReceiver`'s logs on the orchestrator side; if it's also
  seeing frequent disconnects, smee.io is under load or a network path is
  flaky.
- Every transition writes one line; the ratio of `smee-re-promoted` :
  `smee-runtime-lost` gives you the oscillation cadence.

### "phase-complete / epic-complete not firing in smee mode"

Aggregates are computed on completion signals only. Confirm the underlying
webhook actually delivered:

- `completed:<phase-name>` labels arrive as `issues.labeled` from GitHub.
- Issue closes arrive as `issues.closed`.
- PR closes/merges arrive as `pull_request.closed`.

If those events don't arrive at smee.io (repo webhook missing, #972 not
merged, network issue), the poll safety-net still catches up on the next
demote.

### "The doorbell is emitting no lines but the epic is definitely progressing"

Run against the same epic in poll-only mode by unsetting the discovery paths:

```bash
COCKPIT_DOORBELL_SMEE_URL=/dev/null generacy cockpit doorbell owner/repo#123
```

If poll-only emits lines but smee-mode doesn't, the smee channel isn't
receiving the underlying webhook. If neither emits, the epic really is
quiescent.

## Available commands (unchanged)

```
generacy cockpit doorbell <epic-ref> [--tracking] [--exit-on-epic-complete]
generacy cockpit doorbell --new <title>
```

## What DIDN'T change

- `armed\n` timing (still immediately after arg validation).
- Stdout event line format (`event.type\n`).
- `CockpitStreamEvent` schema — no new event types (Q1=A).
- Poll-fallback behavior — identical to today's ship, all #970 poll-cost
  reductions intact.
- `--exit-on-epic-complete` semantics.

## Follow-ups

- **on-sibling-review wake via smee** — the doorbell does NOT translate
  `pull_request_review` events today (Q1=A). File a follow-up if the
  cross-repo `on-sibling-review` gate should also ride smee.
- **#972 repo webhook registration** — required for any smee traffic to flow
  through the cluster. Until it lands, smee-mode is well-tested but idle;
  the poll safety-net covers.
