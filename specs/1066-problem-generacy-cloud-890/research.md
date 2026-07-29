# Research: Thread `frameId` through `GateOpenSchema` / `GateOutcomeSchema` and orchestrator route

## Decision 1 — Schema shape: `z.union([z.string().min(1), z.literal("").transform(() => undefined)]).optional()` (Q2 → C)

**Chosen**: On both `GateOpenSchema` (`packages/cockpit/src/gates/schema.ts:53`) and `GateOutcomeSchema` (`:77`), add a new field:

```ts
frameId: z
  .union([z.string().min(1), z.literal('').transform(() => undefined)])
  .optional(),
```

The invariant after `.parse()`: the parsed object contains `frameId` only when the caller supplied a non-empty string. All three of the following inputs collapse to the outbound-frame-absent case:
- omitted (`.optional()` handles it)
- supplied as `""` (the `.literal('').transform(...)` normalizes it away)
- supplied as `undefined` (also `.optional()`)

Non-string values (numbers, objects, booleans) are rejected at parse time with a Zod `ZodError`, which the route already catches and converts to `400 VALIDATION` at `cockpit-gates.ts:340-350` and `:419-429`.

**Rationale**: FR-004 requires that the outbound relay frame **not** carry `frameId` when the caller omitted it — "not `null`, not `""`, absent." A bare `z.string().optional()` accepts `""` as valid input and forwards it as `frameId: ""`. Q2 → C explains why that is not a cosmetic invariant: the cloud's guard at `services/api/src/services/relay/message-handler.ts:804` is `typeof data.frameId === 'string'`, which **passes on `""`**. Two concurrent gate frames both carrying `""` would produce two replies both with `frameId: ""`, and the cluster's `frameId → pending-promise` map would collide them onto a single key — one promise settles against the wrong reply, the other waits forever for an echo already delivered under the same key. This is the same correlation-collision class of defect #1053 addressed via `gateId`, arriving through the empty string. Rejected in favor of a schema-level transform that keeps exactly one representation of "no correlation available."

**Alternatives considered**:
- **Q2 A — bare `z.string().optional()`, accept and forward `""` verbatim** — rejected. Ships the correlation-collision bug detailed above.
- **Q2 B — `z.string().min(1).optional()`, reject `""` with 400** — safe, but rejecting a request over a field the route can normalize in one line is unkind to callers who might send an empty string from a JSON serializer's default-empty-string behavior. Also loses the "silent success" property callers expect from optional fields.
- **`z.string().optional().transform(v => v === "" ? undefined : v)`** — equivalent behavior; the `.union(...)` form is the one the spec recommends because it makes the two paths (non-empty accepted, empty transformed) explicit at the type level rather than hidden inside a post-hoc transform.

**Sources**: spec §Required change 1, spec §FR-001/FR-002/FR-004, clarifications.md Q2 answer, cloud read-site `services/api/src/services/relay/message-handler.ts:804` (per Q4 quotation).

## Decision 2 — Position on the outbound frame: inside `data`, not on the `EventMessage` envelope (Q1 → A)

**Chosen**: `frameId` sits inside the `data` object on the outbound `EventMessage` — co-located with `gateId`, `gateType`, `title`, `body`, etc. This is the natural fallout of `parsed` becoming `EventMessage.data` in `tryEmitOrRetain` at `cockpit-gates.ts:158-193`. **No code change** to `packages/cluster-relay/src/messages.ts` `EventMessage` / `EventMessageSchema`. **No hoist** to the envelope.

**Rationale**: Verified against merged cloud source at `services/api/src/services/relay/message-handler.ts:804` (per Q1 answer):

```ts
const data = (message.data ?? {}) as Record<string, unknown>;
const subtype = data?.type as string | undefined;
const frameId = typeof data.frameId === 'string' ? (data.frameId as string) : null;
```

The cloud reads `frameId` off `data`. Q1 → B would hoist it to the `EventMessage` envelope — precisely where the cloud never looks — so the field would arrive, be ignored, and every reply would still carry `frameId: null`. That is shipping a change that is inert by construction, which is the exact failure mode this issue exists to correct. B is the trap that *sounds* correct: it mirrors `ClusterCockpitReplyMessage`'s envelope-level `frameId` (`packages/cluster-relay/src/messages.ts:151-162`), but the reply is a different message type on a different path; matching its shape buys nothing and costs the whole feature.

**Alternatives considered**:
- **Q1 B — hoist `frameId` to `EventMessage` envelope, mirror `ClusterCockpitReplyMessage`** — rejected. Ships inert (cloud reads only `data.frameId`). Requires teaching `EventMessage` / `EventMessageSchema` about a new field. Larger surface. Buys nothing.
- **Q1 C — both envelope AND `data`** — rejected. Duplication with no second consumer. Extra bytes on every frame for a field only ever read from one location.

**Sources**: Cloud source `services/api/src/services/relay/message-handler.ts:804`; spec §Required change 2 + §FR-007; clarifications.md Q1 answer.

## Decision 3 — Route change: none required beyond schema widening (FR-005 preservation)

**Chosen**: `packages/orchestrator/src/routes/cockpit-gates.ts` is **unchanged in code**. The POST handler at `:314-354` already calls `GateOpenSchema.parse(request.body)` and forwards the *parsed* result via `tryEmitOrRetain({ data: parsed, ...})`. Post-schema-fix, `parsed` includes `frameId` when the caller supplied a non-empty one; the existing forward path carries it through unchanged. Same story at the gate-outcome sibling at `:360-433`: the `candidate = { ...(body ?? {}), type, gateId, at }` spread on `:388-396` naturally preserves any caller-supplied `frameId` into the candidate object, and the newly-widened `GateOutcomeSchema.parse(candidate)` retains it.

**Rationale**: US2 / FR-005 are explicit: the route must continue to forward the *parsed* object, not `request.body`. The current forward pattern is the strict-boundary invariant the route was designed around ("no unvalidated caller input reaches the relay"), and this fix is careful to preserve it. The failure mode we are NOT going to introduce: switching the forward to `request.body` to "let `frameId` through" — that would work, but would regress every other validation the schema performs. The correct fix is to make `frameId` a validated field so it survives parsing.

**Alternatives considered**:
- **Widen the route to forward `request.body` when `frameId` is present** — rejected. Regresses US2. Every other field on the request would then reach the relay unvalidated.
- **Post-process the parsed object to graft `frameId` back from `request.body`** — rejected. Duplicates the schema's responsibility, and the graft would need its own validation to guard against `frameId: 123` or `frameId: { evil: true }` — reinventing the schema wheel.
- **Add `.passthrough()` to the schemas** — rejected. Passes through ALL unknown keys, not just `frameId`. Undoes the strict-boundary invariant. Also more permissive than the cloud's up-path schemas, creating drift.

**Sources**: `packages/orchestrator/src/routes/cockpit-gates.ts:314-354` (POST /cockpit/gates), `:360-433` (POST /cockpit/gates/:id/ack), spec §US2 / §FR-005.

## Decision 4 — Retainer change: none required (Q3 → A preserved by pass-through)

**Chosen**: `packages/orchestrator/src/routes/retained-cockpit-events.ts` is **unchanged in code**. The `drainInto(client)` method at `:64-87` already passes `head.data` — the retained data object, held by reference from the original `enqueue({ data: parsed, ... })` call — verbatim to `client.send({ ..., data: head.data, ... })`. Since the retainer never introspects, filters, or copies `data`, any `frameId` on the parsed object at enqueue time survives to drain time.

**Rationale**: Q3 → A specifies preserve-verbatim across retain/drain. The current implementation already does this by construction — the retainer treats `data` as opaque. Q3 → B (clear on drain) would require adding code to strip `frameId` from `data` before sending, which nobody wants to write. Q3 → C (re-issue on drain) would require the retainer to synthesize a new cluster-side `frameId`, which is worse than absent (an echo bearing a value the original caller never saw looks like correlation but matches nothing). The verified pass-through is the correct answer; SC-005 pins it against future regression.

**The `RetainedEvent` type**: at `retained-cockpit-events.ts:3-8`, `data` is typed `unknown` — completely opaque. No new field to add; the widened schema flows through automatically.

**Alternatives considered**:
- **Q3 B — strip `frameId` on drain** — rejected. Reintroduces `(gateId, frameType)` correlation for replayed frames, which is exactly the ambiguity #887 Q1 rejected — and reintroduces it precisely where retries cluster (a reconnect drain).
- **Q3 C — re-issue `frameId` on drain** — rejected. A frameId no one can correlate is strictly less useful than no frameId, because it *looks* like correlation.

**Sources**: `packages/orchestrator/src/routes/retained-cockpit-events.ts:1-96`, spec §Required change 3 + §FR-008, clarifications.md Q3 answer.

## Decision 5 — SC-001 must use a real WebSocket server, not a `vi.fn()` echo (spec-mandated)

**Chosen**: `packages/orchestrator/src/__tests__/cockpit-gates-frameid.integration.test.ts` (NEW) spins up a real `ws` `WebSocketServer` on a random port, points the orchestrator's `ClusterRelayClient` (or a real Relay Bridge configured with `wss://127.0.0.1:<port>`) at it, sends a `POST /cockpit/gates` with a known `frameId`, and asserts that the peer receives an `EventMessage` whose `data.frameId` matches byte-for-byte.

**Rationale**: SC-001 has an explicit rider — "A `vi.fn()` that echoes its own argument does not satisfy this." The point is to catch wire-level regressions the mock cannot see: EventMessage schema stripping (if it were added), envelope-vs-payload placement (if Q1 → B were accidentally implemented), or JSON serialization loss (if a `undefined` field weren't stripped correctly by `JSON.stringify`). Precedent: `packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts` (#1024) already uses this exact real-`ws` pattern, and `packages/cluster-relay/tests/relay.test.ts` is its parent template.

**Alternatives considered**:
- **`vi.fn()` recording the `client.send(...)` argument** — rejected by SC-001 rider. This IS the shape of the tests already in `cockpit-gates.test.ts:75-100` for the other outbound-shape assertions; those are fine for `data.gateId` / `data.gateType` shape checks, but they do not exercise the wire, and SC-001 exists specifically to exercise the wire.
- **Full end-to-end against a live generacy-cloud** — rejected. Overkill; Q4 already confirmed the cloud path is ready. The fake-peer pattern isolates SC-001's assertion to the cluster-side surface.

**Sources**: spec §SC-001 (explicit rider), `packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts` (#1024 precedent), `packages/cluster-relay/tests/relay.test.ts` (parent pattern).

## Decision 6 — Fixture strategy: keep default fixtures frameId-free; opt-in overrides for wire-shape tests

**Chosen**: `VALID_FIXTURES`, `VALID_ACK_FIXTURES`, `VALID_ANSWER_FIXTURES` in `packages/cockpit/src/gates/fixtures.ts` are **unchanged** — none of them add `frameId` by default. The absence-is-the-base-case invariant of FR-006 (older callers keep working) is trivially preserved this way. `gateOpenFixture` / `gateOutcomeFixture` in `packages/cockpit/src/gates/wire-fixtures.ts` gain an optional `frameId` field on their `*FixtureOverrides` types so downstream tests (the new integration test, cockpit-side tests in generacy-cloud if any) can opt in.

**Rationale**: Adding `frameId` to default fixtures would risk existing tests that use `.toEqual(fixture)` to compare against outbound frames — they would suddenly see a new key on both sides and pass, but the invariant they were testing (shape equivalence) would silently include a new field they never intended to assert. Leaving defaults alone keeps every existing test honest and forces the new-behavior tests to opt in explicitly.

**Alternatives considered**:
- **Add `frameId` to default fixtures** — rejected. Contaminates existing shape-equivalence assertions with an unexamined field.
- **Add a separate `VALID_FIXTURES_WITH_FRAMEID` map** — rejected. Two parallel fixture maps to maintain, no consumer for the parallel map beyond one test file. Overrides on `wire-fixtures.ts` are the lighter path.

**Sources**: `packages/cockpit/src/gates/fixtures.ts`, `packages/cockpit/src/gates/wire-fixtures.ts`, spec §FR-006.

## Decision 7 — Changeset bump levels: `@generacy-ai/cockpit` **minor** + `@generacy-ai/orchestrator` **patch**

**Chosen**: `.changeset/1066-frame-id-wire.md` bumps `@generacy-ai/cockpit` **minor** and `@generacy-ai/orchestrator` **patch**.

**Rationale**:
- `@generacy-ai/cockpit`: widens two public wire schemas (`GateOpenSchema`, `GateOutcomeSchema`) with a new optional field. Downstream consumers can now write and read `frameId` — new capability on the public wire contract. CLAUDE.md's changeset rule: "new capability → minor." Even though the field is `.optional()` (backwards-compatible), the ability to supply it is a new public capability, not a defect fix in the package's own code.
- `@generacy-ai/orchestrator`: internal behavior change — the route now forwards a field it previously stripped. No new public exports. No signature changes to any exported function. Bug-fix category per CLAUDE.md's "defect fix → patch" rule. The change surfaces through the widened cockpit schema, so the orchestrator's own public surface is unchanged.
- Both packages listed in a single changeset file per CLAUDE.md's changeset gate ("must be a newly added file in the PR diff... list every package whose non-test src/ changed").

**Alternatives considered**:
- **Both packages patch** — considered, since the spec framing is "make cloud correlation work" (bug). Rejected because the cockpit-side change adds a new optional field to a public wire schema, which downstream consumers can now write against — that is a new capability, not a defect fix in the cockpit package's own behavior (the cockpit package's behavior is exactly what its schema defines, and widening the schema widens the behavior).
- **Both minor** — considered. Rejected because the orchestrator change is invisible at the public API surface; nothing in the orchestrator's exports changed shape.

**Sources**: CLAUDE.md § Changesets (required — CI gate).

## Decision 8 — No cross-repo coordination required (Q4 → A verified, not assumed)

**Chosen**: Land this PR without a companion generacy-cloud PR. Correlation works end-to-end on merge.

**Rationale**: Q4 → A verified against merged cloud source, not assumed. The cloud reads `frameId` off `(message.data ?? {}) as Record<string, unknown>` at `services/api/src/services/relay/message-handler.ts:804`, **before** `handleGateOpen(data, …)` is called and **before** the frozen `gateOpenPayloadSchema` / `gateOutcomePayloadSchema` payload schemas run. Those schemas therefore never see the field and cannot strip it. The cloud author anticipated the additive-field scenario and deliberately kept `frameId` outside the frozen contract so it could be added cluster-side without a coordinated release (per the comment at the read site quoted in clarifications.md Q4 answer). SC-001's real-WebSocket assertion covers the cluster-side surface end-to-end; a downstream generacy-cloud test can add a fake-cluster peer to assert the cloud-side read behavior (out of scope for this repo, may be tracked in generacy-cloud#890's remaining follow-ups).

**Alternatives considered**:
- **Q4 B — assume cloud not ready, gate merge on companion cloud PR** — rejected. Q4's live verification of the read site closed this concern.
- **Q4 C — block on manual verification against generacy-cloud `main`** — rejected. Verification already done in clarifications Q4.

**Sources**: clarifications.md Q4 answer, cited cloud source at `services/api/src/services/relay/message-handler.ts:804`.
