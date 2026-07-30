# Feature Specification: Thread `frameId` through `GateOpenSchema` / `GateOutcomeSchema` and orchestrator route

**Branch**: `1066-problem-generacy-cloud-890` | **Date**: 2026-07-29 | **Status**: Draft
**Issue**: [generacy#1066](https://github.com/generacy-ai/generacy/issues/1066)

## Summary

`generacy-cloud#890` correlates every `cluster.cockpit.reply` back to the frame
that caused it via `frameId`. That correlation is inert today: `frameId` can
never reach the cloud, so every reply carries `frameId: null` and correlation
collapses onto `(gateId, frameType)` — which `generacy-cloud#887` Q1
explicitly rejected. Idempotent retry of `gate-open` for one `gateId` is the
*designed* pattern, not an anomaly, and the fallback correlation cannot tell
retries apart from the original.

This spec ships the minimal cluster-side change that makes cloud correlation
work: teach the two up-path Zod schemas and the orchestrator route to preserve
a caller-supplied `frameId`.

## Problem

Three facts compose:

- `packages/cockpit/src/gates/schema.ts:53` (`GateOpenSchema`) and `:77`
  (`GateOutcomeSchema`) are plain `z.object`, so unknown keys are **stripped**,
  not preserved.
- `packages/orchestrator/src/routes/cockpit-gates.ts:318` parses with
  `GateOpenSchema.parse(request.body)` and forwards **`parsed`**, never the
  raw body — so anything the schema drops is gone before the relay sees it.
- `git grep frameId` across `packages/cockpit/src`, `packages/orchestrator/src`,
  and `packages/cluster-relay/src` returns **zero** hits.

Result: any caller that supplies `frameId` on a `gate-open` or `gate-outcome`
request has that field silently dropped at the schema boundary. The relay
frame goes out without it, the cloud's reply carries `frameId: null`, and
downstream correlation cannot distinguish idempotent retries from the
original send.

## Why this is safe to land alone

Purely additive. Nothing on the cluster reads `frameId`, and the cloud already
tolerates its absence (it is typed `z.string().nullable()` on the reply).
Landing this before or after any other piece of the gate-identity work changes
no behaviour on its own — it only makes the cloud's existing correlation logic
able to do its job.

This was step 1–2 of generacy#1059, called out there as independently landable.

## Required change

1. Add a `frameId` field to `GateOpenSchema` and `GateOutcomeSchema` in
   `packages/cockpit/src/gates/schema.ts` that (a) accepts a non-empty string,
   (b) accepts omission, and (c) **normalizes an empty string to absent**.
   Recommended shape:
   `frameId: z.union([z.string().min(1), z.literal("").transform(() => undefined)]).optional()`
   or equivalent (e.g. `z.string().optional().transform(v => v === "" ? undefined : v)`).
   The invariant is: after `.parse()`, the parsed object contains `frameId` only
   if the caller supplied a non-empty string. Older callers that omit the field
   must keep working (per clarification Q2 → C).
2. Preserve `frameId` through validation and forwarding in
   `packages/orchestrator/src/routes/cockpit-gates.ts:318` (and its `gate-outcome`
   sibling). `frameId` sits **inside** `data` on the outbound relay frame —
   co-located with `gateId`, `gateType`, etc. — because the cloud reads it off
   `data` at `services/api/src/services/relay/message-handler.ts:804` (per
   clarification Q1 → A). Do **not** hoist it to the `EventMessage` envelope;
   the cloud would never see it there and the change would ship inert.

Step 2 needs care. The route forwards the *parsed* object deliberately —
that is what stops unvalidated caller input reaching the relay, and it
should stay that way. The fix is to make `frameId` a validated field so it
survives parsing, **not** to start forwarding `request.body`.

When `frameId` is absent from the request (or supplied as `""`, which normalizes
to absent), the outbound frame must not carry the field at all — no
`frameId: null`, no `frameId: ""`, absent.

3. On the retain-and-replay path
   (`packages/orchestrator/src/routes/retained-cockpit-events.ts`), a retained
   `gate-open` / `gate-outcome` that carries `frameId` must be drained **with
   `frameId` preserved verbatim** — the drain path passes `data` through
   unchanged (per clarification Q3 → A). No stripping, no re-issuing. If the
   caller's pending-promise has TTL'd by the time the drain happens, the echo
   arrives, matches nothing, and is dropped — natural, correct degradation.

## User Stories

### US1 — Cloud can correlate replies to the frame that caused them

**As** the cloud-side reply-handling code in `generacy-cloud#890`,
**I want** every `cluster.cockpit.reply` to carry the `frameId` of the frame
that produced it,
**So that** idempotent retries of `gate-open` for a single `gateId` produce
distinguishable replies (rather than colliding under `(gateId, frameType)`
correlation).

**Acceptance criteria**:
- The `frameId` supplied on a `POST /cockpit/gates` request reaches the
  outbound relay frame unchanged.
- The same holds for the up-path `gate-outcome` request.
- A request with no `frameId` succeeds and the outbound frame carries no
  `frameId` — the field is absent, not `null`, not `""`.

### US2 — Route continues to reject unvalidated caller input

**As** an operator relying on `packages/orchestrator/src/routes/cockpit-gates.ts`
to be the strict boundary between HTTP callers and the relay,
**I want** the route to forward a Zod-validated object (not `request.body`),
**So that** the fix does not regress the "no unvalidated caller input reaches
the relay" invariant that the route was designed around.

**Acceptance criteria**:
- The route continues to call `GateOpenSchema.parse` / `GateOutcomeSchema.parse`
  and forward the *parsed* result.
- `request.body` is not forwarded raw at any point.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `GateOpenSchema` accepts an optional non-empty-string `frameId` and normalizes `""` to absent. | P1 | `packages/cockpit/src/gates/schema.ts:53`. Per clarification Q2 → C. |
| FR-002 | `GateOutcomeSchema` accepts an optional non-empty-string `frameId` and normalizes `""` to absent. | P1 | `packages/cockpit/src/gates/schema.ts:77`. Per clarification Q2 → C. |
| FR-003 | When a caller supplies a non-empty `frameId`, the value on the outbound relay frame equals the value on the inbound request byte-for-byte. | P1 | Applies to both `gate-open` and `gate-outcome`. |
| FR-004 | When a caller omits `frameId` **or** supplies `""`, the outbound relay frame has no `frameId` property. | P1 | Not `null`, not `""`, absent. Achieved by (a) Zod `.optional()` for omission and (b) an explicit `""` → `undefined` transform for the empty-string case. Rationale: cloud guard `typeof data.frameId === 'string'` passes on `""`, which would collapse concurrent requests onto a single correlation key (per clarification Q2 → C). |
| FR-005 | The orchestrator route continues to forward the parsed object, not `request.body`. | P1 | `packages/orchestrator/src/routes/cockpit-gates.ts:318` and its `gate-outcome` sibling. |
| FR-006 | Older callers that do not supply `frameId` continue to succeed with no user-visible change. | P1 | The field is optional. |
| FR-007 | `frameId` sits inside `data` on the outbound relay frame, not on the `EventMessage` envelope. | P1 | Per clarification Q1 → A. Cloud reads `data.frameId` at `services/api/src/services/relay/message-handler.ts:804`; envelope-level placement would ship inert. |
| FR-008 | When a retained `gate-open` / `gate-outcome` is drained after reconnect, its `frameId` is preserved verbatim. | P1 | Per clarification Q3 → A. `packages/orchestrator/src/routes/retained-cockpit-events.ts` (`drainInto`). No stripping, no re-issuing. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | End-to-end assertion over a real WebSocket that a reply's `frameId` matches the frame the cluster sent. | Pass | Integration test spins up a real `ws` server as the fake relay peer, sends a `gate-open` with a known `frameId`, asserts the relayed frame carries that exact value. A `vi.fn()` that echoes its own argument does not satisfy this. |
| SC-002 | `frameId` absence produces an absent field (not `null`, not `""`) on the outbound frame. | Pass | Assert `'frameId' in relayedFrame === false` when the inbound request omitted it. |
| SC-003 | Unit tests over `GateOpenSchema` / `GateOutcomeSchema` show `frameId` accepted when supplied as a non-empty string, absent when omitted, absent when supplied as `""` (normalized), and rejected when supplied non-string. | Pass | Vitest fixture matrix. Explicit `""` → absent case is load-bearing (per clarification Q2 → C). |
| SC-005 | Integration test asserts that a retained-then-drained `gate-open` carrying `frameId` reaches the relay with the *same* `frameId` after reconnect. | Pass | Extend `packages/orchestrator/src/__tests__/retained-cockpit-events*.test.ts` (or equivalent). Per FR-008. |
| SC-004 | Zero regression in existing `packages/cockpit/src/__tests__/gates-*.test.ts` and `packages/orchestrator/src/__tests__/cockpit-gates*.test.ts`. | 100% pre-existing tests still green | `pnpm --filter @generacy-ai/cockpit test` + `pnpm --filter @generacy-ai/orchestrator test`. |

## Assumptions

- Cloud-side `frameId` typing is `z.string().nullable()` on the reply path
  (per issue text). No cloud change is required to consume the new field.
- Cloud-side up-path ingestion reads `frameId` off the raw `data`
  (`Record<string, unknown>`) at
  `services/api/src/services/relay/message-handler.ts:804`, **before** the
  frozen `gateOpenPayloadSchema` / `gateOutcomePayloadSchema` payload schemas
  run. Per clarification Q4 → A: this was a deliberate design choice by the
  cloud author (documented at the read site) so `frameId` could be added
  cluster-side without a coordinated release. The unknown-key-stripping
  hazard that plain `z.object` would create does not apply. No companion
  cloud PR required; correlation works end-to-end on merge.
- The relay wire (`packages/cluster-relay`) is transport-transparent —
  additional keys on the payload pass through without further schema-level
  stripping between the orchestrator route and the WebSocket send.
- No caller is currently supplying `frameId` and being *depended on* to have
  it stripped. (Grep in the issue confirms zero cluster-side `frameId`
  references today.)

## Out of Scope

- Cloud-side changes in `generacy-cloud`. This spec ships cluster-side only.
- The remaining steps of generacy#1059 (full cross-repo change set). Landing
  this spec unblocks correlation but does not complete #1059.
- Any change to the `gate-answer` down-path schema
  (`packages/cockpit/src/gates/schema.ts:92`) — unaffected by this bug.
- Any change to the relay message envelope
  (`packages/cluster-relay/src/messages.ts`).
- Producing or persisting `frameId`s (that lives with the caller — MCP tools,
  doorbell, or ad-hoc clients). This spec only guarantees preservation.

## Provenance

Split from generacy#1059 (steps 1–2), which tracks the full cross-repo
change set. Raised from the reviews of generacy#1055 and
generacy-cloud#890 on 2026-07-28.

---

*Generated by speckit*
