# Clarifications

## Batch 1 — 2026-07-29

### Q1: Outbound-frame position of `frameId`
**Context**: `packages/orchestrator/src/routes/cockpit-gates.ts:318` forwards `parsed`
(the Zod-validated `GateOpen`) as `EventMessage.data`. The natural implementation
puts `frameId` *inside* `data` (co-located with `gateId`, `gateType`, …), because
`parsed` is what becomes `data` in `tryEmitOrRetain`. But `ClusterCockpitReplyMessage`
at `packages/cluster-relay/src/messages.ts:151-162` carries `frameId` at the
**top level of the envelope**, not inside a payload — so a reader might reasonably
expect the up-path to mirror the down-path envelope shape. If the cloud expects
`frameId` at envelope level, an implementation that puts it inside `data` will not
enable correlation and this spec ships inert. The two implementations diverge
significantly (envelope-level requires teaching `EventMessage` / `EventMessageSchema`
about `frameId`; inside-`data` is the current default).
**Question**: Where should `frameId` sit on the outbound relay frame?
**Options**:
- A: Inside `data`, alongside the other gate-open / gate-outcome fields — natural
  fallout of `parsed` becoming `data`. Cloud reads it from `gateOpenPayloadSchema` /
  `gateOutcomePayloadSchema` on the up path.
- B: Hoisted to the top level of `EventMessage` (mirrors `ClusterCockpitReplyMessage`).
  Requires adding `frameId` to `EventMessage` / `EventMessageSchema` in
  `packages/cluster-relay/src/messages.ts` and threading it through `tryEmitOrRetain`.
- C: Both — inside `data` (payload-native) AND on the envelope (for cheap correlation
  in transport-level logging). Duplication accepted.

**Answer**: *Pending*

### Q2: Handling of explicit `frameId: ""` on the inbound request
**Context**: FR-004 says an *omitted* `frameId` must produce an absent field on the
outbound frame ("not `null`, not `\"\"`, absent"). But the schema shape the spec
prescribes (`z.string().optional()`) *accepts* `frameId: ""` as valid input and, if
present, propagates it — the outbound frame would then carry `frameId: ""`, violating
the "not empty string" invariant that FR-004 pointedly names. The Required-change
section spells out `z.string().optional()` (no `.min(1)`), so today's spec reads as
"accept and forward the empty string." That may not be the intent.
**Question**: How should the route treat a request whose body includes `frameId: ""`?
**Options**:
- A: Accept and forward verbatim — bare `z.string().optional()`. Empty string reaches
  the outbound frame as `frameId: ""`. FR-004's "not `\"\"`" clause is scoped to the
  *omitted-input* case only.
- B: Reject with 400 `VALIDATION` — schema is `z.string().min(1).optional()`. Callers
  cannot supply an empty frameId.
- C: Normalize to absent — the route/schema treats `""` as equivalent to omission and
  emits an outbound frame with no `frameId` property.

**Answer**: *Pending*

### Q3: `frameId` on retained-then-replayed events
**Context**: When the relay is offline, `tryEmitOrRetain` enqueues the event into
`RetainedCockpitEvents` (`packages/orchestrator/src/routes/retained-cockpit-events.ts`).
On reconnect, `drainInto` sends the retained `data` (which, after this fix, includes
`frameId`) to the relay. That drain can happen seconds, minutes, or hours after the
original POST. A caller's `frameId` was generated for the *original send attempt*;
the semantics of preserving it across a delayed replay are not obvious. Preserving
verbatim (natural fallout of the retainer holding the object by reference) makes
correlation stable across retention; clearing on drain would treat replay as "a new
frame the caller didn't produce" and force cloud to fall back to `(gateId, frameType)`.
**Question**: When a retained `gate-open` / `gate-outcome` is drained after reconnect,
should its `frameId` be preserved verbatim, cleared, or re-issued?
**Options**:
- A: Preserve verbatim — the drain path passes `data` (with `frameId`) through
  unchanged. Correlation stays stable across retention.
- B: Clear on drain — the retainer / drain path strips `frameId` before send; cloud
  falls back to `(gateId, frameType)` correlation for replayed frames.
- C: Re-issue on drain — the drain path replaces the retained `frameId` with a fresh
  cluster-side value marking "this is a delayed replay, not the original."

**Answer**: *Pending*

### Q4: Cloud-side up-path ingestion readiness
**Context**: The Assumptions section claims "Cloud-side `frameId` typing is
`z.string().nullable()` **on the reply path**. No cloud change is required to consume
the new field." That statement covers only the *reply* (cloud → cluster). The
*up-path* ingestion — cloud's `gateOpenPayloadSchema` / `gateOutcomePayloadSchema` in
`services/api/src/services/relay/message-handler.ts` — is a separate Zod schema, and
plain `z.object` **strips unknown keys by default**. If cloud's up-path schemas do
not yet accept `frameId` (either as an explicit optional field or via
`.passthrough()`), the field will be dropped at cloud ingestion and reply correlation
will not work end-to-end even after this spec lands. The spec's "landing this alone
makes the cloud's correlation logic able to do its job" claim depends on cloud-side
readiness that is not explicitly asserted.
**Question**: Does the cloud's up-path ingestion (`gateOpenPayloadSchema` /
`gateOutcomePayloadSchema` in `generacy-cloud`) already accept and persist `frameId`?
**Options**:
- A: Yes — cloud ingestion is ready (already has `frameId` on the schema or already
  uses `.passthrough()`). This cluster-side change unblocks correlation end-to-end on
  merge.
- B: No — cloud ingestion is not yet ready. This cluster-side change is safe to land
  in isolation (per "why safe to land alone") but reply correlation stays inert until
  a matching cloud PR ships. Update spec's Success Criteria to reflect the gated
  end-to-end outcome.
- C: Unknown — verify against generacy-cloud `main` before merging; block on that
  check.

**Answer**: *Pending*
