# Clarifications: Active-driver claim per cockpit scope

**Issue**: [#1015](https://github.com/generacy-ai/generacy/issues/1015) | **Branch**: `1015-summary-nothing-prevents-two`

## Batch 1 — 2026-07-21

### Q1: Claim marker storage shape
**Context**: The claim marker is the load-bearing GitHub artifact that carries `sessionId`, `heartbeatAt`, and the ledger pointer (FR-002). Storage shape determines (a) how observers/tools discover the claim, (b) heartbeat write cost (comment edit vs. label toggle vs. both), (c) collision risk with the existing `agent:*` / `waiting-for:*` label vocabulary, and (d) refusal-message parsing. Everything downstream — enumeration, TTL/staleness, takeover atomicity — depends on this choice.

**Question**: What is the storage shape of the claim marker on the scope issue?
**Options**:
- A: Structured comment marker only (e.g. `<!-- cockpit:claim v1 ... -->` fenced JSON in a dedicated comment; heartbeat = edit that comment). Avoids label-vocabulary collision, but enumeration requires listing/searching comments.
- B: Label only (e.g. `cockpit:claimed`); marker metadata encoded in the label description or a sidecar file. Cheap to enumerate via label search, but collides with the `agent:*` / `waiting-for:*` scheme and can't carry per-session fields directly.
- C: Comment + label combination — structured comment carries the payload (sessionId, heartbeatAt, ledger); a `cockpit:claimed` label acts as an enumeration index. Two writes per acquire/release, but discoverable and detailed.
- D: Other (specify).

**Answer**: *Pending*

---

### Q2: MCP tool boundary
**Context**: FR-001 requires an MCP-tool-backed claim primitive; FR-005 requires an explicit takeover mode; FR-007 requires heartbeat refresh; FR-009/FR-010 require release. The tool boundary shapes the wire contract, permission model, and how callers (auto skill + future non-playbook drivers) express intent.

**Question**: Should the claim primitive be a single MCP tool with a `verb` argument, or split into discrete tools?
**Options**:
- A: Single `cockpit_claim` tool with `{ verb: "acquire" | "takeover" | "heartbeat" | "release" }` — one surface, one auth check, easy to evolve.
- B: Discrete tools: `cockpit_claim` (acquire), `cockpit_release`, `cockpit_heartbeat`, `cockpit_takeover` — narrower per-tool contracts, clearer least-privilege.
- C: Hybrid: `cockpit_claim` (acquire + heartbeat combined) + separate `cockpit_release`; takeover is a flag on `cockpit_claim` (e.g. `takeover: true`).
- D: Other (specify).

**Answer**: *Pending*

---

### Q3: Heartbeat cadence and staleness threshold
**Context**: FR-007 (heartbeat refresh) and FR-008 (stale claim treated as absent) need concrete numbers. The cadence dictates GitHub write frequency (rate-limit and audit-noise concern); the staleness threshold dictates how long a crashed session blocks the next arm (US3). The two values are coupled — the threshold is typically a small multiple of the cadence so a single missed heartbeat doesn't trigger reap.

**Question**: What heartbeat cadence and staleness threshold should the claim mechanism use?
**Options**:
- A: 60 s cadence, 3 min threshold (3× cadence) — snappy recovery, ~60 writes/hr on the scope comment; matches short auto-loop dispatch cadence.
- B: 120 s cadence, 6 min threshold (3× cadence) — half the GitHub write rate; still bounded recovery, matches typical `cockpit_await_events` heartbeat.
- C: 300 s cadence, 15 min threshold (3× cadence) — very GitHub-friendly; recovery latency ~15 min may be acceptable for the crashed-session case.
- D: Piggyback exclusively on the existing auto-loop tick (no dedicated interval) with a distinct absolute threshold (e.g. 10 min). Specify the target absolute threshold.
- E: Other (specify cadence + threshold pair).

**Answer**: *Pending*

---

### Q4: Takeover surface
**Context**: FR-005 requires an explicit takeover path (US2). The surface determines the operator workflow: is takeover a decision made *before* invoking `/cockpit:auto` (CLI flag), an in-band confirmation *during* the arm (gate-style prompt), a raw MCP-tool argument (for scripted callers), or all of the above? This choice also shapes the refusal payload (FR-004): the refusal must point at whichever mechanism is canonical.

**Question**: How should an operator invoke takeover?
**Options**:
- A: `--takeover` CLI flag on `/cockpit:auto` only — decision must be made at invocation time; refusal payload names the flag.
- B: Gate-style operator confirmation inside the auto skill only — refusal surfaces an interactive gate that the operator accepts; no CLI flag.
- C: MCP-tool argument only (`takeover: true` on the claim tool) — the skill / any scripted driver decides; no dedicated CLI surface, no gate.
- D: All three surfaces (CLI flag + gate + MCP arg) — maximum flexibility, more code paths to test.
- E: Other (specify).

**Answer**: *Pending*

---

### Q5: Superseded-session detection cost
**Context**: FR-006 requires the caller to verify it still holds the claim on driving dispatches. Two implementation shapes trade GitHub call volume against detection latency after a takeover: verify on every `cockpit_advance` / `cockpit_queue` / `cockpit_merge` (extra read per dispatch, immediate detection) vs. piggyback verification on the heartbeat refresh (no extra read, bounded lag ≈ heartbeat cadence).

**Question**: When must the caller verify it still holds the claim?
**Options**:
- A: On **every** driving dispatch (advance, queue, merge) — immediate detection of a takeover; adds one GitHub read per dispatch call.
- B: On the heartbeat refresh **only** — no per-dispatch read; superseded session keeps driving for up to one heartbeat interval before noticing (bounded by Q3 cadence).
- C: On heartbeat + on any dispatch that is itself already touching the scope issue (opportunistic re-check) — no extra reads, but detection lag varies by dispatch pattern.
- D: Other (specify).

**Answer**: *Pending*

---

*Note: Q2 (session id derivation), Q6 (workflow labeling / changeset bump level) from the spec's Clarifications section are deferred — they are low blast-radius (implementer-selectable) and can be resolved in `/speckit:plan` without blocking implementation.*
