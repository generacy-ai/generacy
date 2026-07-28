# Clarifications: Add `cluster.cockpit.reply` to `RelayMessageSchema`

## Batch 1 — 2026-07-28

### Q1: Unknown-field handling strategy
**Context**: FR-002 says the new schema must be "tolerant of unknown fields at the top level (does not reject on extras)". Zod's default `.object()` accepts extras but silently **strips** them from the parsed output. `.passthrough()` accepts extras and **preserves** them in the parsed value. This choice determines whether a future cloud-added field (e.g. `wroteDocPath`) shows up in the router's log lines or disappears before logging.
**Question**: Should `ClusterCockpitReplyMessageSchema` use Zod default (strip unknowns) or `.passthrough()` (preserve unknowns)?
**Options**:
- A: `.passthrough()` — future fields land in `accepted: false` info logs automatically; slight extra memory but zero code churn when cloud extends.
- B: Zod default (strip) — logs stay stable and enumerated; new fields require a spec edit to surface. Prevents log-line drift from silent cloud changes.

**Answer**: *Pending*

### Q2: Enum tolerance scope
**Context**: FR-002 explicitly calls out "does not enforce a closed enum on `reason`", but FR-001 fixes closed enums on **two** other string fields: `frameType: 'gate-open' | 'gate-outcome' | 'unknown'` and `wroteDoc?: 'created' | 'rebound'`. If cloud adds a new `frameType` (e.g. `'gate-cancel'`) or `wroteDoc` variant, that reply will fail schema parsing and fall to the exact drop-and-warn branch this issue exists to eliminate.
**Question**: Should the same tolerance applied to `reason` also cover `frameType` and `wroteDoc`?
**Options**:
- A: All three tolerant (`z.string()` for all three; document the currently known values in a comment). Fully closes the regression class this issue targets.
- B: Only `reason` tolerant; keep `frameType` and `wroteDoc` as closed enums. Matches the spec text literally; accepts that cloud additions to those two fields will reintroduce the warn.
- C: `reason` + `frameType` tolerant; `wroteDoc` stays closed (rationale: `wroteDoc` is a happy-path-only field that the cloud is unlikely to expand).

**Answer**: *Pending*

### Q3: Router dispatch — short-circuit vs fanout
**Context**: `relay.ts:315-331` currently short-circuits on `api_request` (returns before the `messageHandlers` fanout) and lets everything else flow into the handler loop. FR-004/FR-005 say the router logs and drops. Since no consumer branches on `cluster.cockpit.reply` today (per Assumptions), the behavioural difference is invisible now — but a future subscriber could either receive replies (fanout) or not (short-circuit).
**Question**: After logging, should the router `return` (short-circuit, no handler ever sees the reply) or fall through to `messageHandlers` fanout (handlers see it and no-op today)?
**Options**:
- A: Short-circuit (mirrors `api_request` pattern). Enforces "observability-only in this change" (FR-006) at the routing layer, so a stray handler cannot accidentally begin correlating before #1059 steps 4–7.
- B: Fall through to fanout. Cheaper to enable a downstream consumer later without touching `relay.ts`. Minor risk: someone registers a handler that starts side-effecting before the correlation work in #1059 is designed.

**Answer**: *Pending*

### Q4: Debug log content on `accepted: true`
**Context**: FR-005 enumerates the fields the info log must carry on `accepted: false` (`reason`, `frameType`, `gateId`, `priorStatus`). FR-004 only says "logs at `debug` and drops" without specifying the fields. This determines what an operator sees when they crank the level to debug to trace a stuck run.
**Question**: What fields must the `debug` log line carry on `accepted: true`?
**Options**:
- A: Same field set as FR-005 (`reason`, `frameType`, `gateId`, `priorStatus`) plus `wroteDoc`. Symmetric shape across both branches; easy to grep.
- B: Minimal — `gateId` + `wroteDoc` only. Enough for debug-level correlation to the outbound frame without payload bloat.
- C: Full parsed message object. Zero decisions to make now; slightly noisier at debug.

**Answer**: *Pending*
