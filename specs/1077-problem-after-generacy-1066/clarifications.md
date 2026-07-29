# Clarifications

## Batch 1 — 2026-07-29

### Q1: Mint site
**Context**: The spec's §Open design questions lists this as the top open decision (Q1). It determines whether `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts` + `cockpit_gate_ack.ts` gain a minter, or whether `packages/orchestrator/src/routes/cockpit-gates.ts` mints and echoes on the 202. Choice cascades into Q2 (how the caller learns the outcome) and into whether #1066's caller-supplied field remains load-bearing or becomes vestigial.
**Question**: Where should the per-frame `frameId` be minted?
**Options**:
- A: Caller-mints — MCP tools (`cockpit_gate_open`, `cockpit_gate_ack`) generate the id, attach it to the `data` body, and pass it to `invokeGate`. Matches #1066's "caller-supplied" framing; each caller (`/cockpit:auto`, doorbell, ad-hoc) mints separately.
- B: Route-mints — the orchestrator route generates the id when it emits the outbound relay frame and returns it on the `202 {accepted, retained, frameId}`. Simpler wiring; #1066's caller-supplied field becomes an optional override.
- C: Both — route mints by default; caller-supplied id (if present) overrides.

**Answer**: *Pending*

### Q2: Sender-observation channel
**Context**: The MCP tool that sent the frame has already returned to its caller by the time the reply arrives over the WebSocket at `packages/cluster-relay/src/relay.ts:334`. The spec's §Open design questions Q2 enumerates four candidate channels but does not pick one. This blocks US2's acceptance criterion ("the sender learns whether the frame was accepted or dropped") and shapes the public API of the pending-map layer.
**Question**: How does the sender learn the outcome of its outbound frame?
**Options**:
- A: Relay client exposes an in-process `waitFor(frameId, timeoutMs): Promise<Reply>` (or `EventEmitter`) that the MCP tool awaits before returning its own response. Fits an in-process, same-tick caller.
- B: 202 response body gains a `frameId` field; caller follow-up read via a new `GET /cockpit/gates/frames/:frameId`. Fits cross-process callers.
- C: New SSE event on the existing `/events` stream carries `{frameId, accepted, reason, ...}`.
- D: Settle is internal-only — no caller-observable channel; the pending map exists solely so the relay client can log/telemeter matched vs unknown replies (fire-and-forget everywhere; correlation is observability, not a return value).

**Answer**: *Pending*

### Q3: Pending-map TTL
**Context**: FR-007 says "Bound TTL — value to be set by /speckit:clarify". This value bounds map growth against callers that walked away (short-lived MCP tools that returned before the reply, crashed callers, post-reconnect drain of retained frames whose original sender is gone). Too short → premature drop of legitimate slow replies; too long → memory pressure on long-running relay clients. The correct value depends on how long the cloud → relay round-trip can plausibly take under adversarial conditions (reconnect, retained-events drain).
**Question**: What TTL should a pending-map entry hold before being evicted (with a quiet drop of any later matching reply)?
**Options**:
- A: 5 seconds — matches typical single-hop round trip; aggressive enough that leaks are self-healing.
- B: 30 seconds — safe for reconnect + retain-drain window; still bounded.
- C: 5 minutes — pessimistic ceiling for any conceivable slow reply path.
- D: Configurable per-call, with a repo-wide default (state the default here, e.g. 30s).

**Answer**: *Pending*

### Q4: frameId generator / format
**Context**: FR-001 / FR-002 only say "non-empty string"; the generator format is unspecified. This is one line of code but sets a durable convention (log-grep affordance, wire-log correlation, collision guarantees, dependency footprint). Both minting sites (whichever wins Q1) will use it.
**Question**: What generator/format should mint `frameId`?
**Options**:
- A: `crypto.randomUUID()` (Node built-in, 36-char v4 UUID with hyphens).
- B: `crypto.randomBytes(N).toString('hex')` — pick N (recommended 12 → 24 hex chars, matches the existing `gateId` convention at `packages/cockpit/src/gates/gate-id.ts`).
- C: ULID via a new dependency (lex-sortable, timestamp-prefixed — useful for wire-log ordering).
- D: `{processNonce}-{monotonicCounter}` (fully offline, no crypto — trivially unique per process but not globally unique across relay-client restarts within the same second).

**Answer**: *Pending*

### Q5: Unregistered-send behaviour
**Context**: If Q2's answer is A (waiter Promise) or C (SSE) or D (fire-and-forget), the "send without a registered waiter" case has different implications. In particular, if the caller must opt-in to waiting, we need to know whether unclaimed mints still create a pending-map entry (and therefore rely on TTL cleanup) or skip the map entirely. Directly affects FR-005 (quiet-drop on unknown `frameId`) and FR-006 (removal on settle).
**Question**: When the MCP tool sends a frame but does *not* register a waiter (either by design — fire-and-forget — or because Q2's chosen channel is out-of-band), does the mint site still add a pending-map entry?
**Options**:
- A: Yes — every mint adds a pending entry; unwaited entries expire on TTL; a matching reply either settles (feeding an observability sink) or is quiet-dropped after TTL. Uniform, but map churns on every send.
- B: No — pending-map entry is added *only* when a waiter registers via the mechanism Q2 picks. Unregistered sends never create an entry, and their replies always land in the unknown-`frameId` quiet-drop branch (FR-005). Smaller footprint, but "quiet drop" becomes the normal case, not the exception.
- C: Hybrid — cluster-side callers that need correlation opt in explicitly; the mint call returns the `frameId` regardless so callers can later stitch via logs/SSE.

**Answer**: *Pending*
