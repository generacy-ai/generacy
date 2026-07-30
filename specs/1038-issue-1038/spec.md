# Feature Specification: Cockpit gates — read-only status query + stable sweep generation derivation

**Branch**: `1038-issue-1038` | **Date**: 2026-07-23 | **Status**: Draft
**Issue**: [generacy-ai/generacy#1038](https://github.com/generacy-ai/generacy/issues/1038)
**Epic**: Cockpit Remote Gates (generacy-ai/generacy-cloud#850)
**Design**: [docs/cockpit-remote-gates-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md)

## Summary

The `--gates=ui` startup sweep re-drafts and re-opens gates that are **already pending** because two things are missing:

1. There is no cheap way to ask *"is a gate already open for this issue + type?"* **before** doing the drafting work.
2. Sweep-derived `gateId`s do not match live-derived ones, so cloud-side upsert cannot coalesce them even after they arrive.

This spec adds the missing read-only gate-status query (MCP tool + orchestrator route) **and** stabilises the `generation` discriminator so a gate re-derived during a sweep produces the same `gateId` as when it was originally opened. Together, these unblock the agency-side sweep fix tracked in generacy-ai/agency#450.

## Clarifications

See [clarifications.md](./clarifications.md) for the full Q&A. Load-bearing decisions from Batch 1 (2026-07-23):

- **Q1 → A** — Clarification-gate answer-set hash inputs are the sorted-by-question-number list of `{ questionNumber, questionText }` for every question in the current *unanswered* batch (question identity only; drafted/pending answers excluded). "Same round of asks → same generation." (feeds FR-006)
- **Q2 → C** — Cloud-status → query-response mapping: `open` = cloud `open` only; `answered` = `answered | delivered | applied`; `absent` = no matching gate **OR** terminal-negative (`superseded | failed | expired`). Sweep is free to re-draft an `absent` result because a dead gate is not a live gate. (feeds FR-001 and FR-013)
- **Q3 → D** — Transport-failure behaviour: `cockpit_gate_status` retries with bounded backoff (~3 attempts / ~5s total) to ride out the startup relay-not-connected race, then throws a distinct fail-loud/fail-closed MCP error with `class: 'query-unreachable'`. Never returns `absent` on transport failure. (feeds new FR-014)
- **Q4 → B** — Gen=1 cutover: sweep queries by `(issueRef, gateType)` prefix (not full `gateId`). If any gate for that pair is currently `open`, skip drafting regardless of generation match. `cockpit_gate_list` is the primary sweep primitive; `cockpit_gate_status` is secondary. Kills the gen=1 cutover duplicate without permanent legacy-ID overhead or a cloud migration. (revises Assumption 4, promotes FR-002)
- **Q5 → A** — `cockpit_gate_list` returns all non-terminal gates (`open | answered | delivered`) project-wide (from *any* cluster in the project, so a serial-cluster takeover sees the predecessor's gates). Terminal statuses (`applied | superseded | failed | expired`) are excluded as history. Caller filters further as needed. (feeds FR-002)

## User Stories

### US1: Sweep skips already-open gates without re-drafting (Primary)

**As** an operator restarting a `/cockpit:auto` session (or a takeover session picking up an in-flight scope),
**I want** the startup sweep to detect gates that are already open in the cloud **before** re-drafting them,
**So that** the operator's inbox is not spammed with duplicate rows, upstream drafting subagents are not re-invoked wastefully, and gate identity is preserved across restarts.

**Acceptance Criteria**:

- [ ] A read-only gate-status query returns `{ gateId, status: open | answered | absent }` for a `(issueRef, gateType, generation)` identity **without** requiring the drafted `title`/`body`/`options`.
- [ ] Sweep code paths can call the query before invoking any drafting subagent.
- [ ] For an already-`open` gate, the sweep short-circuits and emits no drafting work.
- [ ] For an `answered` gate, the sweep skips re-open (natural gates progress on their own signal).
- [ ] For an `absent` gate, the sweep proceeds to draft + open as today.

### US2: Sweep-derived and live-derived gateIds coalesce

**As** cloud gate-storage upsert logic,
**I want** the same natural gate to hash to the same `gateId` whether it was opened live during the session or re-derived by a startup sweep,
**So that** duplicate rows do not appear in the operator inbox even if a race lets both paths emit.

**Acceptance Criteria**:

- [ ] `generation` for each of the covered gate types is derived from **durable GitHub state**, not a session-local counter or hardcoded `1`.
- [ ] For `clarification` gates: sweep-derived `gateId` equals live-derived `gateId` for the same open clarification round.
- [ ] For `implementation-review` gates: sweep-derived `gateId` equals live-derived `gateId` for the same pending review (same head SHA).
- [ ] The `generation` derivation is deterministic and pure — same GitHub state in, same string out.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add MCP tool `cockpit_gate_status` returning `{ gateId, status: open \| answered \| absent }` for a `(issueRef, gateType, generation)` identity. Cloud-status → response mapping (per clarifications Q2 → C): `open` = cloud `open`; `answered` = `answered \| delivered \| applied`; `absent` = no matching gate **OR** terminal-negative (`superseded \| failed \| expired`). | P1 | Input MUST NOT require `title`/`body`/`options`. |
| FR-002 | Add MCP tool `cockpit_gate_list` returning all non-terminal gates for a given `issueRef` (optionally filtered by `gateType`). Per clarifications Q5 → A: returns gates in `open \| answered \| delivered` status, **project-wide** (any cluster in the project — serial-cluster takeover safe). Terminal statuses (`applied \| superseded \| failed \| expired`) are excluded as history. Per clarifications Q4 → B: this is the **primary sweep primitive**; the sweep uses it to skip drafting whenever any gate for `(issueRef, gateType)` is currently open, regardless of generation match. | P1 | Return list of `{ gateId, gateType, generation, status }`. |
| FR-003 | Add orchestrator route `GET /cockpit/gates` accepting `issueRef` + optional `gateType` (or `gateId` prefix) — the transport backing FR-001/FR-002. | P1 | Fires over the same relay path answers already ride, OR cloud exposes directly — decide in plan. |
| FR-004 | Cloud (Firestore) is the source of truth for gate status. Query is read-only; no gate mutation as a side effect. | P1 | Preserves single-writer semantics. |
| FR-005 | Reconcile `deriveGateKey` / `deriveGateId` so the same natural gate produces the same `gateId` regardless of whether it was opened live or re-derived by the sweep. | P1 | Owned by this repo (`packages/cockpit/src/gates/`). |
| FR-006 | Compute durable `generation` discriminator for `clarification` gates from an answer-set hash sourced from GitHub state (not session memory). Per clarifications Q1 → A: hash input is the sorted-by-question-number list of `{ questionNumber, questionText }` for every question in the current *unanswered* batch — question identity only, answers/pending markers excluded. "Same round of asks → same generation." | P1 | Answer-set hash defined in `auto.md:1356-1358` — extract into `@generacy-ai/cockpit`. |
| FR-007 | Compute durable `generation` discriminator for `implementation-review` gates from the PR head SHA. | P1 | Head SHA is durable; a new SHA is a legitimately new gate. |
| FR-008 | Compute durable `generation` discriminators for `artifact-review` (head SHA of the artifact commit), `manual-validation` (head SHA of what is being validated), and `escalation` (occurrence counter derived from durable GitHub state — e.g., issue-comment count of a filter). | P2 | Called out as DATA GAPS in the issue (`auto.md:1367`). Implement if reachable in scope; otherwise file follow-ups. |
| FR-009 | The `generation` derivation logic is pure and exported from `@generacy-ai/cockpit` so both the sweep (agency) and the live path (this repo) call the same code. | P1 | Single source of truth prevents future skew. |
| FR-010 | Update wire-contract docs under `specs/1020-part-cockpit-remote-gates/contracts/` to reflect the new query shapes and generation rules. | P1 | JSON Schema mirror for generacy-cloud consumers. |
| FR-011 | Add a `.changeset/*.md` file describing the change and the affected packages. | P1 | CI gate; `@generacy-ai/cockpit` almost certainly bumps `minor` for the new public helpers. |
| FR-012 | The `cockpit_gate_status` / `cockpit_gate_list` tools MUST NOT open, ack, retain, or otherwise mutate a gate. | P1 | Observer independence (mirrors #1015 SC-005 pattern). |
| FR-013 | Refusal / not-found path: an `absent` gate returns `status: 'absent'` and a null `gateId`, NOT an error. Callers must be able to distinguish "no gate here" (FR-013 `absent`) from "query failed" (FR-014 `query-unreachable` error). | P2 | Preserves the sweep's fail-open-on-drafting-for-absent contract while keeping transport failures fail-closed. |
| FR-014 | Transport-failure behaviour for `cockpit_gate_status` / `cockpit_gate_list`: per clarifications Q3 → D, retry with bounded backoff (~3 attempts / ~5s total) to absorb the startup relay-not-connected race, then throw a distinct fail-loud/fail-closed MCP error with `class: 'query-unreachable'`. MUST NOT collapse to `status: 'absent'` on sustained outage — that would re-introduce the exact duplicate-drafting bug this spec fixes. | P1 | Sweep aborts on `query-unreachable`; operator sees a visible error; no `--gates=ui` for that scope until connectivity is restored. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Startup sweep for a scope with N already-open clarification gates issues **zero** drafting-subagent invocations for those N gates. | 0 drafting calls | Integration test with a fixture cloud + sweep; assert drafting subagent mock is never invoked. |
| SC-002 | For `clarification` and `implementation-review` gates, sweep-derived `gateId` equals live-derived `gateId`. | 100% match across contract fixtures | Contract test comparing `deriveGateId(liveInputs)` vs `deriveGateId(sweepInputs)` for the same natural gate. |
| SC-003 | `cockpit_gate_status` returns correct status (open / answered / absent) for a matrix of fixture gates. | ≥ 95% correctness across ≥ 12 fixtures (4 per gate type × 3 states) | Contract test against the fake-peer harness (#1024). |
| SC-004 | The `cockpit_gate_status` query is cheaper than `cockpit_gate_open` — no drafting subagent invocation is required to answer it. | Zero calls into any drafting subagent | Code inspection + integration test with drafting subagent stubbed to throw. |
| SC-005 | Observer independence: an import-scan regression test proves `cockpit_gate_status` and `cockpit_gate_list` do not import gate-mutation code paths. | 0 forbidden imports | Static scan test mirroring #1015's `observer-independence.test.ts` pattern. |
| SC-006 | Wire-contract docs, JSON Schema mirror, and changeset are added. | 3/3 present | Manual PR review checklist. |
| SC-007 | Transport-failure fail-mode: on sustained cloud/relay outage after bounded retry (~3 attempts / ~5s), `cockpit_gate_status` / `cockpit_gate_list` throw an MCP error with `class: 'query-unreachable'` — never returning `status: 'absent'`. | 0 `absent` returns on injected sustained transport failure | Contract test that stubs the cloud query to fail persistently and asserts the tool throws with the correct error class after the retry budget. |

## Assumptions

1. **Cloud query surface exists or will land in a companion generacy-cloud PR.** Whether the orchestrator proxies over the relay or cloud exposes a direct HTTP endpoint is a plan-phase decision (per the issue text). This spec assumes a query surface will be available; wire shape is TBD in `/plan`.
2. **Firestore is the source of truth for gate status.** Any local caches in the orchestrator or MCP server are advisory; the query must consult cloud state for `open | answered | absent`.
3. **The sweep's `generation=1` default is fixed on the agency side** (per issue text — `packages/claude-plugin-cockpit/commands/auto.md:198`). This repo owns the `generation` derivation rules; the agency repo owns calling them.
4. **Backward compatibility for existing open gates.** Gates already open under the old `generation=1` regime will continue to work as-is; the new derivation applies to gates opened after the change lands. Per clarifications Q4 → B, the sweep does **not** try to match the legacy `gateId` — instead it queries by `(issueRef, gateType)` prefix via `cockpit_gate_list` (FR-002) and skips drafting whenever any gate for that pair is currently non-terminal, regardless of generation match. This kills the gen=1 cutover duplicate without permanent legacy-ID overhead in `deriveGateId` and without a cloud-side migration.
5. **`gateId` shape is preserved** — `sha256(<issueRef>:<gateType>:<generation>)[:24]` (per `packages/cockpit/src/gates/schemas.ts:67-77`). Only the `generation` input changes; the hashing shape does not.
6. **Existing MCP tools are untouched.** `cockpit_gate_open` and `cockpit_gate_ack` retain their current signatures and semantics. This is a **strict addition** of a read-only query, not a replacement of the write path.
7. **The startup sweep is the primary caller.** Other callers (e.g., interactive operator gates) may reuse the query but their workflows are not in scope for this spec.

## Out of Scope

- **Fixing the agency-side sweep** (removing `generation=1` and wiring in the new query) — tracked in generacy-ai/agency#450.
- **Cloud-side Firestore query implementation** — if the answer is "cloud exposes it directly," that lands in generacy-cloud; if it's "orchestrator proxies over the relay," this repo owns the proxy but not the Firestore reader.
- **Idempotency of `cockpit_gate_open` itself.** The write path remains "not idempotent" per its current contract; idempotency is achieved by *callers* querying first, not by making the write idempotent.
- **`phase-queue`, `filing`, and `scope-drained` `gateType`s.** The issue explicitly names `clarification` and `implementation-review` as the SC targets; the other five types get generation derivations only if in-scope, otherwise follow-up issues.
- **UI / operator-inbox rendering.** How the cloud-side inbox displays gate status is generacy-cloud's concern.
- **Retention/replay of the query response.** Query is a synchronous read; no retention semantics.
- **Cross-repo answer-set hash migration.** The answer-set hash formula is defined in the agency's `auto.md`; this spec extracts it into a shared library but does not change the formula.

## Dependencies

- **Blocked by**: none in this repo. Cloud-side Firestore query surface may be a soft blocker depending on the plan-phase transport decision.
- **Blocks**: generacy-ai/agency#450 (sweep fix consumes both the new query and the stable generation derivation).
- **Related**: Cockpit Remote Gates epic P1 siblings — #1020 (wire contracts, source of `deriveGateId`), #1021 (orchestrator routes + `cluster.cockpit` channel), #1022 (existing MCP `cockpit_gate_open` / `cockpit_gate_ack`), #1024 (integration harness — will need new scenarios for the query).

---

*Generated by speckit — enhanced from issue #1038.*
