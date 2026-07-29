# Implementation Plan: Thread `frameId` through `GateOpenSchema` / `GateOutcomeSchema` and orchestrator route

**Feature**: Preserve caller-supplied `frameId` across the cluster→cloud gate wire so that generacy-cloud#890's per-frame reply correlation stops collapsing onto `(gateId, frameType)` on every idempotent retry.
**Branch**: `1066-problem-generacy-cloud-890`
**Status**: Complete
**Issue**: [#1066](https://github.com/generacy-ai/generacy/issues/1066)

## Summary

`GateOpenSchema` at `packages/cockpit/src/gates/schema.ts:53` and `GateOutcomeSchema` at `:77` are plain `z.object(...)` shapes — unknown keys are **stripped by Zod default**, not preserved. The orchestrator route at `packages/orchestrator/src/routes/cockpit-gates.ts:318` (and its `gate-outcome` sibling at `:397`) parse with `<Schema>.parse(request.body)` and then forward the *parsed* result via `tryEmitOrRetain`. That forward-parsed-not-raw pattern is deliberate — it is the "no unvalidated caller input reaches the relay" invariant the route was designed around — and MUST stay that way (US2 / FR-005). The bug is not the forward pattern; the bug is that `frameId` never survives the schema step to be forwarded in the first place. `git grep frameId` across `packages/cockpit/src`, `packages/orchestrator/src`, and `packages/cluster-relay/src` returns zero hits today, confirming the field is a black hole cluster-side.

The fix teaches both wire schemas about `frameId` as an optional field with a normalization transform — a **union of** `z.string().min(1)` **and** `z.literal("").transform(() => undefined)`, `.optional()` on top. The invariant after `.parse()`: the parsed object contains `frameId` only when the caller supplied a non-empty string. Older callers omitting the field keep working (FR-006). Callers who accidentally send `""` — which the cloud's `typeof data.frameId === 'string'` guard would let through, producing correlation collisions between concurrent frames both bearing the empty string (per clarification Q2 → C reasoning) — get normalized to absent at the schema boundary. The route continues to forward `parsed`, not `request.body` (FR-005 / SC-004).

`frameId` sits **inside** `data` on the outbound `EventMessage` frame — co-located with `gateId`, `gateType`, etc. — because the cloud reads it from `data` at `services/api/src/services/relay/message-handler.ts:804` (per clarification Q1 → A). Envelope-level placement (Q1 option B) would ship the change inert — the cloud never looks there — so the natural fallout of `parsed` becoming `EventMessage.data` in `tryEmitOrRetain` is also the required behavior. No changes to `packages/cluster-relay/src/messages.ts`.

The retain-and-replay path at `packages/orchestrator/src/routes/retained-cockpit-events.ts` requires **no code change** — `drainInto` at `:64-87` already passes `head.data` through verbatim to `client.send(...)` unchanged (verified by inspection). Since the retainer holds the parsed `data` object by reference and the parsed object (post-fix) includes `frameId`, retained gate-open / gate-outcome frames drain to the relay with `frameId` preserved as a natural consequence — no stripping, no re-issuing (satisfies FR-008 / SC-005 per Q3 → A). SC-005 is a **test-only deliverable** that pins this current behavior against future regression.

## Technical Context

- **Language**: TypeScript, ESM, Node >=22
- **Package boundaries**: `@generacy-ai/cockpit` (schema addition, public wire contract) + `@generacy-ai/orchestrator` (route unchanged in code; behavior changes because it forwards the newly-preserved field).
- **Zod version**: workspace-managed; the `z.union([...]).optional()` and `.transform()` primitives used are stable across all Zod 3.x releases in the monorepo.
- **Test runner**: `vitest`.
- **Wire-contract change class**: additive-optional. The cloud's up-path ingestion already tolerates the field — verified in Q4 answer: `frameId` is read from raw `data` (`Record<string, unknown>`) at `services/api/src/services/relay/message-handler.ts:804` **before** `handleGateOpen(data, …)` is called and before the frozen `gateOpenPayloadSchema` / `gateOutcomePayloadSchema` payload schemas run. Those payload schemas never see the field and therefore cannot strip it. **No companion cloud PR required** — correlation works end-to-end on merge (spec Assumptions §Cloud-side).
- **Retain/replay path**: `RetainedCockpitEvents.drainInto` at `retained-cockpit-events.ts:64-87` passes `head.data` unchanged. Verified by inspection. Zero code change on the retention path; a regression test locks the current pass-through against future refactors that might filter fields.
- **Backwards compatibility**: The `frameId` field is `.optional()` on both schemas. Every existing caller (zero of them supply `frameId` today per issue grep) continues to succeed unmodified. Every existing test asserting the outbound frame's shape continues to pass because the outbound frame has no new field when the input has no `frameId` — the "absent, not `null`, not `""`" invariant of FR-004 is enforced at the schema by the `""`→`undefined` transform + `.optional()` combination.
- **Empty-string normalization (Q2 → C, load-bearing)**: A bare `z.string().optional()` would let `""` reach the outbound frame as `frameId: ""`. The cloud's guard is `typeof data.frameId === 'string'` (a plain string check, not a truthiness check), which **passes** on `""`. Two concurrent frames both carrying `""` would produce two replies both with `frameId: ""`, and the cluster's `frameId → pending-promise` map cannot tell them apart — one promise settles against the wrong reply, the other waits forever for an echo already delivered. That is the same correlation-collision class of defect #1053 addressed via `gateId`, arriving through the empty string. The union-with-transform closes it at the schema.
- **No relay envelope change**: `packages/cluster-relay/src/messages.ts` `EventMessage` / `EventMessageSchema` are unchanged (Q1 → A rules out Q1 → B). The `as unknown as RelayMessage` cast at `cockpit-gates.ts:169` (and its sibling at `:414` via `tryEmitOrRetain`) preserves today's shape: `{ type: 'event', event: 'cluster.cockpit', data: parsed, timestamp }`.
- **No caller change**: Existing MCP tools, doorbell, and ad-hoc HTTP callers that never supplied `frameId` continue to work exactly as before. Producing / persisting `frameId`s is caller-side and out of scope (spec §Out of Scope).
- **Public API impact**: `@generacy-ai/cockpit` exports `GateOpenSchema`, `GateOutcomeSchema`, `type GateOpen`, `type GateOutcome` from `packages/cockpit/src/gates/index.ts:5-9`. The new optional field is additive to both type unions — no consumer that only writes today's shape breaks; consumers wanting to read `frameId` can now do so with `?.` narrowing.
- **Cross-repo composition**: Zero coordination required with generacy-cloud. Q4 → A confirmed the cloud already reads `frameId` from raw `data` upstream of the frozen payload schemas; the cloud author deliberately kept the field outside the frozen contract for exactly this scenario. Correlation works end-to-end on the merge tick.

## Project Structure

```
packages/cockpit/
├── src/
│   ├── gates/
│   │   ├── schema.ts                                              # MODIFIED
│   │   │   ├── ~ GateOpenSchema (line 53): add `frameId` field
│   │   │   │   using `z.union([z.string().min(1), z.literal('').transform(() => undefined)]).optional()`
│   │   │   └── ~ GateOutcomeSchema (line 77): add same `frameId` field, same shape
│   │   ├── index.ts                                               # UNCHANGED (re-exports pick up the widened types automatically)
│   │   ├── fixtures.ts                                            # UNCHANGED (existing fixtures omit frameId; absence is the base case)
│   │   ├── wire-fixtures.ts                                       # MODIFIED (small)
│   │   │   └── ~ gateOpenFixture / gateOutcomeFixture: optional
│   │   │       `frameId` in `*FixtureOverrides` so wire-shape tests
│   │   │       downstream can opt in; default output unchanged
│   │   └── __tests__/
│   │       └── gates-schemas.test.ts                              # MODIFIED
│   │           └── + new `describe('frameId', ...)` block: 4-cell
│   │               matrix per SC-003 (non-empty string → present;
│   │               omitted → absent; "" → absent (normalized);
│   │               non-string → rejected). Repeated for both
│   │               GateOpenSchema and GateOutcomeSchema.
├── package.json                                                   # UNCHANGED (no dep changes)

packages/orchestrator/
├── src/
│   ├── routes/
│   │   ├── cockpit-gates.ts                                       # UNCHANGED IN CODE
│   │   │   ├── (POST /cockpit/gates at :314 already calls
│   │   │   │  GateOpenSchema.parse(request.body) and forwards `parsed`
│   │   │   │  via tryEmitOrRetain. Post-schema-fix, `parsed` includes
│   │   │   │  `frameId` when the caller supplied a non-empty one.)
│   │   │   ├── (POST /cockpit/gates/:id/ack at :360 already calls
│   │   │   │  GateOutcomeSchema.parse(candidate) — where `candidate` is
│   │   │   │  `{ ...(body ?? {}), type, gateId, at }`. The spread
│   │   │   │  preserves any caller-supplied `frameId` into `candidate`,
│   │   │   │  and the newly-widened schema now retains it through
│   │   │   │  `.parse()`. No code change needed.)
│   │   │   └── (tryEmitOrRetain at :158-193 uses `ctx.data` — which is
│   │   │       `parsed` — as-is. No change.)
│   │   ├── retained-cockpit-events.ts                             # UNCHANGED IN CODE
│   │   │   └── (drainInto at :64-87 already passes `head.data`
│   │   │       verbatim to `client.send(...)`. Retained frames
│   │   │       carrying frameId drain preserving it as a natural
│   │   │       consequence — Q3 → A.)
│   │   └── __tests__/
│   │       ├── cockpit-gates.test.ts                              # MODIFIED
│   │       │   ├── + `POST /cockpit/gates`: caller supplies frameId → outbound `data.frameId` matches
│   │       │   ├── + `POST /cockpit/gates`: caller omits frameId → `'frameId' in outbound.data === false`
│   │       │   ├── + `POST /cockpit/gates`: caller supplies frameId:"" → outbound absent (SC-002)
│   │       │   ├── + `POST /cockpit/gates/:id/ack`: same 3 cells for gate-outcome
│   │       │   └── + `POST /cockpit/gates`: caller supplies frameId:123 (number) → 400 VALIDATION
│   │       └── retained-cockpit-events.test.ts                    # MODIFIED
│   │           └── + retention preserves frameId across enqueue→drain
│   │               (uses two events, one with frameId, one without; asserts
│   │               drained frames match input `data` byte-for-byte)
│   └── __tests__/
│       └── cockpit-gates-frameid.integration.test.ts              # NEW (SC-001)
│           └── Real WebSocketServer as fake relay peer (pattern lifted
│               from packages/cluster-relay/tests/relay.test.ts).
│               POST /cockpit/gates with { ..., frameId: '<known>' } →
│               await peer.received[0] → assert
│               peer.received[0].data.frameId === '<known>'. A vi.fn()
│               that echoes its own argument does NOT satisfy this
│               (per spec SC-001 explicit rider).
├── package.json                                                   # UNCHANGED

.changeset/
└── 1066-frame-id-wire.md                                          # NEW
    ├── `@generacy-ai/cockpit`: minor (new optional field on public
    │   GateOpenSchema and GateOutcomeSchema — new capability on
    │   wire contract that downstream consumers can now write)
    └── `@generacy-ai/orchestrator`: patch (behavior change — route
        now forwards a field it previously stripped; no new public
        exports; internal-only)

specs/1066-problem-generacy-cloud-890/
├── spec.md                                                        # UNCHANGED
├── clarifications.md                                              # UNCHANGED
├── plan.md                                                        # NEW (this file)
├── research.md                                                    # NEW
├── data-model.md                                                  # NEW
├── quickstart.md                                                  # NEW
└── contracts/
    ├── gate-open-schema.md                                        # NEW
    └── gate-outcome-schema.md                                     # NEW
```

## Constitution Check

No `.specify/memory/constitution.md` file in this repository (verified). Applying general repository conventions from `CLAUDE.md`:

- ✅ **Changesets gate**: One `.changeset/*.md` added (`1066-frame-id-wire.md`) covering both non-test `packages/*/src/` diffs. Bump levels justified in the file.
- ✅ **Test-only carve-out awareness**: Every non-test `packages/*/src/` file in the diff is a real behavior change (schema widening), so the test-only exemption is not the qualifying reason for the changeset — the changeset is required on its own merits.
- ✅ **No comments except for non-obvious "why"**: The schema addition gets one short trailing comment on the `frameId` field noting the union-with-transform rationale (Q2 → C is not obvious from the code shape alone) and referencing the cloud read-site line so future readers can find the correlation contract without digging.
- ✅ **No backwards-compatibility hacks**: `frameId` is a plain optional field on a Zod schema. No shims, no fallbacks. Older callers omit it, works. Newer callers include it, works. No dual-code-path.
- ✅ **Prefer editing existing files**: Only one new source file (the integration test); the schema, route, and retainer changes edit existing files.
- ✅ **CLAUDE.md changeset gate — new label vocabulary rule not triggered**: This change adds a wire-schema field, not a workflow label. The `workflow-engine` minor-bump rule for new labels does not apply here; `@generacy-ai/cockpit` minor is justified independently by the new-optional-field-on-public-schema rule.

## Constraints & Risks

- **The three cost-free wins that make this land trivially**:
  1. The route already forwards `parsed`, not `request.body`, so no route-code change is needed once the schema is fixed.
  2. The retainer already passes `head.data` unchanged, so no retainer-code change is needed for FR-008.
  3. The cloud already reads `frameId` off raw `data` upstream of its frozen payload schemas (Q4 → A verified), so no coordinated cross-repo release is needed.
- **The one place where a subtle mistake would ship the change inert**: putting `frameId` on the `EventMessage` envelope instead of inside `data` (Q1 → B trap). Guardrail: SC-001's real-WebSocket integration test asserts the field lands at `receivedFrame.data.frameId`, not `receivedFrame.frameId` — an envelope-level implementation fails this test. The route's existing shape (`data: parsed`) makes the correct placement the path of least resistance; the risk is if a future refactor "helpfully" hoists the field.
- **The one place where a bare-`z.string().optional()` shortcut would ship a correlation-collision bug**: skipping the `""`→`undefined` transform (Q2 → C). Guardrail: SC-003 explicitly tests the `""` cell and asserts absence on the outbound frame — a bare-optional implementation fails this test.
- **Zero risk to existing tests**: Every current assertion about the outbound frame's shape is a positive assertion about keys the fixture supplied (`gateId`, `gateType`, …). No current test asserts negatives on `frameId` (because the field never existed on the schema), so adding it produces zero regressions in the pre-existing suites (SC-004).
- **No performance concern**: Zod `.optional()` + `.union([..., .transform()])` runs in constant time per parse; the schema still runs once per POST as it does today. The new field adds ≤64 bytes to the outbound JSON on the calls that supply it, and zero bytes on the calls that omit it.

## Next Step

Run `/speckit:tasks` to generate the task list from this plan.
