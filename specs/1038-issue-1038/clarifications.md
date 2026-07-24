# Clarifications: Cockpit gates — read-only status query + stable sweep generation derivation

**Issue**: [generacy-ai/generacy#1038](https://github.com/generacy-ai/generacy/issues/1038)
**Spec**: [spec.md](./spec.md)

---

## Batch 1 — 2026-07-23

### Q1: Answer-set hash inputs
**Context**: FR-006 says `clarification` gates derive their `generation` from an "answer-set hash sourced from GitHub state" defined in agency's `auto.md:1356-1358`. But the parent design doc ([cockpit-remote-gates-plan.md:148](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md)) describes clarification `generation` as a "batch id". SC-002 requires 100% match between sweep-derived and live-derived `gateId`s, which means both paths must hash the identical bytes. What exactly is fed into the hash?
**Question**: What are the canonical, ordered inputs to the clarification-gate answer-set hash that `@generacy-ai/cockpit` should export?
**Options**:
- A: Sorted-by-question-number list of `{ questionNumber, questionText }` for every question in the current *unanswered* batch (question identity only; answers not included). "Same round of asks → same generation."
- B: Sorted-by-question-number list of `{ questionNumber, questionText, answerText | null }` for every question in the current batch (including nulls for pending). Answered questions changing the hash is desired, so each round of answers becomes a fresh generation.
- C: The literal comment body/timestamp of the most recent `<!-- generacy-stage:clarification -->` batch comment on the issue (single string in, hash out). Purely GitHub-durable, zero parsing.
- D: The `Batch N — <ISO date>` header string from `clarifications.md` (batch id in the classic sense). Simplest, but requires the file to be readable during a sweep.

**Answer**: A — Canonical hash input is the sorted-by-question-number list of `{ questionNumber, questionText }` for every question in the current unanswered batch (question identity only; drafted answers excluded). "Same round of asks → same generation."

---

### Q2: Cloud status → query response mapping
**Context**: The parent design doc lists seven cloud-side gate statuses (`open | answered | delivered | applied | superseded | failed | expired`), but FR-001 collapses the query response to three (`open | answered | absent`). The sweep uses this response to decide whether to re-draft. The mapping is load-bearing: reporting `delivered` (answer sent but not yet applied on cluster) as `open` would cause the sweep to re-draft; reporting it as `answered` would cause it to skip.
**Question**: How do the seven cloud statuses map onto the three query-response statuses?
**Options**:
- A: `open` = cloud-`open` only. `answered` = `answered | delivered | applied | superseded | failed | expired` (anything post-open). `absent` = no matching gate. Sweep re-drafts only when the cloud has literally no answer yet AND has not moved past open.
- B: `open` = `open | delivered` (delivered = answer in flight, still effectively pending from cluster's POV). `answered` = `answered | applied | superseded | failed | expired`. `absent` = no matching gate.
- C: `open` = `open`. `answered` = `answered | delivered | applied`. `absent` = no matching gate OR terminal-negative states (`superseded | failed | expired`) — sweep is free to re-draft terminal-negative because the gate is dead.
- D: Query returns the raw cloud status verbatim; the three-state contract in FR-001 is dropped. Sweep decides its own collapse.

**Answer**: C — `open` = cloud `open`; `answered` = `answered | delivered | applied`; `absent` = no matching gate OR terminal-negative (`superseded | failed | expired`), so the sweep is free to re-draft a dead gate.

---

### Q3: Query fail-mode when cloud/relay is unreachable
**Context**: The sweep runs at cluster startup, which is exactly the moment the relay may not yet be connected or the cloud may be transiently unreachable. FR-001 says the query is read-only against Firestore-of-record, but does not specify what the *caller* sees on a transport failure. The choice determines whether the sweep is fail-open (drafts everything → duplicate spam, the exact bug this issue fixes) or fail-closed (drafts nothing → operator may miss gates that legitimately need a re-open).
**Question**: When `cockpit_gate_status` cannot reach the cloud gate-storage layer, what does it return, and what is the sweep expected to do?
**Options**:
- A: **Tool errors** (throws an MCP error with a distinct error class, e.g. `class: 'query-unreachable'`). Sweep aborts with an operator-visible error; no drafting, no `--gates=ui` for this scope until connectivity is restored. Fail-loud + fail-closed.
- B: **Tool returns `status: 'absent'`**. Sweep proceeds to draft as if no gate exists. Preserves progress but re-introduces duplicate risk when the cloud comes back and the pre-existing gate is still there.
- C: **Tool returns a new fourth status `'unknown'`** (extending FR-001's contract). Sweep skips re-drafting AND does not treat as absent — the gate is left alone until the next sweep. Fail-open on drafting, fail-closed on duplicates.
- D: **Tool retries with bounded backoff** (e.g. 3 attempts / ~5s) then falls back to option A. Handles transient connection races at startup; still fails loud on sustained outages.

**Answer**: D — `cockpit_gate_status` retries with bounded backoff (~3 attempts / ~5s) to ride out the startup relay-not-connected race, then falls back to a distinct fail-loud/fail-closed `query-unreachable` MCP error on sustained outage (never returns `absent`).

---

### Q4: Cutover behavior for gates opened under `generation=1`
**Context**: Assumption 4 in the spec says gates already open under the old `generation=1` regime "will continue to work as-is; the new derivation applies to gates opened after the change lands. A cutover strategy for in-flight gates is out of scope (they will drain naturally)." But the sweep runs against pre-existing scopes: on the first sweep after the code lands, the new-derivation query will compute a different `gateId` than the one Firestore has for gates opened yesterday under `generation=1`. The query will return `absent`, so the sweep will draft-and-open — producing the exact duplicate this issue is trying to prevent, for one restart per scope.
**Question**: What is the cutover behavior for the first sweep against scopes that have pre-existing `generation=1` gates in Firestore?
**Options**:
- A: **Accept one-time duplication.** Document it as expected transient churn. Existing `generation=1` gates drain on operator answer; new gates use the durable derivation. No code path handles the overlap.
- B: **Sweep queries by `(issueRef, gateType)` prefix, not full `gateId`.** If any gate for that `(issueRef, gateType)` is currently `open` in Firestore, the sweep skips drafting regardless of generation match. Requires FR-002's `cockpit_gate_list` to be the primary sweep primitive and FR-001 to be secondary.
- C: **Compatibility shim in `@generacy-ai/cockpit`**: `deriveGateId` returns *both* the new-derivation ID and the legacy `generation=1` ID; the query layer checks both. Adds a small permanent overhead to preserve zero-duplicate guarantee across cutover.
- D: **Migration step**: a one-time cloud-side task rewrites `generation=1` gates to their new-derivation `gateId` before this code lands. Cutover is atomic; no cluster-side compat logic needed. Coordination cost lives in generacy-cloud.

**Answer**: B — The sweep queries by `(issueRef, gateType)` prefix (not full `gateId`); if any gate for that pair is currently `open`, skip drafting regardless of generation match. This makes `cockpit_gate_list` the primary sweep primitive and kills the gen=1 cutover duplicate without permanent legacy-ID overhead or a cloud migration.

---

### Q5: `cockpit_gate_list` return semantics
**Context**: FR-002 says `cockpit_gate_list` returns "open gates for a given `issueRef` (optionally filtered by `gateType`)". Two ambiguities affect the sweep's caller code: (a) does the returned list include gates in *any* status (so caller filters) or only cloud-status-`open` gates? (b) is the list scoped to gates opened by the calling cluster/session, or any cluster in the project? A sweep after a serial cluster takeover needs to see gates opened by the predecessor cluster; a per-cluster list would miss them.
**Question**: What is the exact return set of `cockpit_gate_list` for a given `issueRef`?
**Options**:
- A: **All non-terminal gates, project-wide.** Returns `open | answered | delivered` from *any* cluster in the project (predecessor takeover-safe). Terminal statuses (`applied | superseded | failed | expired`) excluded — they're history. Caller filters further as needed.
- B: **Only cloud-status-`open` gates, project-wide.** Anything past `open` (including `delivered` / `answered`) is excluded — those are the sweep's "don't touch" cases and don't need to be in the list. Same project-wide scope as A.
- C: **Only gates opened by the calling cluster/session.** Predecessor-cluster gates are invisible; use `cockpit_gate_status` per-`(issueRef, gateType, generation)` for takeover discovery. Simpler contract but forces N per-issue queries after takeover.
- D: **Configurable via input flags.** Accepts `{ statuses?: GateStatus[]; scope?: 'session' | 'cluster' | 'project' }` and callers pick. Broadest surface; largest schema.

**Answer**: A — `cockpit_gate_list` returns all non-terminal gates (`open | answered | delivered`) project-wide (from any cluster in the project, so a serial-cluster takeover sees the predecessor's gates); terminal statuses (`applied | superseded | failed | expired`) are excluded as history. Caller filters further as needed.
