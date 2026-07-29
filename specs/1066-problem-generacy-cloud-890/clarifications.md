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

**Answer**: **A — inside `data`**. Verified against merged cloud source at
`services/api/src/services/relay/message-handler.ts:804`:
```ts
const data = (message.data ?? {}) as Record<string, unknown>;
const subtype = data?.type as string | undefined;
const frameId = typeof data.frameId === 'string' ? (data.frameId as string) : null;
```
The cloud reads `frameId` off `data`. Option B would hoist it to the `EventMessage`
envelope — precisely where the cloud never looks — so the field would arrive, be
ignored, and every reply would still carry `frameId: null`. That is shipping a change
that is inert by construction, which is the exact failure mode this issue exists to
correct. B is the trap that *sounds* correct: it mirrors `ClusterCockpitReplyMessage`'s
envelope-level `frameId`, but the reply is a different message type on a different
path; matching its shape buys nothing and costs the whole feature. C duplicates the
field with no second consumer.

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

**Answer**: **C — normalize `""` to absent**. Not a cosmetic invariant. The cloud's
guard is `typeof data.frameId === 'string'`, which an empty string **passes**. So
`""` is accepted as a genuine frameId rather than falling through to `null`, and the
cloud echoes `frameId: ""` on the reply. Two concurrent gate frames that both carried
`""` produce two replies both with `frameId: ""`, and the cluster's
`frameId -> pending-promise` map cannot tell them apart: one promise settles against
the wrong reply, the other waits for an echo already delivered under the same key.
That is a correlation collision — the same class of defect as the deterministic
`gateId` collision in #1053, arriving through the empty string. A ships that
collision. B (400) is safe but rejecting a request over a field the route can
normalize in one line is unkind to callers for no gain. C keeps exactly one
representation of "no correlation available" — which is what FR-004 is asking for
when it says *not `null`, not `""`, absent*.

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

**Answer**: **A — preserve verbatim across retain/drain**. B falls back to
`(gateId, frameType)` for replayed frames, and #887 Q1 rejected that pair as a
correlation key: idempotent retry of `gate-open` for one `gateId` is the *designed*
pattern, so the pair is not unique. Reintroducing it on the retention path
reintroduces the ambiguity exactly where frames are most likely to be duplicated —
a reconnect drain is when retries cluster. C is worse: re-issuing a cluster-side id
means the echo comes back bearing a value the original caller never saw, so nobody
can match it — a frameId no one can correlate is strictly less useful than no
frameId, because it *looks* like correlation. Under A, the natural degradation is
already correct: if the drain happens long after the caller's pending-promise has
TTL'd, the echo arrives, matches nothing, and is dropped — a no-op, not a leak. For
the case that matters (reconnect seconds after the send, caller still waiting),
correlation works.

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

**Answer**: **A — the cloud up-path is ready; verified, not assumed**. Plain
`z.object` strips unknown keys — real hazard, and the spec's assumption was stated
more confidently than it was evidenced. It does not apply here, and the cloud says
so in a comment at the read site: *"`frameId` is read off the raw data (opaque; not
part of the frozen Zod payload schemas)."* `data` is
`(message.data ?? {}) as Record<string, unknown>` — unparsed — and `frameId` is read
at `:804`, before `handleGateOpen(data, …)` is called and before any payload schema
runs. `gateOpenPayloadSchema` / `gateOutcomePayloadSchema` never see the field and
therefore cannot strip it. The cloud author anticipated this scenario and deliberately
kept `frameId` outside the frozen contract so it could be added cluster-side without
a coordinated release. No companion cloud PR required; correlation works end-to-end
on merge; Success Criteria stand as written.
