# Clarifications: Add `cluster.cockpit.reply` to `RelayMessageSchema`

## Batch 1 — 2026-07-28

### Q1: Unknown-field handling strategy
**Context**: FR-002 says the new schema must be "tolerant of unknown fields at the top level (does not reject on extras)". Zod's default `.object()` accepts extras but silently **strips** them from the parsed output. `.passthrough()` accepts extras and **preserves** them in the parsed value. This choice determines whether a future cloud-added field (e.g. `wroteDocPath`) shows up in the router's log lines or disappears before logging.
**Question**: Should `ClusterCockpitReplyMessageSchema` use Zod default (strip unknowns) or `.passthrough()` (preserve unknowns)?
**Options**:
- A: `.passthrough()` — future fields land in `accepted: false` info logs automatically; slight extra memory but zero code churn when cloud extends.
- B: Zod default (strip) — logs stay stable and enumerated; new fields require a spec edit to surface. Prevents log-line drift from silent cloud changes.

**Answer**: A — `.passthrough()`, preserve unknown fields. This schema exists *because* an unrecognised message was dropped and warned about; stripping is the same failure one level down. A future cloud-added field would vanish before it could be logged, and the first sign of trouble would be its absence. B's "log-line drift" concern is legitimate for a stable API surface, but this is a diagnostic message logged at `debug`/`info`, where an invisible field is far worse than a noisy one.

### Q2: Enum tolerance scope
**Context**: FR-002 explicitly calls out "does not enforce a closed enum on `reason`", but FR-001 fixes closed enums on **two** other string fields: `frameType: 'gate-open' | 'gate-outcome' | 'unknown'` and `wroteDoc?: 'created' | 'rebound'`. If cloud adds a new `frameType` (e.g. `'gate-cancel'`) or `wroteDoc` variant, that reply will fail schema parsing and fall to the exact drop-and-warn branch this issue exists to eliminate.
**Question**: Should the same tolerance applied to `reason` also cover `frameType` and `wroteDoc`?
**Options**:
- A: All three tolerant (`z.string()` for all three; document the currently known values in a comment). Fully closes the regression class this issue targets.
- B: Only `reason` tolerant; keep `frameType` and `wroteDoc` as closed enums. Matches the spec text literally; accepts that cloud additions to those two fields will reintroduce the warn.
- C: `reason` + `frameType` tolerant; `wroteDoc` stays closed (rationale: `wroteDoc` is a happy-path-only field that the cloud is unlikely to expand).

**Answer**: A — all three tolerant (`reason`, `frameType`, `wroteDoc` as `z.string()`), overriding FR-002's literal text deliberately. FR-002 names only `reason`, but FR-001 fixes closed enums on two other string fields. If the cloud adds a `frameType` (e.g. `gate-cancel`) or `wroteDoc` variant, the reply fails to parse, falls into the drop-and-warn branch, and reintroduces the exact bug this issue closes — triggered by a field value instead of a message type. Fixing one of three enums fixes one third of the regression class. C rejected because its rationale ("`wroteDoc` unlikely to expand") is precisely the reasoning that produced the original defect. Document currently known values in a code comment; do not enforce.

### Q3: Router dispatch — short-circuit vs fanout
**Context**: `relay.ts:315-331` currently short-circuits on `api_request` (returns before the `messageHandlers` fanout) and lets everything else flow into the handler loop. FR-004/FR-005 say the router logs and drops. Since no consumer branches on `cluster.cockpit.reply` today (per Assumptions), the behavioural difference is invisible now — but a future subscriber could either receive replies (fanout) or not (short-circuit).
**Question**: After logging, should the router `return` (short-circuit, no handler ever sees the reply) or fall through to `messageHandlers` fanout (handlers see it and no-op today)?
**Options**:
- A: Short-circuit (mirrors `api_request` pattern). Enforces "observability-only in this change" (FR-006) at the routing layer, so a stray handler cannot accidentally begin correlating before #1059 steps 4–7.
- B: Fall through to fanout. Cheaper to enable a downstream consumer later without touching `relay.ts`. Minor risk: someone registers a handler that starts side-effecting before the correlation work in #1059 is designed.

**Answer**: A — short-circuit after logging, mirroring the `api_request` pattern. Makes "observability-only" (FR-006) structural rather than conventional; a stray handler cannot begin correlating before #1059 steps 4–7 are designed. This matters concretely: `frameId` is `null` on every real frame today because the orchestrator forwards the Zod-parsed body and `GateOpenSchema` strips unknown keys, so any correlation written now would silently key on nothing. Fanout can be added later as a one-line change if needed.

### Q4: Debug log content on `accepted: true`
**Context**: FR-005 enumerates the fields the info log must carry on `accepted: false` (`reason`, `frameType`, `gateId`, `priorStatus`). FR-004 only says "logs at `debug` and drops" without specifying the fields. This determines what an operator sees when they crank the level to debug to trace a stuck run.
**Question**: What fields must the `debug` log line carry on `accepted: true`?
**Options**:
- A: Same field set as FR-005 (`reason`, `frameType`, `gateId`, `priorStatus`) plus `wroteDoc`. Symmetric shape across both branches; easy to grep.
- B: Minimal — `gateId` + `wroteDoc` only. Enough for debug-level correlation to the outbound frame without payload bloat.
- C: Full parsed message object. Zero decisions to make now; slightly noisier at debug.

**Answer**: C — log the full parsed message object at `debug`. Coherent only because Q1 = A: `.passthrough()` preserves unknown fields, and C is what makes that preservation actually visible on the happy path; choosing A would mean passthrough buys nothing there. Note also that `reason` and `priorStatus` are undefined on `accepted: true`, so option A would log two permanently-empty fields on every happy-path line. `debug` is opt-in, so the volume is acceptable — an operator who has turned it on wants everything. FR-005's enumerated field set stays as specified for the `accepted: false` `info` line; that one is not in question and does not change.
