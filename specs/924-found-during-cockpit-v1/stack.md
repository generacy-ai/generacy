# Stack: #924 cockpit_await_events lifecycle fix

## Language & runtime

- TypeScript strict-mode, ESM.
- Node ≥22 (existing package constraint; no change).
- No new tooling.

## Packages

- `@generacy-ai/generacy` — modified.
  - Modified: `src/cli/commands/cockpit/mcp/event-bus.ts`
  - Modified: `src/cli/commands/cockpit/mcp/event-bus-registry.ts`
  - Modified: `src/cli/commands/cockpit/mcp/tools/cockpit_await_events.ts`
  - New: `src/cli/commands/cockpit/mcp/__tests__/event-bus-registry.test.ts`
  - Extended: `src/cli/commands/cockpit/mcp/__tests__/event-bus.test.ts`
  - Extended: `src/cli/commands/cockpit/mcp/__tests__/await-events-cursor-classes.test.ts`
- No other packages touched. `@generacy-ai/cockpit` types (`GhWrapper`, `resolveEpic`) are consumed unchanged.

## Dependencies

- **No new dependencies** (npm or otherwise).
- Uses `node:crypto` (`crypto.randomBytes`) — already in the transitive dep graph; no `package.json` change.
- Standard library `setTimeout` / `clearTimeout` for the idle-TTL clock.

## External integrations

- GitHub REST via existing `GhCliWrapper` — unchanged.
- No relay, no cloud, no cluster changes.

## Testing

- Vitest (existing project runner).
- Test seams already in place: `EpicEventBusOptions.now` (fake clock), `AcquireOptions.noPoll` (skip poll loop), `deps.acquired` on `cockpit_await_events` (bypass registry).
- New test seams (small):
  - `EpicEventBusOptions.nonce` — test-only bus-nonce override.
  - `AcquireOptions.now` / `idleTtlMs` / `maxBuses` — test-only registry overrides.
- `vi.useFakeTimers()` used for idle-TTL and LRU-cap assertions.
- The module-scoped `INSTANCE_NONCE` is not directly test-mockable; cross-instance tests construct a bus with an explicit `nonce` option and pass it through `deps.acquired` to `cockpit_await_events`.

## Configuration

- Two new env vars (documented in `data-model.md` and `quickstart.md`):
  - `COCKPIT_MCP_BUS_IDLE_TTL_MS` (default `600_000`)
  - `COCKPIT_MCP_BUS_MAX` (default `100`)
- Parsed with the same `Number.parseInt(process.env.X ?? '', 10) || DEFAULT` idiom already present for `COCKPIT_MCP_EVENT_RETENTION_*`.
- No feature flag. Bug fix.

## Rollout

- Ships in a normal `@generacy-ai/generacy` release.
- No cluster-image, no cluster-base, no orchestrator, no cloud companion PR.
- Legacy cursor tokens issued by pre-fix servers are handled transparently (classify as `discarded`, silent reset with `resetFrom`).

## Observability

- Existing `logger.warn` used for GH API errors from `catchUpPoll` and for env var parse failures.
- New log lines (both `warn` or `info` level, exact tuning during implementation):
  - `event-bus: catch-up poll` — one per acquire that unblocks a paused poller. Info.
  - `event-bus: LRU eviction` — one per LRU-driven registry eviction. Warn.
  - `event-bus: idle-TTL eviction` — one per timer-fired eviction. Info.
- All structured — grep-friendly, no free-form templating.

## Cross-references

- **Companion agency finding** (out of scope for this repo, spec Out of Scope §2): agency#408 circuit breaker's strict fail-loud posture for `invalid-cursor` is what makes this classification fix load-bearing. This spec restores `never-issued` as a trustworthy signal; the agency-side change decides what to do with it.
- **Related patterns**:
  - `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts` — `runOnePoll`, reused verbatim by the catch-up path.
  - `packages/generacy/src/cli/commands/cockpit/watch/aggregate.ts` — `computeAggregateEvents`, reused.
  - `packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts` — `SnapshotMap`, retained across pause.
