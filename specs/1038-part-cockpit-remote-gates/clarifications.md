# Clarifications

**Issue**: [#1038](https://github.com/generacy-ai/generacy/issues/1038)

## Batch 1 — 2026-07-23

### Q1: Answer-set hash inputs
**Context**: FR-007 says `clarification` gates derive their `generation` from a hash of the open-clarification set on the issue. The parent design doc ([cockpit-remote-gates-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md)) describes clarification `generation` as a "batch id". SC-002 requires 100% match between sweep-derived and live-derived `gateId`s, which means both paths must hash the identical bytes.

**Question**: What are the canonical, ordered inputs to the clarification-gate answer-set hash that `@generacy-ai/cockpit` should export?

**Options**:
- **A**: Sorted-by-question-number list of `{ questionNumber, questionText }` for every question in the current *unanswered* batch (question identity only; answers not included). "Same round of asks → same generation."
- **B**: Sorted-by-question-number list of `{ questionNumber, questionText, answerText | null }` for every question in the current batch (including nulls for pending). Answered questions changing the hash is desired, so each round of answers becomes a fresh generation.
- **C**: The literal comment body/timestamp of the most recent `<!-- generacy-stage:clarification -->` batch comment on the issue.
- **D**: The `Batch N — <ISO date>` header string from `clarifications.md`.

**Answer**: A — Canonical hash input is the sorted-by-question-number list of `{ questionNumber, questionText }` for every question in the current unanswered batch (question identity only; drafted answers excluded). "Same round of asks → same generation."

---

### Q2: Cloud status → query response mapping
**Context**: The parent design doc lists seven cloud-side gate statuses (`open | answered | delivered | applied | superseded | failed | expired`), but FR-001 collapses the query response to three (`open | answered | absent`). The sweep uses this response to decide whether to re-draft. The mapping is load-bearing: reporting `delivered` (answer sent but not yet applied on cluster) as `open` would cause the sweep to re-draft; reporting it as `answered` would cause it to skip.

**Question**: How do the seven cloud statuses map onto the three query-response statuses?

**Options**:
- **A**: `open` = cloud-`open` only. `answered` = `answered | delivered | applied | superseded | failed | expired`. `absent` = no matching gate.
- **B**: `open` = `open | delivered`. `answered` = `answered | applied | superseded | failed | expired`. `absent` = no matching gate.
- **C**: `open` = `open`. `answered` = `answered | delivered | applied`. `absent` = no matching gate OR terminal-negative states (`superseded | failed | expired`) — sweep is free to re-draft terminal-negative because the gate is dead.
- **D**: Query returns the raw cloud status verbatim; the three-state contract in FR-001 is dropped.

**Answer**: C — `open` = cloud `open`; `answered` = `answered | delivered | applied`; `absent` = no matching gate OR terminal-negative (`superseded | failed | expired`), so the sweep is free to re-draft a dead gate.

---

### Q3: Query fail-mode when cloud/relay is unreachable
**Context**: The sweep runs at cluster startup, which is exactly the moment the relay may not yet be connected or the cloud may be transiently unreachable. FR-001 says the query is read-only against Firestore-of-record, but does not specify what the *caller* sees on a transport failure. The choice determines whether the sweep is fail-open (drafts everything → duplicate spam) or fail-closed (drafts nothing → operator may miss gates that legitimately need a re-open).

**Question**: When `cockpit_gate_status` cannot reach the cloud gate-storage layer, what does it return, and what is the sweep expected to do?

**Options**:
- **A**: Tool errors (throws an MCP error with a distinct error class, e.g. `class: 'query-unreachable'`). Sweep aborts. Fail-loud + fail-closed.
- **B**: Tool returns `status: 'absent'`. Sweep proceeds to draft as if no gate exists.
- **C**: Tool returns a new fourth status `'unknown'`. Sweep skips re-drafting AND does not treat as absent.
- **D**: Tool retries with bounded backoff (e.g. 3 attempts / ~5s) then falls back to option A. Handles transient connection races at startup; still fails loud on sustained outages.

**Answer**: D — `cockpit_gate_status` retries with bounded backoff (~3 attempts / ~5s) to ride out the startup relay-not-connected race, then falls back to a distinct fail-loud/fail-closed `query-unreachable` MCP error on sustained outage (never returns `absent`).

---

### Q4: Cutover behavior for gates opened under `generation=1`
**Context**: On the first sweep after the code lands, the new-derivation query will compute a different `gateId` than the one Firestore has for gates opened yesterday under `generation=1`. The query will return `absent`, so the sweep will draft-and-open — producing the exact duplicate this issue is trying to prevent, for one restart per scope.

**Question**: What is the cutover behavior for the first sweep against scopes that have pre-existing `generation=1` gates in Firestore?

**Options**:
- **A**: Accept one-time duplication. Document as expected transient churn.
- **B**: Sweep queries by `(issueRef, gateType)` prefix, not full `gateId`. If any gate for that pair is currently `open`, skip drafting regardless of generation match. Requires `cockpit_gate_list` to be the primary sweep primitive and FR-001 to be secondary.
- **C**: Compatibility shim in `@generacy-ai/cockpit`: `deriveGateId` returns *both* the new-derivation ID and the legacy `generation=1` ID; the query layer checks both.
- **D**: Migration step: a one-time cloud-side task rewrites `generation=1` gates to their new-derivation `gateId` before this code lands.

**Answer**: B — The sweep queries by `(issueRef, gateType)` prefix (not full `gateId`); if any gate for that pair is currently `open`, skip drafting regardless of generation match. This makes `cockpit_gate_list` the primary sweep primitive and kills the gen=1 cutover duplicate without permanent legacy-ID overhead or a cloud migration.

---

### Q5: `cockpit_gate_list` return semantics
**Context**: FR-004 says `cockpit_gate_list` returns "all non-`absent` gates for a given `issueRef`". Two ambiguities affect the sweep's caller code: (a) does the returned list include gates in *any* status (so caller filters) or only cloud-status-`open` gates? (b) is the list scoped to gates opened by the calling cluster/session, or any cluster in the project? A sweep after a serial cluster takeover needs to see gates opened by the predecessor cluster; a per-cluster list would miss them.

**Question**: What is the exact return set of `cockpit_gate_list` for a given `issueRef`?

**Options**:
- **A**: All non-terminal gates, project-wide. Returns `open | answered | delivered` from *any* cluster in the project (predecessor takeover-safe). Terminal statuses excluded.
- **B**: Only cloud-status-`open` gates, project-wide.
- **C**: Only gates opened by the calling cluster/session.
- **D**: Configurable via input flags (`statuses`, `scope`).

**Answer**: A — `cockpit_gate_list` returns all non-terminal gates (`open | answered | delivered`) project-wide (from any cluster in the project, so a serial-cluster takeover sees the predecessor's gates); terminal statuses (`applied | superseded | failed | expired`) are excluded as history. Caller filters further as needed.
