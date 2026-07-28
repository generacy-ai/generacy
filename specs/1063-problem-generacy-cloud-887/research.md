# Research: `cluster.cockpit.reply` schema addition

## Decisions

### D-1: Zod schema tolerance strategy — `.passthrough()` (Q1=A)

**Decision**: Use `z.object({ ... }).passthrough()` for
`ClusterCockpitReplyMessageSchema` so unknown top-level fields are **preserved**
in the parsed value, not stripped.

**Rationale**: This schema exists *because* an unrecognised wire shape was
silently dropped. Zod's default `.object()` accepts extras but strips them
before the router logs — the same failure mode one level down. On the happy
path, `debug` logs the full parsed object (Q4=C); passthrough is what makes
newly-added cloud fields visible there without another schema edit.

**Alternatives considered**:
- Default (strip): stable log-line shape, but future fields disappear
  silently. Same regression class as the bug being closed.
- `.catchall(z.unknown())`: equivalent to passthrough for `z.object` and less
  idiomatic. No advantage.

### D-2: Open `z.string()` on `frameType`, `wroteDoc`, `reason` (Q2=A)

**Decision**: All three string fields typed as `z.string()`. Currently-known
values documented in a JSDoc comment above the schema; not enforced.

**Rationale**: FR-002 as originally written called out only `reason`. FR-001
still fixed closed enums on `frameType` and `wroteDoc`. A cloud-added
`frameType: 'gate-cancel'` or `wroteDoc: 'reused'` would fail
`parseRelayMessage` and fall into the drop-and-warn branch — reintroducing
the exact defect, triggered by a field value instead of a message type.
Fixing one of three enums fixes one third of the regression class.

**Alternatives considered**:
- All three closed enums (as originally implied by FR-001 literal wording):
  rejected — see above.
- Middle ground (open `reason` + `frameType`, closed `wroteDoc`): rejected
  as clarifications Q2 option C. `wroteDoc` was said to be "unlikely to
  expand" — which is precisely the reasoning that produced the original
  defect on `RelayMessageSchema`.

### D-3: Short-circuit dispatch (Q3=A)

**Decision**: The router `return`s after logging, mirroring the `api_request`
short-circuit at `relay.ts:315-322`. `messageHandlers` fanout never sees
`cluster.cockpit.reply`.

**Rationale**: Enforces FR-006 ("observability-only in this change")
structurally rather than by convention. A future subscriber cannot begin
correlating before #1059 steps 4–7 are designed. This matters concretely:
`frameId` is `null` on every real frame today because the orchestrator
forwards a Zod-parsed body and `GateOpenSchema` strips unknown keys. Any
correlation written now would silently key on nothing.

**Alternatives considered**:
- Fanout: cheaper to enable a future consumer without touching `relay.ts`.
  Rejected — the "one-line convenience" is exactly what allows the bug this
  spec exists to prevent from reoccurring at a different layer.

### D-4: Full parsed object at `debug` on `accepted: true` (Q4=C)

**Decision**: `logger.debug({ message }, 'cluster.cockpit.reply received')`
— log the entire parsed object.

**Rationale**: Coherent only with D-1: `.passthrough()` preserves unknown
fields, and logging the full object is what makes that preservation actually
visible on the happy path. Enumerating fields (A/B) would mean any new
cloud-added field is invisible until spec follow-up. `reason` and
`priorStatus` are `undefined` on `accepted: true`, so option A would log two
permanently-empty fields on every happy-path line. `debug` is opt-in — an
operator who turned it on wants everything.

**Alternatives considered**:
- Same fields as FR-005 + `wroteDoc` (A): symmetric shape, easier grep,
  but wastes two always-empty fields and defeats the point of passthrough.
- Minimal `gateId + wroteDoc` (B): usable for grep but silently drops any
  new cloud field, restoring the exact regression class this spec closes.

### D-5: `frameId` type — `z.string().nullable()`

**Decision**: `frameId: z.string().nullable()` — accepts `string` and `null`
but not `undefined`.

**Rationale**: Cloud sends `null` today for every real frame (per Q3
context: orchestrator forwards a Zod-parsed body and `GateOpenSchema` strips
unknown keys, so no `frameId` is passed through). This is deliberate, not a
missing field — it will become a real correlation id in #1059 steps 4–7.
Modeling it as `.nullable()` (present, currently null) rather than
`.optional()` (absent) reflects wire truth and preserves the field for the
correlation work.

### D-6: Test placement — `packages/cluster-relay/tests/` (not `src/__tests__/`)

**Decision**: New tests live in `packages/cluster-relay/tests/messages.test.ts`
and `tests/relay.test.ts`, mirroring existing structure.

**Rationale**: `packages/cluster-relay/tests/` is the established location
(`config.test.ts`, `dispatcher.test.ts`, `messages.test.ts`, `metadata.test.ts`,
`proxy.test.ts`, `relay.test.ts` all live there). No `src/__tests__/` directory
exists in this package. Follow the existing convention.

## Implementation Patterns

### Union-member addition pattern

Existing precedent: the lease-protocol messages (`LeaseRequestMessage`
through `TierInfoMessage`, spec-level comment at `messages.ts:92-95`) were
added the same way — interface at top, schema mid-file, discriminated-union
member append, `RelayMessage` type union extend. Follow that pattern byte-
for-byte on both file locations.

### Short-circuit dispatch pattern

`api_request` at `relay.ts:315-322` is the canonical shape. The reply branch
follows the identical structure: guard on `message.type`, do work, `return`
before falling into `messageHandlers`.

### Test harness pattern

`tests/relay.test.ts` already boots a `ws.WebSocketServer` per test — the
same pattern documented in the multi-repo #1024 spec. Use pino spy for log
assertions (already the assertion mechanism in existing tests).

## Key Sources

- `packages/cluster-relay/src/messages.ts:360` — the discriminated union.
- `packages/cluster-relay/src/messages.ts:387-390` — `parseRelayMessage`.
- `packages/cluster-relay/src/relay.ts:292-296` — the drop-and-warn branch.
- `packages/cluster-relay/src/relay.ts:315-322` — the `api_request`
  short-circuit precedent.
- Spec: `specs/1063-problem-generacy-cloud-887/spec.md`.
- Clarifications: `specs/1063-problem-generacy-cloud-887/clarifications.md`
  (Q1=A, Q2=A, Q3=A, Q4=C — all four are load-bearing on this plan).
- Related tracking: generacy-cloud#887 (upstream sender, merged); #1059
  (remaining cross-repo steps 4–7).
