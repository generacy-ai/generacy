# Quickstart: verify the cockpit_await_events lifecycle fix

**Issue**: [#924](https://github.com/generacy-ai/generacy/issues/924)
**Branch**: `924-found-during-cockpit-v1`

## Local dev

```bash
pnpm install
pnpm --filter=@generacy-ai/generacy build
pnpm --filter=@generacy-ai/generacy test src/cli/commands/cockpit/mcp
```

## Environment variables

Two new tunables in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts`:

| Var | Default | Description |
|-----|---------|-------------|
| `COCKPIT_MCP_BUS_IDLE_TTL_MS` | `600_000` (10 min) | Idle-TTL before an unreferenced bus is evicted from the registry. Arms at refcount → 0; disarms at next `acquire`. |
| `COCKPIT_MCP_BUS_MAX` | `100` | Soft cap on concurrent live buses. On new `acquire` at cap, LRU-oldest bus is evicted (cursor from evicted bus → `discarded`). |

## Manual smoke test

Two sequential calls against the same epic must round-trip the cursor without an `invalid-cursor` error:

```bash
# In one shell — start the MCP server
pnpm --filter=@generacy-ai/generacy exec generacy cockpit mcp

# In another shell — send two sequential await_events calls
# (simplified; real invocation is via an MCP client)

# Call 1: cursor undefined, receive cursor A
# Call 2: cursor = A, expect status=ok (not invalid-cursor)
```

## Regression scenarios

Automated in `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/event-bus-registry.test.ts`:

| Scenario | Expected outcome |
|----------|------------------|
| Sequential `acquire` / `release` / `acquire` against the same epic | Same `EpicEventBus` returned; nextCursor NOT reset. |
| Emit between calls (no waiter in flight) | Next `acquire` triggers `catchUpPoll`; emitted event appears in the subsequent `waitFor`. |
| Idle-TTL fires (fake clock advanced past `COCKPIT_MCP_BUS_IDLE_TTL_MS`) | Registry entry deleted; a held cursor from the evicted bus classifies as `discarded`. |
| Cross-instance cursor (mocked `INSTANCE_NONCE` mismatch) | `discarded` — NOT `never-issued`. |
| Same-instance out-of-range cursor | `never-issued` — genuine caller bug preserved. |
| Legacy cursor (no `pnonce` / `bnonce` fields) | `discarded` — `resetFrom: 'discarded'` on tool output. |
| LRU cap hit (101st acquire with `maxBuses: 100`) | LRU bus evicted; its cursor now classifies as `discarded`. |
| Idle-TTL clock arms on refcount → 0, disarms on acquire | Invariant R-I1 held under vitest fake-clock exercises. |

## Troubleshooting

- **`invalid-cursor` after the fix ships** — check whether the caller is passing a cursor issued more than `COCKPIT_MCP_BUS_IDLE_TTL_MS` ago (idle-TTL evicted it). This should now surface as `resetFrom: 'discarded'`, not `invalid-cursor`. If it's `invalid-cursor`, verify the bug isn't a caller-side cursor mutation (they're opaque tokens; must be passed verbatim).
- **Between-call events missed** — check the catch-up path fired. Grep the server log for `event-bus: catch-up poll` (new log line). If absent, the `pausePoller` / `catchUpPoll` wiring is broken.
- **Registry growing unbounded** — check `COCKPIT_MCP_BUS_MAX`. If unset or set to something huge, LRU eviction won't trigger. Default `100` should be adequate for cockpit workloads.

## Ship checklist

- [ ] `event-bus.ts` — `pnonce` / `bnonce` on cursor payload; `parseCursor` returns `discarded` for all three cases.
- [ ] `event-bus-registry.ts` — no `sub.stop()` at refcount 0; idle-TTL timer arm/disarm; LRU soft cap eviction; poller pause + catch-up wiring.
- [ ] `tools/cockpit_await_events.ts` — `discarded` cursor branch maps to `resetFrom: 'discarded'` + `sinceCursor = 0`.
- [ ] Tests: extended `event-bus.test.ts` + `await-events-cursor-classes.test.ts`; new `event-bus-registry.test.ts`.
- [ ] Env vars documented in `packages/generacy/README.md` (if present) or CLAUDE.md changelog entry.
- [ ] Manual smoke test against a live epic (two sequential `cockpit_await_events` calls, cursor round-trips clean).
