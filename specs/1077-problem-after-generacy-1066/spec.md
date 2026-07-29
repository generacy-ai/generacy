# Feature Specification: Mint a `frameId` per outbound cockpit frame and correlate `cluster.cockpit.reply` back to it

**Branch**: `1077-problem-after-generacy-1066` | **Date**: 2026-07-29 | **Status**: Draft
**Issue**: [generacy#1077](https://github.com/generacy-ai/generacy/issues/1077)

## Summary

generacy#1066 taught the cluster's up-path schemas and route to **preserve** a
caller-supplied `frameId`. generacy#1063 taught the relay client to **read**
the cloud's `cluster.cockpit.reply`. No filed work assigns a home for
**minting** a per-frame id at the send site, or for **consuming** the echo
when it arrives at the relay client. Consequence: every outbound `gate-open` /
`gate-outcome` frame today still omits `frameId`, every reply carries
`frameId: null`, and correlation collapses onto `(gateId, frameType)` — which
generacy-cloud#887 Q1 rejected because idempotent retry of `gate-open` for one
`gateId` is the *designed* pattern, not an anomaly.

This spec ships the two remaining halves — mint + consume — plus the small
cleanup that removes the misdirecting comment at
`packages/cluster-relay/src/relay.ts:331`.

## Problem

Three facts compose:

- `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts`
  assembles a `GateOpenWire` record at `:101–118` with no `frameId` field, and
  `cockpit_gate_ack.ts` assembles a `GateOutcomeWire` record at `:36–42` the
  same way. Both go straight to `invokeGate` and then to the orchestrator.
- `grep -rn 'frameId' packages/generacy/src` returns zero hits — no other
  cluster-side sender exists to mint one either.
- `packages/cluster-relay/src/relay.ts:334–349` receives every
  `cluster.cockpit.reply` in a log-and-return branch. There is no `Map<frameId,
  pending>`, no settle site, no drop-on-unknown path.

Result: #1066's preservation is functional but inert. Any code path that
depended on a *caller-supplied* `frameId` reaching the cloud (spec #1066 FR-003
proved the wire is intact) has no producer, and the reply that *does* arrive
back has no consumer.

Meanwhile the comment at `packages/cluster-relay/src/relay.ts:330–333`
(`// Observability-only until #1059 steps 4-7 wire the frameId correlation.`)
actively misleads: steps 4–7 of #1059 are the `runId` work (`runId` through
status / list / query-client / cloud / agency — issues #1067,
generacy-cloud#892, generacy-ai/agency#469) and never touch `frameId`. The
next reader hitting that comment will believe correlation is somebody else's
already-filed problem, and file nothing.

## Consequences today

1. **generacy#1059's acceptance criterion is unreachable.** It reads: *"A
   reply's `frameId` matches the frame the cluster sent, end to end, asserted
   over a real WebSocket rather than a `vi.fn()`."* No currently-filed work
   satisfies it. generacy#1068 (the e2e verification issue) will hit this as
   a hard blocker rather than a pass/fail check.
2. **The correlation regression that #1066 exists to unblock is un-unblocked.**
   #1066 shipped the field-carrying wire; without a minter no reply carries a
   non-null value on the round trip, and generacy-cloud#887 Q1's original
   defect (idempotent-retry collision under `(gateId, frameType)`) remains
   observable end-to-end.
3. **Misdirecting comment at `packages/cluster-relay/src/relay.ts:331`.** The
   next reader looks up #1059's step list, sees that steps 4–7 are `runId`
   work (already merged or filed elsewhere), and concludes there is nothing
   to file. The comment must be updated to name this issue as part of the
   fix.

## Required change

Two halves plus one cleanup:

### 1. Mint (at the orchestrator route — decision D1)

The orchestrator route at `packages/orchestrator/src/routes/cockpit-gates.ts`
mints a per-frame id **at request-accept time, before `tryEmitOrRetain`**,
so the 202 can echo the id, a retained frame carries the id into the retain
queue, and drain emits it verbatim. A caller-supplied `frameId` in the
request body (permitted since #1066) **overrides** the route mint.

Caller sites remain the natural place to *supply* an id when one is needed
(e.g. for a caller that pre-generates for its own logging):
- `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts`
- `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_ack.ts`

The id must be non-empty, unique per emit (retries of the same natural gate
reuse the natural `gateId` — the *frame* around a retry is a distinct send
and gets a distinct `frameId`), and echoed on the 202 response so the
caller and any log correlator see the same value. Generator format:
`` `frm_${crypto.randomBytes(12).toString('hex')}` `` (FR-011).

### 2. Consume (at the relay client — decision D2, observability)

At `packages/cluster-relay/src/relay.ts:334`, keep a `Map<frameId, pending>`
and settle the pending entry when a matching `cluster.cockpit.reply`
arrives, replacing the current log-and-return branch. The settle path logs
at `info` with `frameId` attached. An entry whose `frameId` matches nothing
(caller gone, TTL expired, post-reconnect drain of a frame whose sender is
no longer around) is dropped **quietly** — no error, no leaked map entry,
no log at `error` level — but is logged at `info` with `frameId` so the
case is diagnosable rather than silent.

The map is populated on **every** outbound frame (D5). Entries are evicted
on settle (FR-006) and on TTL expiry at 30s (FR-007); TTL evictions log at
`debug` with `frameId` and entry age. Correlation is observability-only —
there is no in-band delivery of the outcome back to the original sender in
this spec.

### 3. Cleanup

Update the comment at `packages/cluster-relay/src/relay.ts:330–333` to name
**this** issue as the ticket that wires correlation, not #1059 steps 4–7.

## Resolved design decisions (from /speckit:clarify)

The clarify gate resolved five coupled decisions. Load-bearing fact behind
them all: the sender (MCP tool) and the reply-receiver (relay client) live
in **different processes**. `invokeGate` (`mcp/gates/client.ts:29-34`) issues
an HTTP request to the orchestrator; the `cluster.cockpit.reply` handler at
`packages/cluster-relay/src/relay.ts:334` runs inside the orchestrator
process. By the time a reply arrives, the MCP tool that sent the frame has
already returned to its caller, and there is no shared memory between them.

- **D1 — Mint site (Q1 → C):** the orchestrator route
  (`packages/orchestrator/src/routes/cockpit-gates.ts`) mints by default; a
  caller-supplied `frameId` in the request body **overrides**. Mint must
  happen **at request-accept time, before `tryEmitOrRetain`**, so the 202
  can echo the id back, a *retained* frame carries its id into the retain
  queue, and drain emits it verbatim (matches #1066 Q3 and the pass-through
  pinned at `retained-cockpit-events.ts:74`). Caller-supplied ids must be
  honoured — silently discarding them would make #1066's schema work inert.
- **D2 — Sender-observation channel (Q2 → D):** settle is internal-only. The
  pending map exists solely so the relay client can log matched vs unknown
  replies with `frameId` attached; there is no caller-observable channel in
  this spec. See revised US2 below. Cross-process delivery of the outcome
  to the original sender is Out of Scope; if a consumer later needs it,
  SSE on the existing `/events` stream is the natural follow-up shape.
- **D3 — TTL (Q3 → B):** **30 seconds.** Chosen to cover a relay reconnect
  and the retain-drain window (5s cannot; 5min accumulates too much under
  a wedged cloud). **Evictions must log at `debug` with `frameId` and
  entry age** — otherwise a too-short TTL is invisible in production.
- **D4 — Generator (Q4 → B + prefix):** `` `frm_${crypto.randomBytes(12).toString('hex')}` `` — 24 hex chars entropy, `frm_` prefix. The prefix
  matches #1066's already-merged fixtures (`frm_abc`, `frm_xyz`,
  `frm_open_known`, `frm_ack_known`, `frm_wire_known`, `frm_kept`) and
  disambiguates from bare-24-hex `gateId`s in a log line where both
  appear.
- **D5 — Unregistered-send behaviour (Q5 → A):** every mint adds a pending
  entry, forced by D2. With no waiter mechanism, "only-on-waiter-register"
  would mean no entry is ever created, so nothing to correlate. Map churn
  is negligible at gate-frame scale (single digits at steady state under
  a 30s TTL). **Evict on settle in addition to TTL** so map size tracks
  outstanding frames rather than the TTL window.
- **D6 — Wire location (Q4 confirmation):** `frameId` sits *inside* `data`
  on the outbound relay frame, co-located with `gateId`, `gateType`, etc.
  (per #1066 FR-007). Never on the `EventMessage` envelope.

Whichever mint scheme runs, the retain-and-replay path already preserves
`frameId` verbatim (`retained-cockpit-events.ts:74` passes `data` through,
pinned by a test in #1066), and the drop-on-unknown branch is required
regardless.

## User Stories

### US1 — Cluster mints a `frameId` on every outbound cockpit frame

**As** the cluster-side cockpit gate senders (`cockpit_gate_open`,
`cockpit_gate_ack`),
**I want** every outbound `gate-open` and `gate-outcome` frame to carry a
non-empty `frameId` inside `data`,
**So that** the cloud can correlate the resulting `cluster.cockpit.reply` back
to the exact send, not to `(gateId, frameType)`.

**Acceptance criteria**:
- A `gate-open` frame observed on the outbound wire has a non-empty
  `data.frameId` string.
- A `gate-outcome` frame observed on the outbound wire has a non-empty
  `data.frameId` string.
- Two idempotent retries of the same `gateId` produce **distinct** `frameId`s
  on the wire.
- Frames replayed from the retained-events buffer after reconnect carry the
  same `frameId` they had when originally emitted (per #1066 FR-008 — this
  spec must not regress that).

### US2 — Cluster relay client correlates `cluster.cockpit.reply` back to the mint (observability)

**As** an operator or developer diagnosing gate delivery,
**I want** the relay client to correlate every incoming `cluster.cockpit.reply`
back to the specific outbound frame that produced it via a `frameId → pending`
map,
**So that** the cluster can determine from its logs — correlated by `frameId` —
whether a specific outbound frame was accepted or dropped, distinct from
other retries of the same `gateId`.

Correlation here is **observability, not caller notification**: the pending
map exists so `relay.ts:334`'s currently-invisible dropped-reply path becomes
diagnosable. Delivering the outcome back to the original sender in-band is
Out of Scope (see resolved decision D2).

**Acceptance criteria**:
- A reply whose `frameId` matches an entry in the pending map settles that
  entry with the reply's fields (accepted / reason / priorStatus, etc.) and
  logs the settle at `info` with `frameId` attached.
- A reply whose `frameId` matches nothing is dropped quietly: no throw, no
  error-level log, no map mutation. The drop is logged at `info` with
  `frameId` so the case is diagnosable, not silent.
- After settle **or** TTL expiry, the map entry is removed (evict-on-settle
  in addition to TTL). No leak across many send-then-reply cycles.
- TTL evictions log at `debug` with `frameId` and entry age.
- The relay client remains usable when no sender ever needed to learn the
  outcome (all sends today are fire-and-forget at the caller boundary).

### US3 — E2E verification via a real WebSocket

**As** the e2e verification issue generacy#1068,
**I want** the assertion "*a reply's `frameId` matches the frame the cluster
sent*" to be verifiable over a real WebSocket peer (not a `vi.fn()` echoing
its own argument),
**So that** the correlation guarantee reflects real wire behaviour and can be
depended on by generacy-cloud#887 Q1's design.

**Acceptance criteria**:
- The integration test spins up a `ws`-based fake relay peer, drives an
  outbound `gate-open`, has the peer echo `cluster.cockpit.reply` with the
  received `frameId`, and asserts the sender observes the settle.
- The same pattern also covers `gate-outcome`.
- The test also covers the drop-on-unknown branch (peer echoes with a
  bogus `frameId` → asserts no throw, no leaked map entry).

### US4 — Comment at `relay.ts:331` names this issue

**As** the next engineer opening `packages/cluster-relay/src/relay.ts`,
**I want** the comment at `:330–333` to point at the ticket that actually
covers `frameId` correlation,
**So that** I do not follow the current pointer to #1059 steps 4–7, discover
those steps are unrelated `runId` work, and conclude nothing needs filing.

**Acceptance criteria**:
- The comment names generacy#1077 (or the specific work item it produced).
- No trailing "somebody else's already-filed problem" phrasing remains.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Every outbound `gate-open` frame carries a non-empty `frameId` string inside `data`, minted by the orchestrator route at request-accept time (before `tryEmitOrRetain`). A caller-supplied `frameId` in the request body overrides the route mint. | P1 | `packages/orchestrator/src/routes/cockpit-gates.ts` mints; caller path is `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts`. Wire location per #1066 FR-007. Decision D1. |
| FR-002 | Every outbound `gate-outcome` frame carries a non-empty `frameId` string inside `data`, same mint rules as FR-001. | P1 | Caller path is `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_ack.ts`. Decision D1. |
| FR-003 | Two idempotent retries of the same `gateId` produce distinct `frameId`s. | P1 | Retry-collision defence — the exact defect generacy-cloud#887 Q1 rejected. |
| FR-004 | The relay client maintains a `frameId → pending` map and settles the matching entry on `cluster.cockpit.reply`, logging the settle at `info` with `frameId` attached. | P1 | `packages/cluster-relay/src/relay.ts:334`. Replaces the current log-and-return branch. Decision D2 (observability). |
| FR-005 | A `cluster.cockpit.reply` whose `frameId` matches nothing is dropped without throw, without error-level log, and without map mutation. The drop is logged at `info` with `frameId` so the case is diagnosable, not silent. | P1 | Covers: caller gone before reply, TTL expired, post-reconnect drain. Decision D2. |
| FR-006 | The pending-map entry is removed on settle (evict-on-settle, not TTL-only). | P1 | No leak across many cycles. Map size tracks outstanding frames, not TTL window. Decision D5. |
| FR-007 | The pending-map entry is removed on TTL expiry after **30 seconds**. TTL evictions log at `debug` with `frameId` and entry age. | P1 | 30s covers relay reconnect + retain-drain window. Decision D3. |
| FR-008 | Retained frames replayed after reconnect carry their original `frameId` unchanged. | P1 | Guardrail against regressing #1066 FR-008. `packages/orchestrator/src/routes/retained-cockpit-events.ts:74`. |
| FR-009 | The comment at `packages/cluster-relay/src/relay.ts:330–333` is updated to name this issue instead of #1059 steps 4–7. | P1 | Small cleanup — load-bearing because leaving the wrong pointer is what allowed this gap to persist. |
| FR-010 | The E2E test uses a real `ws` WebSocket peer, not a `vi.fn()` echoing its argument. | P1 | Per #1059's acceptance criterion. |
| FR-011 | `frameId` is generated as `` `frm_${crypto.randomBytes(12).toString('hex')}` `` — 24 hex chars entropy, `frm_` prefix. | P1 | Matches #1066's already-merged `frm_*` fixture convention. Disambiguates from bare-24-hex `gateId` in shared log lines. Decision D4. |
| FR-012 | Every mint (route-minted or caller-supplied override) adds a pending-map entry — never conditional on a "waiter" opting in. | P1 | Forced by D2 (no waiter mechanism exists). Decision D5. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | End-to-end assertion over a real WebSocket that a reply's `frameId` matches the frame the cluster sent, for both `gate-open` and `gate-outcome`. | Pass | Integration test drives real `ws` server → real relay client → real MCP tool call, echoes a reply, asserts settle observed. |
| SC-002 | Two idempotent retries of the same `gateId` produce distinct `frameId`s on the outbound wire. | Distinct | Two `cockpit_gate_open` calls with identical `(issueRef, gateType, generation, runId)` → two frame captures → asserted `frameId` inequality. |
| SC-003 | A reply with an unknown `frameId` is dropped without throw and without leaking a pending-map entry. | Pass | Test emits a reply carrying a bogus `frameId`, asserts (a) no thrown error, (b) `pending.size` unchanged, (c) no `error`-level log. |
| SC-004 | Pending-map size returns to steady state (0) after N settle cycles. | 0 after N cycles | Test runs 100 send-then-reply cycles, asserts `pending.size === 0` at end. |
| SC-005 | Retained frames replayed after reconnect settle against the pending map created by their original send. | Pass | Extend `packages/orchestrator/src/__tests__/retained-cockpit-events*.test.ts`. Regression guard on #1066 FR-008. |
| SC-006 | `grep -rn 'frameId' packages/generacy/src \| wc -l` returns non-zero (was zero pre-fix). | ≥ 1 site each in `cockpit_gate_open.ts` and `cockpit_gate_ack.ts` | Static grep on the tree. |
| SC-007 | `grep -n '#1059 steps 4-7' packages/cluster-relay/src/relay.ts` returns nothing (comment cleanup). | 0 hits | Static grep on the file. |
| SC-008 | Zero regression in existing `packages/cockpit/src/__tests__/gates-*.test.ts`, `packages/orchestrator/src/__tests__/cockpit-gates*.test.ts`, and `packages/cluster-relay/tests/relay.test.ts`. | 100% pre-existing tests still green | `pnpm test` across the three packages. |

## Assumptions

- #1066 has landed (or will land before this): schemas preserve `frameId`,
  route forwards it inside `data`, retain-and-replay drains it verbatim.
- #1063 has landed: `cluster.cockpit.reply` parses via `RelayMessageSchema`
  and reaches the branch at `packages/cluster-relay/src/relay.ts:334`.
- Cloud-side reply logic (generacy-cloud#890) already echoes back the
  `frameId` from the frame it received. No cloud change is required.
- The relay wire (`packages/cluster-relay`) remains transport-transparent for
  additional keys on the payload.
- No caller currently depends on the absence of `frameId` on the outbound
  frame (grep confirms zero cluster-side `frameId` producers today).
- Any process-scoped in-memory map is acceptable for the pending map;
  cross-process durability is out of scope (a doomed MCP-tool caller that
  crashes before its reply arrives loses correlation — the reply then hits
  the quiet-drop path per FR-005).

## Out of Scope

- Cloud-side changes in `generacy-cloud`. This spec ships cluster-side only.
- The remaining `runId` work (generacy#1067, generacy-cloud#892,
  generacy-ai/agency#469) — those are #1059 steps 4–7 and unrelated to
  `frameId`.
- Any change to the `gate-answer` down-path schema — unaffected by this bug.
- Any change to the relay message envelope
  (`packages/cluster-relay/src/messages.ts`).
- The `POST /cockpit/gates` route's parsing / forwarding contract — settled
  by #1066 FR-005 and not re-opened here. This spec **adds** the mint step
  at the route before `tryEmitOrRetain`, which is compatible with #1066.
- **In-band delivery of the frame outcome back to the original sender.**
  Decision D2 scopes this spec to correlation-as-observability (settle
  logged with `frameId`; unknown replies logged with `frameId`). If a
  future consumer needs the outcome in-band, the natural follow-up shape
  is a new SSE event type on the existing `/events` stream (cross-process,
  non-blocking to the sender). Do NOT extend the 202 response body, and
  do NOT add a `GET /cockpit/gates/frames/:frameId` polling endpoint in
  this spec — both build a delivery channel for a consumer that does not
  exist today.
- Turning `cockpit_gate_open` / `cockpit_gate_ack` into synchronous cloud
  round-trips (would serialise the startup sweep behind cloud latency —
  see D2 rationale in clarifications.md).
- Cross-process durability of the pending map. See last Assumption.

## Provenance

Found while reviewing generacy#1074 (which shipped #1066). Filed so the trail
from `packages/cluster-relay/src/relay.ts:331` points somewhere real. The
comment cleanup (FR-009) is load-bearing — leaving the wrong pointer is what
allowed nobody to notice this gap for the entire duration of #1063 and #1066.

---

*Generated by speckit*
