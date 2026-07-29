# Clarifications

## Batch 1 — 2026-07-29

### Q1: Mint site
**Context**: The spec's §Open design questions lists this as the top open decision (Q1). It determines whether `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts` + `cockpit_gate_ack.ts` gain a minter, or whether `packages/orchestrator/src/routes/cockpit-gates.ts` mints and echoes on the 202. Choice cascades into Q2 (how the caller learns the outcome) and into whether #1066's caller-supplied field remains load-bearing or becomes vestigial.
**Question**: Where should the per-frame `frameId` be minted?
**Options**:
- A: Caller-mints — MCP tools (`cockpit_gate_open`, `cockpit_gate_ack`) generate the id, attach it to the `data` body, and pass it to `invokeGate`. Matches #1066's "caller-supplied" framing; each caller (`/cockpit:auto`, doorbell, ad-hoc) mints separately.
- B: Route-mints — the orchestrator route generates the id when it emits the outbound relay frame and returns it on the `202 {accepted, retained, frameId}`. Simpler wiring; #1066's caller-supplied field becomes an optional override.
- C: Both — route mints by default; caller-supplied id (if present) overrides.

**Answer**: **C** — route mints by default; caller-supplied `frameId` (if present) overrides.

The sender (MCP tool) and reply-receiver (relay client) live in different processes: `invokeGate` (`mcp/gates/client.ts:29-34`) issues an HTTP request to the orchestrator; the `cluster.cockpit.reply` handler at `cluster-relay/src/relay.ts:334` runs in the orchestrator process. Minting at the orchestrator route colocates the mint with the pending map (both in the orchestrator process) and matches "per-frame" = "per emit". Caller-supplied values must be honoured, not silently discarded — #1066 shipped the schema change specifically so a caller-supplied `frameId` survives parsing. Mint at request-accept time, **before `tryEmitOrRetain`**, so the 202 can echo the id, a retained frame carries its id into the retain queue, and drain emits it verbatim (matches #1066 Q3 and the `retained-cockpit-events.ts:74` pass-through). Option A alone would leave every non-updated caller with no `frameId`, making correlation permanently partial.

### Q2: Sender-observation channel
**Context**: The MCP tool that sent the frame has already returned to its caller by the time the reply arrives over the WebSocket at `packages/cluster-relay/src/relay.ts:334`. The spec's §Open design questions Q2 enumerates four candidate channels but does not pick one. This blocks US2's acceptance criterion ("the sender learns whether the frame was accepted or dropped") and shapes the public API of the pending-map layer.
**Question**: How does the sender learn the outcome of its outbound frame?
**Options**:
- A: Relay client exposes an in-process `waitFor(frameId, timeoutMs): Promise<Reply>` (or `EventEmitter`) that the MCP tool awaits before returning its own response. Fits an in-process, same-tick caller.
- B: 202 response body gains a `frameId` field; caller follow-up read via a new `GET /cockpit/gates/frames/:frameId`. Fits cross-process callers.
- C: New SSE event on the existing `/events` stream carries `{frameId, accepted, reason, ...}`.
- D: Settle is internal-only — no caller-observable channel; the pending map exists solely so the relay client can log/telemeter matched vs unknown replies (fire-and-forget everywhere; correlation is observability, not a return value).

**Answer**: **D** — settle is internal-only; correlation is observability, not a return value.

**Option A is not implementable** — it describes "an in-process, same-tick caller" and no such caller exists (process split above). Strike A from the option list; the next reader will otherwise waste time confirming it cannot work. **B and C build a delivery channel for a consumer that does not exist**: nothing today reads a per-frame outcome (`/cockpit:auto` gets its 202 and moves on; gate state is tracked through `openGates` plus the Step-0 pre-draft check). Adding `GET /cockpit/gates/frames/:frameId` or a new SSE event type speculatively is a real surface with its own retention/auth/polling semantics. Also: the literal reading of US2 — "the sender learns whether the frame was accepted or dropped" — can only be satisfied by the sender **waiting** for the reply, which turns `cockpit_gate_open` from fire-and-forget into a synchronous cloud round-trip. The startup sweep opens gates for every triggering issue at once; serialising that behind cloud round-trips is a real regression traded for information nobody currently consumes.

**Action items from this decision**:
1. **Revise US2** to describe correlation as observability, not caller notification. Proposed text: *the cluster can determine from its logs, correlated by `frameId`, whether a specific outbound frame was accepted or dropped.*
2. **Both settle and drop paths log at `info` (or higher) with `frameId` attached**, so `relay.ts:334`'s currently-invisible dropped-reply path becomes diagnosable. Today the log line at `:334` says `reason` / `frameType` / `gateId` and the sender never knows — under `/cockpit:auto` the operator never sees a gate while the loop believes it opened one. D does not fix that, but it makes it diagnosable for the first time.
3. **Note in Out of Scope**: if a consumer later needs the outcome in-band, that is a follow-up; C (SSE on the existing `/events` stream) is the natural shape — cross-process, stream already exists, does not block the sender.

### Q3: Pending-map TTL
**Context**: FR-007 says "Bound TTL — value to be set by /speckit:clarify". This value bounds map growth against callers that walked away (short-lived MCP tools that returned before the reply, crashed callers, post-reconnect drain of retained frames whose original sender is gone). Too short → premature drop of legitimate slow replies; too long → memory pressure on long-running relay clients. The correct value depends on how long the cloud → relay round-trip can plausibly take under adversarial conditions (reconnect, retained-events drain).
**Question**: What TTL should a pending-map entry hold before being evicted (with a quiet drop of any later matching reply)?
**Options**:
- A: 5 seconds — matches typical single-hop round trip; aggressive enough that leaks are self-healing.
- B: 30 seconds — safe for reconnect + retain-drain window; still bounded.
- C: 5 minutes — pessimistic ceiling for any conceivable slow reply path.
- D: Configurable per-call, with a repo-wide default (state the default here, e.g. 30s).

**Answer**: **B** — 30 seconds.

5s is too short: it does not cover a relay reconnect, and #1066 Q3 deliberately preserves `frameId` across retain-and-drain precisely so a post-reconnect drain still correlates. A TTL shorter than the reconnect window would guarantee those replies land in the quiet-drop branch, making the retain-path correlation work pointless. 5 minutes is unbounded in practice: under a wedged cloud the map accumulates every send for five minutes with nothing evicting early. D (configurable) adds a knob with no evidence about which direction to tune it.

**Log evictions at `debug` with the `frameId` and the age.** A TTL that is too short is otherwise invisible: the reply arrives, matches nothing, and is quiet-dropped — indistinguishable from a reply for a frame this process never sent. An eviction log turns "is 30s enough?" into a question the data answers.

### Q4: frameId generator / format
**Context**: FR-001 / FR-002 only say "non-empty string"; the generator format is unspecified. This is one line of code but sets a durable convention (log-grep affordance, wire-log correlation, collision guarantees, dependency footprint). Both minting sites (whichever wins Q1) will use it.
**Question**: What generator/format should mint `frameId`?
**Options**:
- A: `crypto.randomUUID()` (Node built-in, 36-char v4 UUID with hyphens).
- B: `crypto.randomBytes(N).toString('hex')` — pick N (recommended 12 → 24 hex chars, matches the existing `gateId` convention at `packages/cockpit/src/gates/gate-id.ts`).
- C: ULID via a new dependency (lex-sortable, timestamp-prefixed — useful for wire-log ordering).
- D: `{processNonce}-{monotonicCounter}` (fully offline, no crypto — trivially unique per process but not globally unique across relay-client restarts within the same second).

**Answer**: **B with `N = 12`, plus the `frm_` prefix already in use** — i.e. `` `frm_${crypto.randomBytes(12).toString('hex')}` ``.

`crypto.randomBytes(12).toString('hex')` matches the 24-char convention `gateId` already uses (`GateAckInputSchema` pins `gateId: z.string().length(24)`; the cloud derives it as `sha256(gateKey)` truncated to 24), needs no dependency, and has no hyphens to complicate grepping. **Adopt the `frm_` prefix** — #1066's merged fixtures already use `frm_`-prefixed values throughout (`frm_abc`, `frm_xyz`, `frm_open_known`, `frm_ack_known`, `frm_wire_known`, `frm_kept` across schema, route and retention tests). That is a de-facto convention this issue should adopt, and it buys something concrete: a bare 24-hex `frameId` is visually indistinguishable from a 24-hex `gateId` in a log line where both appear — which is exactly the log line an operator reads when correlating. `frm_` + 24 hex keeps the entropy and makes the two impossible to confuse. C's lex-sortability is not worth a new dependency when frames are already timestamped by the log. D is not unique across relay-client restarts, and a restart is precisely when retained frames are drained.

### Q5: Unregistered-send behaviour
**Context**: If Q2's answer is A (waiter Promise) or C (SSE) or D (fire-and-forget), the "send without a registered waiter" case has different implications. In particular, if the caller must opt-in to waiting, we need to know whether unclaimed mints still create a pending-map entry (and therefore rely on TTL cleanup) or skip the map entirely. Directly affects FR-005 (quiet-drop on unknown `frameId`) and FR-006 (removal on settle).
**Question**: When the MCP tool sends a frame but does *not* register a waiter (either by design — fire-and-forget — or because Q2's chosen channel is out-of-band), does the mint site still add a pending-map entry?
**Options**:
- A: Yes — every mint adds a pending entry; unwaited entries expire on TTL; a matching reply either settles (feeding an observability sink) or is quiet-dropped after TTL. Uniform, but map churns on every send.
- B: No — pending-map entry is added *only* when a waiter registers via the mechanism Q2 picks. Unregistered sends never create an entry, and their replies always land in the unknown-`frameId` quiet-drop branch (FR-005). Smaller footprint, but "quiet drop" becomes the normal case, not the exception.
- C: Hybrid — cluster-side callers that need correlation opt in explicitly; the mint call returns the `frameId` regardless so callers can later stitch via logs/SSE.

**Answer**: **A** — every mint adds a pending entry.

Forced by Q2=D and worth stating as a consequence, not an independent choice. With no waiter mechanism, B ("entry only when a waiter registers") means no entry is ever created, the map stays empty, every reply lands in the unknown-`frameId` branch, and the feature does nothing at all. C's opt-in has the same problem for the same reason. So: every mint adds an entry; a matching reply settles it and feeds the observability sink; unmatched replies are quiet-dropped; unsettled entries expire on the Q3 TTL (30s).

The stated cost ("map churns on every send") is not real here: gate frames are human-scale (a handful per epic phase), not request-scale. At 30s TTL the steady-state map holds the frames sent in the last half minute — single digits.

**Evict on settle as well as on TTL** (FR-006), so a matched frame does not sit in the map for the remainder of its TTL. Otherwise map size reflects the TTL window rather than outstanding-frame count, and the Q3 eviction log becomes noise instead of signal.
