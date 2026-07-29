# Contract: Fake-peer payload validation (FR-006 tightening)

**Feature**: #1068 | **Related entity**: `E3` in [data-model.md](../data-model.md) | **Location**: `packages/orchestrator/src/__tests__/cockpit-gates/fake-peer.ts` (EXISTING, extension)

Extends the existing #1024 fake peer's inbound-frame handler to run a second Zod parse on `cluster.cockpit` frame payloads with the frozen wire schemas. Load-bearing per FR-006: today the peer only checks the envelope, so a payload-shape drift (the class of bug that shipped `frameId` inert) is not detected locally.

## Trigger

At `fake-peer.ts:148-158` (current envelope validator), on a frame where the parsed envelope has:
- `msg.type === 'event'` **and**
- `msg.event === 'cluster.cockpit'`

## Behaviour

Read `msg.data.type` (already validated as `unknown` by `RelayMessageSchema` — the envelope only requires `data` to be present, not any particular shape).

**Discriminator**:

| `data.type` | Validator | On success | On failure |
|-------------|-----------|-----------|-----------|
| `'gate-open'` | `GateOpenWireSchema.safeParse(msg.data)` | Push `msg` to `received.events`. **If a `FakeCloudStore` is wired**: call `store.putGateFromWireFrame(parsed.data)`. | Push `{ frameType: 'gate-open', gateId: msg.data?.gateId, issues: parsed.error.issues }` to `payloadViolations`. Do NOT push to `received.events`. Do NOT crash. |
| `'gate-outcome'` | `GateOutcomeWireSchema.safeParse(msg.data)` | Push `msg` to `received.events`. **If a `FakeCloudStore` is wired**: call `store.applyOutcome(parsed.data.gateId, parsed.data.outcome, parsed.data.detail)`. | Push `{ frameType: 'gate-outcome', gateId: msg.data?.gateId, issues: parsed.error.issues }` to `payloadViolations`. Do NOT push to `received.events`. Do NOT crash. |
| any other string | (existing behaviour) | Push `msg` to `received.events` as today. | N/A |
| absent / non-string | Push `{ frameType: 'unknown', issues: ... }` to `payloadViolations`. Do NOT push to `received.events`. |

## Schema sources

- `GateOpenWireSchema`, `GateOutcomeWireSchema` from `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` (or a re-export from `@generacy-ai/cockpit` per D-3).
- These are the **cluster-side mirror** of the frozen cloud contract. Using them here is honest: a drift between cluster-side and cloud-side mirrors is a Q1=A residual — out of scope for this harness, covered by generacy-cloud's own suite.

## Wiring seam

`FakePeerOptions` extended with an optional `onValidatedFrame` callback:

```ts
interface FakePeerOptions {
  // ... existing ...
  onValidatedFrame?: (
    frame:
      | { type: 'gate-open'; data: GateOpenWire }
      | { type: 'gate-outcome'; data: GateOutcomeWire },
  ) => void;
}
```

`scenario-helpers.ts`'s `startFakeCloud: true` path wires this callback to route into `FakeCloudStore.putGateFromWireFrame` / `applyOutcome`. Scenarios that only exercise the relay path (no fake cloud) pass no callback and the store hook is a no-op — same as the existing #1024 shape.

## Test surface (assertions on `payloadViolations`)

Happy-path scenarios (every FR-002 through FR-009 test):

```ts
expect(ctx.peer.payloadViolations).toHaveLength(0);
```

FR-006 negative scenario (deliberate drift):

```ts
// Derive from the fixture (SC-004), then drop a required frozen field.
const invalid = gateOpenFixture({ gateId: GID_DRIFT }) as Record<string, unknown>;
delete invalid['askedAt'];

// POST it. The orchestrator route rejects with 400 (existing #1024 F2 assertion).
// Even if the route didn't reject, the peer would catch it here.
// To exercise THIS layer specifically, bypass the route by emitting directly
// from a mock relay client, OR trust that the F2 scenario already covers the
// route rejection and use payloadViolations only as a defence-in-depth check.

// (End state:)
expect(ctx.peer.payloadViolations.length).toBeGreaterThanOrEqual(1);
expect(ctx.peer.payloadViolations[0].issues).toContainEqual(
  expect.objectContaining({ path: ['askedAt'] })
);
```

## Non-behaviours

- **No crash on validation failure.** The peer stays connected; other scenarios in the same file keep running (guards FR-010).
- **No emit-count silencing.** `payloadViolations` is additive; a frame that violates the payload schema is *also* not in `received.events`, and FR-006 assertions rely on both facts.
- **No re-validation of frames the envelope validator already rejected.** The extended check runs INSIDE the `parsed.success === true && msg.type === 'event'` branch. Envelope failures are dropped upstream as today.

## Backwards compatibility with sibling harnesses

`cockpit-gates-integration.integration.test.ts` (#1024) and `cockpit-gates-frameid.integration.test.ts` (#1077) both use `ctx.peer.received.events` for their assertions. Adding payload validation **must not break** any of those tests:
- Every wire body those tests emit comes from `gateOpenFixture` / `gateOutcomeFixture` — schema-compliant by construction.
- FR-006 negative case (F2 in #1024) already asserts on the orchestrator route's 400, so no invalid frame reaches the peer's payload validator in that scenario.
- Net effect on the two sibling files: zero. Verified as a regression check in T012 of `tasks.md`.
