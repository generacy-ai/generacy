# Research: Shared quiet-horizon for `EpicEventBus` + `event-bus-registry`

**Issue**: [#999](https://github.com/generacy-ai/generacy/issues/999)
**Branch**: `999-summary-during-long-cockpit`

## Decision log

### D1. Horizon value: `7_200_000` ms (120 min)

**Decision**: `DEFAULT_QUIET_HORIZON_MS = 7_200_000` (120 minutes).

**Rationale** (clarifications Q1 → C):

- The longest observed quiet phase on the snappoll #1 run was ~1 hour (30–60 min per issue during P4 implementation, occasionally near an hour).
- 60 min (Q1 → A) leaves zero headroom — the next slightly-longer epic re-triggers the exact bug this fixes. Tails only get longer as workflows mature.
- 90 min (Q1 → B) gives ~50% margin; acceptable but conservative.
- 120 min (Q1 → C) gives 2× the observed maximum — genuine comfort margin.

**Cost of a wider window is near-zero here**:

- An idle/released bus does NOT poll (`releaseKey` calls `pausePoller` at `event-bus-registry.ts:292`) — no network or GraphQL quota consumed.
- Per-bus memory stays bounded by `retentionCount = 10_000` × ~1 KB/event ≈ 10 MB per full bus; the `maxBuses = 100` LRU cap bounds registry-wide memory even under pessimistic worst-case.
- The `retentionMs` time trim on the buffer only reads the head entry's `emittedAt` — no periodic sweep cost.

**Alternatives considered**:

- **60_000 ms (60 min)**: zero headroom against observed max. Rejected — the next long implementation phase re-triggers the bug.
- **5_400_000 ms (90 min)**: acceptable middle ground. Kept as a fallback if operational data suggests 120 min is excessive.
- **Derive from an "active run" signal**: raised in the spec ("keep the active epic's bus + buffer warm for the whole run"). Rejected as more machinery than the smaller-change fix requires. Complementary Option 2 in the spec — deferred as out-of-scope.

### D2. Shared exported constant vs. two independent constants

**Decision**: One shared exported constant, `DEFAULT_QUIET_HORIZON_MS`, referenced from both `event-bus-registry.ts:43` (`DEFAULT_IDLE_TTL_MS`) and `event-bus.ts:132` (constructor default for `retentionMs`).

**Rationale** (clarifications Q2 → A):

- FR-003 requires the two horizons "must move together in lockstep." Two independent constants set to the same value (Q2 → B) rely on convention. Convention is exactly what silently desyncs later, when a future edit "raises the retention window for a reason" and forgets the other side.
- A single shared constant makes desync structurally impossible.
- Preferred over Q2 → C (`retentionMs` slightly larger than idle-TTL as defense-in-depth): the effective horizon is always `min(idle-TTL, retentionMs)`, so a single equal value is simpler and there's no benefit to making `retentionMs` larger than the horizon at which the bus has already been idle-torn-down.

**Placement**: exported from `event-bus.ts` (not a new leaf module). Rationale:

- `event-bus-registry.ts` already imports from `event-bus.js` (`EpicEventBus`). A one-way import of a constant is cycle-free.
- A new file (`event-bus-horizons.ts`, `event-bus-constants.ts`, …) for a single constant is unearned indirection.
- Symmetric with the bus's existing `retentionMs` default; the registry's idle-TTL is downstream.

**Alternatives considered**:

- **Two constants, `DEFAULT_IDLE_TTL_MS` and `DEFAULT_RETENTION_MS`, both set to `7_200_000` inline** (Q2 → B). Rejected per FR-003.
- **New `event-bus-horizons.ts` module holding just the constant.** Rejected — single-constant module is over-abstraction; the existing one-way import from `event-bus.js` is the smaller change.
- **`retentionMs` slightly larger than `DEFAULT_IDLE_TTL_MS`** (Q2 → C). Rejected — see rationale above.

### D3. Env-var override surface: reuse existing names

**Decision**: No new env-var names. `COCKPIT_MCP_BUS_IDLE_TTL_MS` and `COCKPIT_MCP_EVENT_RETENTION_MS` continue to override at runtime. `options.idleTtlMs` and `options.retentionMs` continue to override in code.

**Rationale** (clarifications Q3 → D + spec's C-003 correction):

- The registry already reads `process.env.COCKPIT_MCP_BUS_IDLE_TTL_MS` via `parsePositiveIntEnv` (`event-bus-registry.ts:127`) and accepts `options.idleTtlMs` (`event-bus-registry.ts:105`).
- The bus already honors `COCKPIT_MCP_EVENT_RETENTION_MS` and `options.retentionMs` (spec references `event-bus.ts:20`).
- Adding new `COCKPIT_BUS_*` names would fork the ops tuning surface and force test injection sites to migrate. The clarifications explicitly reject that.
- This change is defaults-only.

**Alternatives considered**:

- **Hard-coded, no overrides** (Q3 → A). Rejected — existing overrides must continue to work for ops.
- **New `COCKPIT_BUS_IDLE_TTL_MS` / `COCKPIT_BUS_RETENTION_MS`** (from Q3 draft). Rejected in clarifications — reuse `COCKPIT_MCP_*` names.
- **Constructor injection only, drop env vars.** Rejected — env vars are the ops-tuning surface and cannot be removed in a bug-fix.

### D4. `retentionCount` cap unchanged at `10_000`

**Decision**: `retentionCount = 10_000` unchanged. A count-driven trim invalidating a cursor within the new time window classifies as `expired` and is accepted as a residual, out-of-scope for SC-001.

**Rationale** (clarifications Q4 → A):

- At cockpit's per-epic transition granularity, 10k events inside a 2h window requires ~83 events/min sustained. Implausible for an epic tracking a small number of children (a normal epic has O(10) issues; each generates O(10s) of state transitions).
- Raising `retentionCount` (Q4 → B, e.g. 50k) has a real memory cost multiplied by `maxBuses = 100`: 50k × ~1 KB × 100 = ~5 GB pessimistic worst case. Avoiding this for a scenario that won't occur is the right trade-off.
- SC-001 targets time-driven invalidations only. A count-driven residual doesn't invalidate the fix.

**Alternatives considered**:

- **Raise `retentionCount` to 50_000 or 100_000** (Q4 → B). Rejected — memory cost outweighs the improbable-in-practice benefit.
- **Explicit out-of-scope with a follow-up filed** (Q4 → C). Effectively where we land — this section documents the trade-off; no follow-up is filed because there is no observed instance.

### D5. Regression test time strategy: injectable horizons on top of fake timers

**Decision**: Regression tests use both mechanisms — most cases inject sub-second (or short second-scale) horizons for speed; the idle-TTL teardown case uses `vi.useFakeTimers()` + `vi.advanceTimersByTime()` because `releaseKey` calls a real `setTimeout` at `event-bus-registry.ts:293`.

**Rationale** (clarifications Q5 → D):

- The code is already built for both injection paths: `EpicEventBusOptions.now` / `retentionMs` / `nonce`; `acquireEpicBus` `options.now` / `idleTtlMs` / `maxBuses` / `runCycle`.
- Real-time waits of >10 min are infeasible in CI.
- Fake timers alone (Q5 → C, real defaults) would either take 10+ minutes of virtual time to test the old-TTL-exceeded case or would run at the real 120-min value, which is fragile against future default-value changes.
- Injectable horizons alone (Q5 → B) can't exercise the `setTimeout` inside `releaseKey` without either fake timers or a real wall-time wait.
- D (both) matches the pattern used in the existing `__tests__/event-bus-registry.test.ts:63-90` (the "R-I1 refCount XOR idleTimer" test uses `idleTtlMs: 60_000` + `vi.advanceTimersByTime(120_000)`).

**Alternatives considered**:

- **Fake timers only, with production defaults** (Q5 → C). Rejected — brittle, slow (advances tens of minutes of virtual time), couples tests to the production `7_200_000` constant so a bump breaks tests.
- **Injectable horizons only, no fake timers** (Q5 → B). Rejected — the `setTimeout` inside `releaseKey` isn't override-able and needs fake time to fire deterministically.

## Implementation patterns

### The env-var + options + default cascade in `event-bus-registry.ts`

`parsePositiveIntEnv(process.env.COCKPIT_MCP_BUS_IDLE_TTL_MS, options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS, 'COCKPIT_MCP_BUS_IDLE_TTL_MS', logger)` is the existing cascade. Only the tail (`DEFAULT_IDLE_TTL_MS`) changes; the env-var name and options key are untouched.

### The `?? DEFAULT` pattern in `EpicEventBus.constructor`

`this.retentionMs = options.retentionMs ?? DEFAULT_QUIET_HORIZON_MS;` — same shape as the surrounding `this.retentionCount = options.retentionCount ?? 10_000;`. No structural change; only the default expression on the right-hand side moves from a numeric literal to a named import.

### Fake-timer teardown assertion (existing template)

From `__tests__/event-bus-registry.test.ts:63-90`:

```ts
vi.useFakeTimers();
// ... acquire, release, ...
vi.advanceTimersByTime(30_000);   // under injected TTL — bus survives
// ... assert same busNonce ...
vi.advanceTimersByTime(120_000);  // past injected TTL — bus evicted
// ... assert different busNonce ...
```

FR-008(a) and FR-008(b) tests follow this same shape.

## Key sources / references

- Spec: `/workspaces/generacy/specs/999-summary-during-long-cockpit/spec.md`
- Clarifications: `/workspaces/generacy/specs/999-summary-during-long-cockpit/clarifications.md`
- Registry: `/workspaces/generacy/packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` (`DEFAULT_IDLE_TTL_MS` at `:43`, `releaseKey` at `:287`)
- Bus: `/workspaces/generacy/packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts` (`retentionMs` default at `:132`, cursor classification at `:150-174`)
- Existing registry tests: `/workspaces/generacy/packages/generacy/src/cli/commands/cockpit/mcp/__tests__/event-bus-registry.test.ts` (fake-timer pattern at `:63-90`, `:92-126`)
- CLAUDE.md changeset gate: `/workspaces/generacy/CLAUDE.md` (§ "Changesets (required — CI gate)")
- Prior related work: #997 (source-selector clarifications used the same "injectable + fake timers" pattern this spec adopts).
