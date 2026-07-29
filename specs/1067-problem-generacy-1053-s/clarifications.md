# Clarifications: `runId` on gate-query MCP tools (Phase B of #1053 fix)

**Issue**: [#1067](https://github.com/generacy-ai/generacy/issues/1067)
**Branch**: `1067-problem-generacy-1053-s`

## Batch 1 — 2026-07-29

### Q1: List-mode `runId` filter semantics
**Context**: `cockpit_gate_list`'s stated role (its own docstring at `tools/cockpit_gate_list.ts:4-8`, quoting the #1038 Q4→B decision) is to be the sweep's *primary* dedup primitive: it returns non-terminal gates for `(issueRef, gateType)` "regardless of generation match". FR-002 widens its input to accept `runId`, and FR-003 forwards it as a query-string parameter. But the spec does not say what the cloud does with it. Two shapes are possible and they produce different sweep behaviours:
- **Filter**: cloud returns only gates whose stored `runId` equals the one supplied → sweep sees no cross-run gates, so a rerun with `runId=B` finds no gate from `runId=A`'s prior run (US3-friendly, but re-introduces the "generation regardless" superset behaviour cost).
- **Advisory**: cloud ignores the query param on the list path and continues to return all non-terminal gates for `(issueRef, gateType)` → passing `runId` on list has no observable effect (the sweep still sees stale gates from prior runs).

**Question**: When `cockpit_gate_list` is called with `runId=X`, should the cloud return only gates whose stored `runId=X`, or should `runId` be ignored on the list path and returned as advisory-only?
**Options**:
- A: **Filter** — cloud narrows list results to gates with matching `runId` (aligns list with status; ensures rerun sees a clean inbox).
- B: **Advisory** — cloud ignores `runId` on list; sweep's "regardless of generation" superset behaviour is preserved verbatim (no cloud-side filter added; effectively a no-op forward for list).
- C: **Do not forward on list** — narrow FR-003 to `getGateStatus` only; `cockpit_gate_list` widens its MCP schema (for surface parity) but the tool handler does not pass `runId` to the client.

**Answer**: *Pending*

### Q2: Query-string parameter name on the cloud URL
**Context**: FR-003 says `runId` is forwarded "as a URL query-string parameter." The current parameters on `GET /api/clusters/:id/cockpit/gates` are `issueRef`, `gateType`, `generation` (camelCase, per `cloud-gate-query-client.ts:342-350`). The Phase A cloud change accepts the new parameter; the two sides must agree on the exact spelling.

**Question**: What is the exact query-string key name for the new field on the cloud URL?
**Options**:
- A: `runId` (camelCase, matches existing sibling params).
- B: `run_id` (snake_case, common REST convention).
- C: Other (specify).

**Answer**: *Pending*

### Q3: Log-line placement and fields for read-side `runIdSource`
**Context**: FR-008 requires a structured log at the tool boundary observing the `runId` source (`explicit` | `unset`), "mirroring `cockpit_gate_open`'s existing `runIdSource` log field." The write side logs `{ event, runIdSource, gateId, gateType, issueRef }` *after deriving `gateId`* (`cockpit_gate_open.ts:88-97`). On the read side, `gateId` is not derived locally — it comes back in the cloud response. Two shapes and two placements are possible:
- **Placement A**: Log *before* the cloud call, with fields `{ event, runIdSource, mode, gateType, issueRef }` and no `gateId`.
- **Placement B**: Log *after* the cloud call, with fields `{ event, runIdSource, mode, gateType, issueRef, resolvedStatus, gateId? }` (adds observability of what the runId actually matched).
- **Skip for list**: `cockpit_gate_list` has no natural `gateType` if the caller omits it, and could produce multiple `gateId`s in the response. Emitting one log line per response, or one per matched entry, both feel wrong.

**Question**: Which placement + field shape should the two new read-side `runIdSource` log lines use, and does `cockpit_gate_list` emit this log at all?
**Options**:
- A: Pre-call, minimal fields `{ event, runIdSource, mode: 'status'|'list', gateType?, issueRef }`; both tools log it.
- B: Post-call, richer fields including `resolvedStatus` and (if singular) `gateId`; both tools log it.
- C: Only `cockpit_gate_status` logs (write-side symmetry — one gate per call); `cockpit_gate_list` does not log this field (list is bulk).

**Answer**: *Pending*

### Q4: FR-006 regression test scope — include `cockpit_gate_list`?
**Context**: FR-006 pins that `cockpit_gate_open` and `cockpit_gate_status` derive the same `gateKey`/`gateId` from matching inputs. `cockpit_gate_list` also returns `gateId` values (in its `entries[]`), and if list-mode grows a `runId` filter (Q1 = A) the identity boundary broadens to three tools, not two. If list-mode is advisory-only (Q1 = B/C), list has no identity contract to pin.

**Question**: Should FR-006's parity regression also cover `cockpit_gate_list` (i.e., pin that a `list` entry's `gateId` matches what `cockpit_gate_open` would derive for the same tuple)?
**Options**:
- A: Yes — extend the matrix to three tools; the test asserts open-vs-status-vs-list-entry identity for both the 3-tuple and 4-tuple cases.
- B: No — scope FR-006 to `cockpit_gate_open` vs `cockpit_gate_status` only, exactly as written; `cockpit_gate_list` gets its own separate assertion (or none) depending on Q1's answer.

**Answer**: *Pending*

### Q5: How is FR-005 byte-identical URL verified?
**Context**: FR-005 requires that with `runId === undefined`, "every derived key, id, and outbound URL is byte-identical to the pre-change behaviour (verified by fixture comparison against pre-change snapshots)." The verification methodology has two shapes with different maintenance costs:
- **Snapshot fixture**: Check in a literal string like `https://api.generacy.ai/api/clusters/<id>/cockpit/gates?issueRef=...&gateType=...&generation=...` and assert equality; new fixtures require a manual update whenever any URL structure changes.
- **Structural assertion**: Assert that the URL has exactly the expected keys (`issueRef`, `gateType`, `generation` — no `runId`) and that `runId` is absent from the query string; the exact URL string is not pinned.

**Question**: Which verification methodology satisfies FR-005?
**Options**:
- A: **Snapshot fixture** — a checked-in canonical URL string (matches "byte-identical" language literally).
- B: **Structural assertion** — assert the query-string key set and absence of `runId`; the exact string is not pinned.
- C: Both — snapshot for the canonical case + structural assertion for the general case.

**Answer**: *Pending*
