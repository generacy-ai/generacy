# Implementation Plan: Keep the active epic bus + buffer warm across long quiet phases

**Feature**: Eliminate `resetFrom:"discarded"` / `"expired"` cursor recoveries during long `/cockpit:auto` runs by extending both the `event-bus-registry` idle-TTL and the `EpicEventBus` retention window from 10 min to 120 min, expressed as a single shared exported constant so the two horizons can't silently desync.
**Branch**: `999-summary-during-long-cockpit`
**Status**: Complete

## Summary

`cockpit_await_events` cursors are being invalidated mid-run on long epics because two independent 10-minute horizons — the registry's `DEFAULT_IDLE_TTL_MS` (`event-bus-registry.ts:43`) and the bus's `retentionMs` (`event-bus.ts:132`) — are both shorter than typical 30–60-min quiet implementation phases. Either branch fires and the operator's still-live cursor classifies `discarded` (`evicted`, because a fresh `busNonce` is minted on re-creation) or `expired` (buffer trimmed under a valid nonce). The auto skill then re-runs a full startup sweep (extra `gh`/GraphQL + re-classification). It's idempotent and correctness-preserving, but observed 3 times on the snappoll #1 run.

The fix per the clarifications:

1. **Single shared exported constant `DEFAULT_QUIET_HORIZON_MS = 7_200_000` (FR-001 / FR-002 / FR-003, C-001 / C-002).** Both `event-bus-registry.ts:43` (`DEFAULT_IDLE_TTL_MS`) and `event-bus.ts:132` (bus default `retentionMs`) reference this one constant. Structurally forbids the two horizons drifting out of lockstep — the "must move together" invariant is encoded at the module level, not by convention.
2. **Reuse the existing env-var override surfaces (FR-004, C-003).** `COCKPIT_MCP_BUS_IDLE_TTL_MS` and `COCKPIT_MCP_EVENT_RETENTION_MS` continue to override at runtime. `options.idleTtlMs` / `options.retentionMs` continue to override in code. No new `COCKPIT_BUS_*` names introduced. This is a defaults-only change.
3. **`retentionCount` unchanged at 10_000 (FR-005, C-004).** Memory bound stays put; a hypothetical count-driven trim invalidating a cursor within the new time window classifies `expired` and out-of-scope for SC-001 (which targets time-driven invalidations only).
4. **`bnonce` / `pnonce` protocol untouched (FR-007).** No changes to `event-bus.ts:150-174` cursor classification logic. Cross-instance detection (process restart) still classifies as `discarded/cross-instance` unchanged.
5. **Regression tests using injectable horizons on top of fake timers (FR-008, C-005).** Injectable horizons (`options.idleTtlMs`, `options.retentionMs`) keep wall time small; `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` handles the idle-TTL teardown path which uses a real `setTimeout` inside `releaseKey` (`event-bus-registry.ts:293`).

Changeset (`patch`, `workflow:speckit-bugfix`, `@generacy-ai/generacy`) is required per the CLAUDE.md-encoded CI gate.

## Technical Context

- **Language**: TypeScript (ESM, `NodeNext`). Node >=22 (the CLI package's floor).
- **Package**: `@generacy-ai/generacy`. No new packages, no new deps.
- **Test runner**: `vitest`. Fake timers via `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` — the same pattern used in `__tests__/event-bus-registry.test.ts:63-90` (the existing "R-I1 refCount XOR idleTimer" test).
- **Blast radius**: two source files — `event-bus.ts`, `event-bus-registry.ts` — plus regression tests appended to the existing `__tests__/event-bus.test.ts` and `__tests__/event-bus-registry.test.ts`. No new modules, no new public API, no new env vars.
- **Non-goals**: pinning the bus for the run duration via long-lived subscription (spec Out-of-Scope §1); doorbell-stream-driven cursor recovery (spec Out-of-Scope §2); `retentionCount` changes (FR-005 / C-004); `COCKPIT_BUS_*` env-var names (C-003); `bnonce` / `pnonce` protocol changes (FR-007).
- **CI gate**: this diff touches `packages/generacy/src/` non-test files → a `.changeset/*.md` file must be **added** in this PR. Bump level `patch` (defect fix, no public API change).

### Files that will change

| File | Change |
|------|--------|
| `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts` | MODIFIED. Add exported constant `DEFAULT_QUIET_HORIZON_MS = 7_200_000` (with JSDoc: "Shared default horizon for the `EpicEventBus` in-memory buffer retention window AND the `event-bus-registry` idle-TTL. Any change here changes both call sites in lockstep — FR-003."). Change the constructor default at line 132 to reference it: `this.retentionMs = options.retentionMs ?? DEFAULT_QUIET_HORIZON_MS;`. No other change; `retentionCount` default (line 131) unchanged at 10_000. |
| `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` | MODIFIED. Import `DEFAULT_QUIET_HORIZON_MS` from `./event-bus.js`. Change `DEFAULT_IDLE_TTL_MS` at line 43 to `const DEFAULT_IDLE_TTL_MS = DEFAULT_QUIET_HORIZON_MS;` (kept as a named local so the existing env-var parse call site — `parsePositiveIntEnv(..., options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS, 'COCKPIT_MCP_BUS_IDLE_TTL_MS', ...)` — is unchanged). Update the module header JSDoc comment (lines 16-18) to reflect the new default (`600_000` → `7_200_000`) and reference the shared constant. |
| `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/event-bus.test.ts` | MODIFIED. Append one case asserting the exported `DEFAULT_QUIET_HORIZON_MS` value equals `7_200_000` and is a positive integer (guards SC-005 by making an accidental future edit to a different literal break the build). Append one case asserting the bus's default `retentionMs` (constructed without options) equals `DEFAULT_QUIET_HORIZON_MS` (structural — the constructor default derives from the constant). |
| `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/event-bus-registry.test.ts` | MODIFIED. Append two cases per FR-008: (a) SC-001/FR-008(a) — "≥10-min quiet, ≤120-min horizon → cursor issued before the gap classifies `valid`": inject a small horizon (say 60_000 ms), advance fake time past the old 10-min TTL (say 30_000 ms — well below the new horizon in real code), assert the pre-gap cursor still classifies `valid` and re-acquire returns the same `bus.busNonce`. (b) SC-003/FR-008(b) — "gap exceeds new horizon → bus IS torn down": same injected horizon, advance fake time past it, assert `acquireEpicBus` returns a bus with a DIFFERENT `busNonce` (idle-TTL reclaim still fires — no leak). Both cases use `vi.useFakeTimers()` + `vi.advanceTimersByTime()` following the existing `event-bus-registry.test.ts:63-90` pattern. |
| `.changeset/999-shared-quiet-horizon.md` | NEW. `patch` bump for `@generacy-ai/generacy`. `workflow:speckit-bugfix`. |

### File structure (unchanged)

```
packages/generacy/src/cli/commands/cockpit/mcp/
├── event-bus.ts                                # MODIFIED — export DEFAULT_QUIET_HORIZON_MS; use it in ctor default
├── event-bus-registry.ts                       # MODIFIED — import + reference DEFAULT_QUIET_HORIZON_MS
└── __tests__/
    ├── event-bus.test.ts                       # MODIFIED — constant value + default-derivation assertions
    └── event-bus-registry.test.ts              # MODIFIED — FR-008(a) survival + FR-008(b) reclaim cases
```

## Architectural Decisions

- **Where the shared constant lives: `event-bus.ts` (not a new leaf module).** `event-bus-registry.ts` already imports from `event-bus.js` (`EpicEventBus`), so a one-way import of `DEFAULT_QUIET_HORIZON_MS` is cycle-free and cheap. Adding a new `event-bus-horizons.ts` file for a single constant is an unearned abstraction. Placement rationale is symmetric with `EpicEventBus`'s `retentionMs` default — the retention window is the bus's own concern; the registry's idle-TTL is the derived signal.
- **Kept `DEFAULT_IDLE_TTL_MS` as a named local in `event-bus-registry.ts` (not inlined at the call site).** Local naming is what makes `parsePositiveIntEnv(process.env.COCKPIT_MCP_BUS_IDLE_TTL_MS, options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS, 'COCKPIT_MCP_BUS_IDLE_TTL_MS', logger)` readable and preserves the existing error-message string parameter. Inlining would obscure the "if env unset and options unset, use the shared horizon" fallback chain.
- **Regression tests injected via `options.idleTtlMs` / `options.retentionMs` rather than real defaults + long wall time.** Injecting a sub-second horizon (or a 60_000 ms horizon) plus `vi.useFakeTimers()` exercises the exact code paths — the `setTimeout(...)` inside `releaseKey` still runs under fake time, the buffer-trim comparison still runs against the injected `retentionMs` — without a real 2-hour wait in CI. The tests document the FR-008(a) survival case with an "old TTL was 10 min" comment so a reader understands why a mid-horizon-time advance is meaningful.
- **No new `SC-005` grep-based lint rule.** The single shared constant + a test asserting `DEFAULT_QUIET_HORIZON_MS === 7_200_000` and the bus default derives from it is sufficient enforcement. A grep-based check for "no two distinct numeric literals at these two call sites" would either be too specific (regexes on line numbers that rot) or too broad (bans any `7_200_000` literal anywhere). The tests + module-level named import cover the invariant.
- **No changes to the module JSDoc comment at `event-bus-registry.ts:16-18` beyond the number update.** The env-knob documentation (`COCKPIT_MCP_BUS_IDLE_TTL_MS`) stays. Only "(default 600_000)" → "(default 7_200_000)" changes.
- **Regression tests do NOT assert on `vi.useRealTimers()` cleanup.** The existing `afterEach(() => { _resetRegistryForTests(); vi.useRealTimers(); })` at `event-bus-registry.test.ts:31-34` already handles teardown for every test in the file.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo. Followed the CLAUDE.md-encoded rules:

- **Changeset gate**: diff touches `packages/generacy/src/` non-test files → new `.changeset/999-shared-quiet-horizon.md` (`patch`, `workflow:speckit-bugfix`, `@generacy-ai/generacy`).
- **No premature abstraction**: no new module, no new interface, no factory. One exported `const` + one import.
- **No backwards-compat shims**: the constant value change is a straight number edit. Existing env-var overrides + existing constructor options continue to work exactly as before. No dual code path, no feature flag.
- **Comment discipline**: one JSDoc line on the exported constant explaining WHY (the "in lockstep" invariant, referencing FR-003). Existing JSDoc header on `event-bus-registry.ts` updated in place. New test cases carry `SC-001`/`SC-003`/`FR-008(a)`/`FR-008(b)` prefixes in their `it()` names — matching the convention already used in `event-bus-registry.test.ts:37, 63, 92, 128`.

## Risks & Mitigations

- **R1: A future edit accidentally changes only one of the two horizons.** Mitigation: the single shared exported constant makes this structurally impossible — there is no second literal to edit out of sync. The FR-008 tests + the `DEFAULT_QUIET_HORIZON_MS === 7_200_000` assertion trip on any change to the constant value (forcing an intentional update).
- **R2: Under a chatty epic, `retentionCount = 10_000` trims the buffer inside the 120-min window and a cursor classifies `expired`.** Mitigation: FR-005 / C-004 explicitly accepts this residual — it's out of SC-001's scope. At cockpit's per-epic transition granularity, sustaining >83 events/min for 2 hours is implausible. If it happens in practice, follow-up: raise `retentionCount` (a separate change to the memory-bound axis).
- **R3: An idle bus lingers longer, consuming buffer memory until the 120-min TTL fires.** Mitigation: `retentionCount = 10_000` × ~1 KB/event × `maxBuses = 100` = ~1 GB **worst case if every bus were full**. In practice per-epic buffers are much smaller. The idle bus does NOT poll (`releaseKey` calls `pausePoller`), so it consumes only memory (bounded), not GraphQL/API quota. The `maxBuses = 100` LRU eviction still fires under registry pressure.
- **R4: The env-var override surface behaves subtly differently under a lower env value than the old 600_000 default assumed.** Mitigation: `COCKPIT_MCP_BUS_IDLE_TTL_MS` was always ops-configurable to any positive value; changing the default does not narrow the range. Any op-configured value continues to be honored via `parsePositiveIntEnv`.
- **R5: The FR-008(a) test's "sub-second horizon, advance past old 10-min TTL under fake time" doesn't actually assert anything the old 10-min TTL would have failed on — the injected small horizon is what makes it survive, not the production 120-min value.** Mitigation: the test's job is to assert "under an injected horizon, a cursor issued before a gap smaller than the horizon still classifies `valid`" — i.e. the injected small horizon *represents* the production 120-min horizon at test scale. The commentary in the test file explains this scaling relationship so a future reader understands what the injected horizon stands in for. The FR-008(a) case is validating the *shape* of the invariant, not the production number; the production number is asserted by the `DEFAULT_QUIET_HORIZON_MS === 7_200_000` case in `event-bus.test.ts`.

## Next Step

`/speckit:tasks` to generate the task list from this plan.
