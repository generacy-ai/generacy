# Quickstart: Cockpit GraphQL rate-limit fix

## What changed for operators

- `cockpit watch` and MCP `cockpit_await_events` polls now share a short-TTL cache and a rate-limit-aware scheduler. On a healthy budget you see today's behavior. When your GitHub GraphQL budget drops below 20 %, the poll interval widens automatically; below 5 %, it widens further. Max 5 minutes. Resets to 30 seconds once you climb back above 30 %.
- `resolveEpic` (the epic body re-parse) now runs every 10th cycle (~5 min at default cadence) instead of every cycle. Operator edits to the epic body take up to ~5 min to surface. Acceptable per clarification Q5=A.
- Merged/closed PRs are no longer polled for check runs. Green PRs are only re-checked when the head SHA changes, a label changes, or every 20th cycle (safety re-fetch, ~10 min).

## What operators should NOT notice

- No CLI flag changes.
- No config-file changes.
- No NDJSON output changes for `cockpit watch`.
- No MCP schema changes for `cockpit_await_events` or `cockpit_status`.

## How to verify the fix is active

Watch the scheduler's structured log lines while `/cockpit:auto` runs:

```
event-bus: rate-limit-scheduler probe: remaining=4823/5000 (96.5%), interval=30000ms
event-bus: rate-limit-scheduler probe: remaining=920/5000 (18.4%), interval=60000ms  (widened, low budget)
event-bus: rate-limit-scheduler probe: remaining=180/5000 (3.6%), interval=120000ms  (widened, critical)
event-bus: rate-limit-scheduler probe: remaining=4500/5000 (90.0%), interval=30000ms  (reset)
```

The `cockpit watch` loop emits `rate-limit-scheduler` under the same logger prefix — different subsystem name only.

## How to force a widening for testing

```bash
GH_TOKEN=<token-with-low-budget> generacy cockpit watch <epic-ref>
# OR exhaust budget with a burst then observe:
gh api graphql -f query='query{viewer{login}}' # x many times
```

The scheduler probes on start, then every 5 min (or every 1 min once low). Widening happens on the next probe after budget dips.

## Rollback

If the caching or scheduler regresses a workflow, both are opt-in on `GhCliWrapper`:

```ts
// Full opt-out (returns to pre-#970 behavior):
new GhCliWrapper(runner);

// Cache only, no scheduler:
new GhCliWrapper(runner, logger, { cache: createGhResponseCache() });
```

The `cockpit watch` and event-bus callers construct wrappers with both opted-in by default. To disable at operator level, set `COCKPIT_DISABLE_CACHE=1` (added if a rollback is needed — not shipped by default).

## Known limitations

- **Dual poll (root cause #1) not fixed here.** `/cockpit:auto` still arms both `cockpit watch` (Monitor doorbell) and `cockpit_await_events`. Collapsing them requires the agency-side companion issue `generacy-ai/agency`. Once collapsed, the per-hour GraphQL cost roughly halves again from this plan's baseline.
- **Response headers not consumed.** `gh pr checks` / `gh issue view` don't surface `x-ratelimit-*` headers in our shell-out model. The scheduler relies on the `gh api rate_limit` probe. See clarification Q2=B.
- **Operator scope edits lag by up to ~5 min.** The `resolveEpic` cadence is every-10-cycles. Documented tradeoff per Q5=A.

## Rollout checklist

- [ ] Preview channel: verify `/cockpit:auto` completes a full test-run epic (~30 refs, ~4 open PRs) without 403 rate-limit errors.
- [ ] Preview channel: confirm scheduler probe log lines appear at expected cadence.
- [ ] Preview channel: confirm event-bus catch-up-skip does not drop events on `cockpit_await_events` re-acquire (integration test covers this; smoke test in dev anyway).
- [ ] Production channel: monitor `gh api rate_limit` shows sustained `remaining > 30%` during typical operator load.

## Troubleshooting

**"Events are late by ~30 s."** — Poll interval widened due to low budget. Check `event-bus: rate-limit-scheduler` log lines. Wait for reset at `remaining >= 30%`.

**"An epic body edit didn't show up for 5 min."** — Expected. `resolveEpic` runs every 10 cycles. Restart the loop for immediate refresh.

**"cockpit_status shows a stale label."** — Cache TTL is 20 s. Wait, or issue a write through the cockpit surface (cache invalidates on same-process writes). External writes surface on TTL expiry.
