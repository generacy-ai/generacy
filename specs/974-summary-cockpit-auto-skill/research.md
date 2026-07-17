# Research — `generacy cockpit doorbell` verb

## 1. `subscribeAndEmit` — separate module or inline in `doorbell.ts`?

**Decision**: separate module — `packages/generacy/src/cli/commands/cockpit/doorbell/subscribe.ts`.

**Rationale**:
- `runWatch` in `watch.ts` inlines its emit-per-event loop because it already needs `runOnePoll`, `computeAggregateEvents`, `emit`, `emitAggregate`, and the epic-refresh-every-Nth-cycle counter. That inlining reflects `watch`'s job (own the whole poll loop). The doorbell doesn't own a loop — the loop is `acquireEpicBus`'s; the doorbell only needs a stdin→stdout translator.
- SC-003 (1:1 emit to line) becomes trivial to test at unit scale if we can hand a bus + a fake stdout to `subscribeAndEmit()` and count writes. Wrapping this into `runDoorbell` forces every SC-003 case to also mock `acquireEpicBus`.
- Q3=B says lines are the event `type` word. Isolating the type-word translation gives one place to update if the `CockpitStreamEvent` union grows (Assumptions §4 in spec explicitly reserves that path).

**Alternatives considered**:
- Inline the subscribe loop inside `runDoorbell`. Rejected: fatter test surface (must instrument `acquireEpicBus` for every subscribe-behavior assertion), and the type-word translation would be buried mid-function.

## 2. FR-010 `armed\n` emission timing

**Decision**: emit `armed\n` immediately after `acquireEpicBus()`'s returned Promise resolves (before any bus.emit), except under Form 3 where it fires at process startup with no acquire.

**Rationale**:
- `acquireEpicBus` returns *after* the first poll's `runCycle` completes on new-bus creation paths (`await catchUpPoll()` is only on the resume path; on the initial acquire, the `runPollLoop` fires cycle 1 asynchronously — the promise itself doesn't wait for it). Two options for "initial poll settled":
  - **(A)** Await the returned Promise and treat that as `armed`. This is what the spec's FR-010 wording actually admits ("*after the initial poll completes*") given that `acquireEpicBus` resolves before the first `runCycle` on the new-bus path, but the first bus.emit hasn't happened yet.
  - **(B)** Hook into the bus and treat the first bus.emit (or a bus-level "poll-cycle-complete" event) as `armed`.
- Option A is simpler, matches Form 3 (no bus to hook), and satisfies the operator-visible intent — the sensor is up and steady. Option B would need to distinguish "steady sensor, epic quiet" (goal) from "sensor waiting on first bus.emit forever" (a bug we do not want to trigger a false `armed`).
- Under Form 3, no `acquireEpicBus` at all — we write `armed\n` at startup and block on SIGTERM.

The `armed\n` line is written via a **direct** `process.stdout.write('armed\n', callback)` — never routed through `subscribeAndEmit()`. It is an out-of-band diagnostic marker, not a bus event.

**Alternatives considered**:
- Emit `armed\n` before `acquireEpicBus` returns (at process start). Rejected: the FR-010 rationale ("distinguishes sensor up, epic quiet, from sensor never started") requires the acquire to have succeeded; a pre-acquire `armed` would falsely reassure the caller in the resolveIssueContext-fails path.
- Hook the first bus.emit and use *that* to trigger `armed`. Rejected: under Form 1 with a quiet epic, no bus.emit will ever fire, so `armed` would never print — defeating its whole purpose.

## 3. Cross-process bus attach — is Q1=C's aspirational "one poll loop per epic" reachable at all?

**Not part of this spec**, but worth noting so the follow-up decision is grounded.

The MCP server's `mcp/index.ts` uses `StdioServerTransport` — a `stdin`/`stdout` pipe pair to the harness. To share a bus across processes we'd need one of:
- **Q1 option B**: a shared daemon over Unix socket. `control-plane` is the obvious host — it already runs the auth-health service, has a socket, is present in the orchestrator container where `/cockpit:auto` runs. But the `EpicEventBus` was written assuming a single-process consumer (in-memory buffer, refcount, no serialization); making it socket-safe is a nontrivial refactor.
- **Q1 option D**: doorbell asks the running MCP server to open a channel. Same problem — the MCP server has no socket surface, and giving it one repeats option B's cost.

Q1=C's honest tradeoff: the doorbell's own poll loop plus `cockpit_await_events`' poll loop = 2× GraphQL load per epic. #970 already shipped the mitigations (short-TTL cache, rate-limit backoff, lifecycle-gated check polling, conditional epic refresh) that make this bearable. If the 2× proves material in production, Q1 option B is the follow-up.

**Sources**:
- `packages/generacy/src/cli/commands/cockpit/mcp/index.ts` — MCP server transport.
- `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` — in-process registry.
- Spec §Clarifications Q1 — decision rationale + option costs.
- #970 (PR #971 `55844a07`) — the GraphQL rate-limit efficiency work that de-risks 2×.

## 4. `--exit-on-epic-complete` — mirror `watch`'s implementation exactly

**Decision**: copy `watch.ts:217-225`'s pattern verbatim into `doorbell.ts`.

**Rationale**:
- `watch` proves the pattern works under the same `Monitor` lifecycle harness the doorbell runs under. `await new Promise(r => process.stdout.write('', () => r()))` drains, then `process.exit(0)`.
- FR-011 explicitly calls for parity with `watch`. Divergence (e.g., `setImmediate` instead of the write-and-callback drain) would risk race conditions between the `epic-complete\n` line write and process exit.

**Alternatives considered**:
- Emit `epic-complete\n` and rely on `process.exit(0)` to flush. Rejected: `process.exit` does not drain block-buffered stdout streams; under non-TTY pipes (which is what `Monitor` uses) this loses the terminal line.

## 5. Ref grammar — direct `parseIssueRef` or through `resolveIssueContext`?

**Decision**: no `parseIssueRef` from `doorbell.ts`. `acquireEpicBus` already calls `resolveIssueContext` internally (`event-bus-registry.ts:307-311`), and the doorbell just forwards the positional as-is.

**Rationale**:
- #850 ESLint guard (`.eslintrc.json` overrides for `packages/generacy/src/cli/commands/cockpit/**/*.ts`) forbids direct `parseIssueRef` imports from cockpit verbs. `resolveIssueContext` is the sanctioned entry point.
- `acquireEpicBus`'s `expandRef` already exercises the sanctioned path. Duplicating it in `doorbell.ts` would produce two error-message shapes for the same failure mode.

**Sources**:
- `packages/generacy/src/cli/commands/cockpit/resolver.ts` — `resolveIssueContext` public surface + FR-002 error copy.
- `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts:307` — `expandRef` → `resolveIssueContext` call.
- `.eslintrc.json` — cockpit override forbidding `parseIssueRef` from non-resolver files (per #850).

## 6. Stdout flush idiom for non-TTY pipes

**Decision**: `await new Promise(r => process.stdout.write(chunk, () => r()))` for each event line — the callback-based signal that Node's stream layer has queued the write. Matches `watch.ts:222-224`.

**Rationale**:
- When `stdout` is a pipe (Monitor case), Node buffers writes at ~64 KB chunks by default. The doorbell's lines are short (`issue-transition\n` = 17 bytes); a full buffer of them could sit unflushed for minutes.
- Awaiting the write callback synchronizes each stdout line with the poll cadence. No throughput cost — the doorbell writes at most one line per poll cycle in steady state.

**Alternatives considered**:
- `process.stdout.cork()` / `uncork()`. Rejected: adds ordering hazards (nested corks nest); the callback approach is simpler and already proven by `watch`.
- Rely on `process.stdout.setDefaultEncoding` or line-buffered mode. Rejected: Node does not expose a line-buffered mode for pipes; TTY behavior does not carry over.

## 7. What does the `Monitor` harness on the auto-driver side actually consume?

**Decision (informational, not a code decision here)**: any non-empty line is a wake. The caller does not parse content. `auto.md` is explicit; see spec Assumptions §2.

**Rationale**:
- The doorbell's stdout contract is deterministic (Q3=B, one type word per line) purely for testability — 1:1 assertions in Vitest need something concrete to match against.
- Callers must NOT rely on the content. Spec Out of Scope §4 makes this contractual.
