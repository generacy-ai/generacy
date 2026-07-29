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

**Answer**: **C — do not forward `runId` on list; widen the MCP schema for surface parity only.**

Constrained by what generacy-cloud#892 (Phase A) actually deployed: the route (`services/api/src/routes/clusters/cockpit-gates.ts`) selects mode on `generation` (`generation` present → status mode; absent → list mode) and carries `.refine((q) => q.runId === undefined || q.generation !== undefined, { message: 'runId requires generation' })`. List mode has no `generation` by construction, so **every list request that carries `runId` gets a 400 RFC-7807, not a silent ignore** — Option B describes behaviour that does not exist. Breaking `cockpit_gate_list` (the sweep's primary dedup primitive per `tools/cockpit_gate_list.ts:4-8`) would fail the pre-draft dedup invariant at `auto.md:283`, causing the drafting subagent to re-run every wake and accumulate duplicate inbox gates — the exact failure mode #1059 exists to prevent. Option A (cloud-side filter) is not available in Phase B: it requires a cloud change and would re-invert the A→B→C dependency ordering. C is the only option compatible with the deployed contract.

**Implementation note**: leave a code comment at the drop site in the `cockpit_gate_list` handler stating the drop is deliberate and naming the cloud refine that requires it — otherwise the next reader sees an accepted-and-discarded schema field and "fixes" it by forwarding, which 400s the dedup sweep. The operator use case of "show me this run's gates" is real but is cloud-side work; file it as a follow-up generacy-cloud issue, not here.

### Q2: Query-string parameter name on the cloud URL
**Context**: FR-003 says `runId` is forwarded "as a URL query-string parameter." The current parameters on `GET /api/clusters/:id/cockpit/gates` are `issueRef`, `gateType`, `generation` (camelCase, per `cloud-gate-query-client.ts:342-350`). The Phase A cloud change accepts the new parameter; the two sides must agree on the exact spelling.

**Question**: What is the exact query-string key name for the new field on the cloud URL?
**Options**:
- A: `runId` (camelCase, matches existing sibling params).
- B: `run_id` (snake_case, common REST convention).
- C: Other (specify).

**Answer**: **A — `runId`, camelCase.**

Not a style preference; the deployed contract fixes it. Phase A's schema declares `runId: z.string().min(1).optional()` and the handler reads `c.req.query('runId')`. Option B (`run_id`) would not 400 — the cloud would silently never read it, derive a 3-segment `gateKey`, and return `{ gateId: null, status: null }` for a gate that exists. A silent `absent` for a live gate is the precise symptom #1059's landmine table describes: the caller believes it asked a run-scoped question and gets a confident wrong answer.

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

**Answer**: **C on the "which tools" axis, combined with post-call placement and B's field set.**

Disambiguating the two conflated dimensions: **which tools** → `cockpit_gate_status` only; **placement** → post-call; **fields** → `{ event, runIdSource, mode: 'status', gateType, issueRef, resolvedStatus, gateId }`.

*Which tools:* consequent on Q1=C. Since `cockpit_gate_list` never forwards `runId`, emitting `runIdSource` there would announce a provenance for a value that had no effect on the request — a log line asserting something untrue. Do not add.

*Placement and fields:* pre-call minimal (A) records what we *intended* to send; the operator's actual question is *did my `runId` reach the right doc*, which needs the outcome. So take B's richer field set and emit it after the call.

**Additional requirement**: **emit on the failure path too**, with the error surfaced. Post-call logging that only fires on success is invisible in exactly the case you want it — a `runId` that produced a 400 or a transport error is the interesting one, and a success-only line makes that indistinguishable from a cycle where the tool was never invoked.

### Q4: FR-006 regression test scope — include `cockpit_gate_list`?
**Context**: FR-006 pins that `cockpit_gate_open` and `cockpit_gate_status` derive the same `gateKey`/`gateId` from matching inputs. `cockpit_gate_list` also returns `gateId` values (in its `entries[]`), and if list-mode grows a `runId` filter (Q1 = A) the identity boundary broadens to three tools, not two. If list-mode is advisory-only (Q1 = B/C), list has no identity contract to pin.

**Question**: Should FR-006's parity regression also cover `cockpit_gate_list` (i.e., pin that a `list` entry's `gateId` matches what `cockpit_gate_open` would derive for the same tuple)?
**Options**:
- A: Yes — extend the matrix to three tools; the test asserts open-vs-status-vs-list-entry identity for both the 3-tuple and 4-tuple cases.
- B: No — scope FR-006 to `cockpit_gate_open` vs `cockpit_gate_status` only, exactly as written; `cockpit_gate_list` gets its own separate assertion (or none) depending on Q1's answer.

**Answer**: **A — extend FR-006 to all three tools.**

Even under Q1=C, where list does not *accept* `runId`, list still *returns* `gateId`s, and those are derived cloud-side from stored 4-segment `gateKey`s. So open-vs-list-entry identity is both meaningful and cheap to assert.

It is also the assertion closest to the user-visible symptom. #1053's acceptance criterion — *"Re-running an epic/phase whose previous gate reached `applied` opens a NEW gate visible in the inbox"* — is about the **inbox**, and the inbox is list. A matrix that pins open-vs-status only would let a regression through where the gate is created correctly and status resolves correctly but the inbox row carries a stale `gateId` — which is #1053 reappearing at the one surface an operator actually looks at.

Cover both the 3-tuple (`runId` undefined) and 4-tuple cases, so the matrix simultaneously proves FR-005's no-change guarantee and the new behaviour.

### Q5: How is FR-005 byte-identical URL verified?
**Context**: FR-005 requires that with `runId === undefined`, "every derived key, id, and outbound URL is byte-identical to the pre-change behaviour (verified by fixture comparison against pre-change snapshots)." The verification methodology has two shapes with different maintenance costs:
- **Snapshot fixture**: Check in a literal string like `https://api.generacy.ai/api/clusters/<id>/cockpit/gates?issueRef=...&gateType=...&generation=...` and assert equality; new fixtures require a manual update whenever any URL structure changes.
- **Structural assertion**: Assert that the URL has exactly the expected keys (`issueRef`, `gateType`, `generation` — no `runId`) and that `runId` is absent from the query string; the exact URL string is not pinned.

**Question**: Which verification methodology satisfies FR-005?
**Options**:
- A: **Snapshot fixture** — a checked-in canonical URL string (matches "byte-identical" language literally).
- B: **Structural assertion** — assert the query-string key set and absence of `runId`; the exact string is not pinned.
- C: Both — snapshot for the canonical case + structural assertion for the general case.

**Answer**: **C — snapshot for the canonical case, structural assertion for the general case.**

The two catch different classes of drift and the marginal cost is a few lines.

**Why B alone is insufficient — concrete case.** `issueRef` is `owner/repo#N`, and the `#` must be percent-encoded (`%23`) or the fragment is stripped and the cloud receives a malformed ref. A structural assertion over the query-string key set passes unchanged if a refactor swaps `URLSearchParams` for manual concatenation and loses that encoding — the failure then surfaces as a cloud-side 400 or a mysterious `absent`, far from the change that caused it. A checked-in canonical URL string catches it in the same commit. Parameter *order* drift is the same shape: semantically irrelevant, but FR-005 says byte-identical, and only a snapshot tests that claim as written.

**Why A alone is insufficient.** A bare snapshot diff is an opaque failure — a wall of URL against a wall of URL, with the reader left to spot the delta. The structural assertion is what makes the failure *legible* (`"runId present when it should be absent"`), and it is the one that keeps passing when a legitimately additive parameter is introduced later, so it will not have to be regenerated on every future change the way a snapshot will.

Pin the snapshot for the `runId === undefined` canonical case specifically — that is the one FR-005 is about — and let the structural assertion cover the rest.
