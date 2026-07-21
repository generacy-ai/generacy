# Feature Specification: Cockpit gate wire-contract schemas + gateId/generation derivation

**Branch**: `1020-part-cockpit-remote-gates` | **Date**: 2026-07-21 | **Status**: Draft
**Tracking issue**: [generacy-ai/generacy#1020](https://github.com/generacy-ai/generacy/issues/1020)
**Parent epic**: Cockpit Remote Gates (generacy-ai/generacy-cloud)
**Reference design**: [cockpit-remote-gates-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md) §Wire contracts

## Summary

First implementation issue of the **Cockpit Remote Gates** epic. Creates the single source of truth for the gate-protocol wire format: Zod schemas for the three wire contracts (**GateRecord**, **GateAnswer**, **GateOutcomeAck**), a deterministic `gateId`/`gateKey` derivation, and per-gate-type `generation` helpers — all exported from a new module `packages/cockpit/src/gates/`. Every downstream component (orchestrator routes, cockpit MCP tools, doorbell, and — mirrored — generacy-cloud) validates against these schemas.

## Context

`/cockpit:auto` currently surfaces every human gate (clarification batches, artifact/implementation reviews, manual validation, escalation, phase-queue, filing, scope-drained) as an in-session `AskUserQuestion` that blocks the whole conversation. The Cockpit Remote Gates epic moves gate answering to a central operator inbox on generacy.ai so the driving session never blocks.

For that to work, gates must become **presenter-agnostic records** identified by a stable `gateId`. This issue creates the schema module that everyone downstream pins to; nothing else in the epic can land until it does.

## Scope

New module at `packages/cockpit/src/gates/`, exported from the package root:

1. **Zod schemas** for the three wire contracts (exact shapes in plan doc §Wire contracts):
   - **GateRecord** (up-path gate-open payload): `gateId`, `gateKey`, `gateType`, `epicRef`, `issueRef`, `issueTitle`, `issueUrl`, optional `branch`, optional `prNumber`, `title`, `body` (markdown), `options[]` (`{id,label,description,recommended?}`), `allowFreeText`, `sessionId`, `askedAt`.
   - **GateAnswer** (down-path NDJSON line): `type: "gate-answer"`, `gateId`, `gateKey`, `optionId | null`, optional `freeText`, `actor` (`{userId,email,displayName}`), `answeredAt`, `deliveryId`.
   - **GateOutcomeAck** (up-path): `gateId`, `outcome` (`applied | superseded | failed`), optional `detail`, `at`.

2. **Gate type enum** (8 values): `clarification | artifact-review | implementation-review | manual-validation | escalation | phase-queue | filing | scope-drained`.

3. **Identity derivation** (deterministic, pure):
   - `gateKey = <owner>/<repo>#<issue>:<gateType>:<generation>`
   - `gateId = first 24 hex chars of sha256(gateKey)`

4. **Per-gate-type generation helpers**, one function per gate type, matching the plan doc table exactly:

   | gateType                  | generation source                                          |
   |---------------------------|------------------------------------------------------------|
   | `clarification`           | batch id                                                   |
   | `artifact-review`         | artifact kind + head SHA of the review branch              |
   | `implementation-review`   | PR head SHA                                                |
   | `manual-validation`       | PR head SHA                                                |
   | `escalation`              | subtype + triggering label/state + occurrence counter      |
   | `phase-queue`             | phase number                                               |
   | `filing`                  | draft hash                                                 |
   | `scope-drained`           | tracking-issue ref + drain counter                         |

   Callers use these helpers rather than improvising strings — this is what makes `gateId` deterministic across session restart / cluster takeover / re-open by a different presenter.

5. **Shared test fixtures**: one valid record per gate type + malformed cases, exported for reuse by orchestrator, doorbell, and MCP tests (and mirrored by generacy-cloud so both sides validate against the same bytes).

## Out of scope

Any transport, HTTP routes, MCP tool implementations, doorbell/relay changes, or cloud-side handlers. This issue ships schemas + derivation + fixtures only. Downstream issues in the epic pin to what lands here.

## User Stories

### US1: Downstream component author binds to a single schema

**As a** developer implementing the orchestrator `/cockpit/gates` route (or the cockpit MCP `cockpit_gate_open` tool, or the doorbell answers-file parser),
**I want** to `import { GateRecordSchema, GateAnswerSchema, GateOutcomeAckSchema, deriveGateId } from '@generacy-ai/cockpit'` and validate against them,
**So that** I never re-declare the wire format, and my component can't accidentally drift from what cloud and other cluster components accept.

**Acceptance criteria**:
- [ ] Schemas are the sole validation surface — no duplicate definitions live in `packages/orchestrator`, `packages/generacy/src/cli/commands/cockpit/mcp/`, or agency skills.
- [ ] All three schemas + `deriveGateId` + one generation helper per gate type are exported from `@generacy-ai/cockpit`'s public root (`src/index.ts`).

### US2: Cloud mirrors the same contracts

**As a** developer implementing the mirrored generacy-cloud schemas (`packages/types` + `packages/db`),
**I want** authoritative reference fixtures I can round-trip against my Zod re-declaration,
**So that** any drift between cluster and cloud fails a test rather than silently accepting a malformed payload in production.

**Acceptance criteria**:
- [ ] Fixtures are exported (not just in `__tests__/`) so they can be consumed by the mirrored cloud test suite.
- [ ] Each of the 8 gate types has at least one valid fixture and at least one malformed case (missing required field / wrong enum value / wrong type).

### US3: Session restart / cluster takeover is idempotent

**As** an operator whose `/cockpit:auto` session crashed mid-run,
**I want** a re-derived pending gate to hash to the same `gateId` on the restarted session,
**So that** the cloud upserts (rather than duplicates) the gate and any answer already stored gets redelivered immediately.

**Acceptance criteria**:
- [ ] Given identical `(owner, repo, issue, gateType, generation)` inputs, `deriveGateId()` returns the same 24-char hex string across processes / clock changes / Node versions supported by the package.
- [ ] Generation helpers are pure functions of their documented inputs (no `Date.now()`, no `Math.random()`, no I/O).

## Functional Requirements

| ID     | Requirement                                                                                                                      | Priority | Notes |
|--------|----------------------------------------------------------------------------------------------------------------------------------|----------|-------|
| FR-001 | Export `GateRecordSchema` (Zod) covering all fields in plan doc §Wire contracts / Gate record.                                    | P1       |       |
| FR-002 | Export `GateAnswerSchema` (Zod) with `type: z.literal('gate-answer')` discriminator, `optionId: z.string() \| z.null()`, optional `freeText`. | P1  |       |
| FR-003 | Export `GateOutcomeAckSchema` (Zod) with `outcome` enum `applied | superseded | failed`.                                          | P1       |       |
| FR-004 | Export a `GateType` Zod enum with exactly the 8 documented values.                                                                | P1       |       |
| FR-005 | Export `deriveGateKey({owner, repo, issue, gateType, generation})` returning the exact string `<owner>/<repo>#<issue>:<gateType>:<generation>`. | P1 | |
| FR-006 | Export `deriveGateId(gateKey)` returning `sha256(gateKey)` hex, sliced to 24 chars.                                               | P1       |       |
| FR-007 | Export one generation helper per gate type (8 helpers), each taking only the inputs documented in the plan doc table.             | P1       | See scope §4 table. |
| FR-008 | Every schema rejects unknown top-level fields (Zod `.strict()`) so schema drift is caught at boundary, not silently swallowed.    | P1       | |
| FR-009 | Timestamps (`askedAt`, `answeredAt`, `at`) validate as ISO 8601 strings.                                                          | P1       | Use `z.string().datetime()`. |
| FR-010 | Export a fixtures module (`fixtures.ts` re-exported from the package root) with `validGateRecords`, `validGateAnswers`, `validOutcomeAcks`, and `malformedCases` collections. | P1 | Consumed by orchestrator/doorbell/MCP tests + mirrored by cloud. |
| FR-011 | Package `exports` field surfaces the gates API (either bundled in `.` or as a named subpath like `./gates`) so downstream imports do not reach into `dist/` internals. | P1 | Match existing `@generacy-ai/cockpit` export pattern. |
| FR-012 | Unit tests cover: derivation determinism, each generation rule with realistic inputs, and rejection of every documented malformed case. | P1 | |

## Success Criteria

| ID     | Metric                                                                                                | Target                     | Measurement |
|--------|-------------------------------------------------------------------------------------------------------|----------------------------|-------------|
| SC-001 | All 8 gate types round-trip a fixture (parse → serialize → parse → deep-equal).                       | 8 / 8 pass                 | Vitest suite `gates/__tests__/round-trip.test.ts`. |
| SC-002 | `deriveGateId` determinism: same inputs → same 24-char hex.                                            | 1000 randomized input triples produce identical ids across two independent calls. | Vitest property-style test. |
| SC-003 | Schemas reject every documented malformed fixture case.                                               | 100% rejection             | Vitest suite over `malformedCases`. |
| SC-004 | Zero duplicate Zod definitions of the three wire contracts elsewhere in the repo.                     | grep for `gate-answer` literal + gate-type enum keys returns hits only in `packages/cockpit/src/gates/` and tests importing from `@generacy-ai/cockpit`. | Repository-wide grep at PR time. |
| SC-005 | New module adds no runtime dependencies beyond what `@generacy-ai/cockpit` already pins (`zod`, `yaml`). | 0 new deps in `packages/cockpit/package.json`. | `pnpm changeset` diff review. |

## Assumptions

- The plan doc's §Wire contracts section is authoritative; any ambiguity is resolved on the epic before landing this issue, not inside a follow-up.
- `sha256` is available via `node:crypto` — no third-party hash lib needed; keeps the module runnable in both Node runtime and (for cloud mirror) any Node-compatible worker environment.
- The 24-char hex slice length is chosen for readability in URLs / log lines while retaining ~96 bits of collision resistance; further shortening is not in scope.
- The `generation` field is a caller-supplied opaque string in the schema; only the *helpers* enforce the per-gate-type shape. This keeps `GateRecord` validation cheap and pushes correctness onto typed helper call sites.
- Package version bump: **minor** (new public API surface). A `.changeset/1020-*.md` file must ship with the PR per the repo's changeset gate.

## Out of Scope

- Orchestrator localhost routes (`POST /cockpit/gates`, `POST /cockpit/gates/:id/ack`, `POST /cockpit/answers`) — separate epic issue.
- MCP tools (`cockpit_gate_open`, `cockpit_gate_ack`) — separate epic issue.
- Doorbell tailing of the answers file — separate epic issue.
- Relay-channel allow-list additions (`cluster.cockpit`) — separate epic issue.
- Cloud-side Firestore model, REST endpoints, SSE stream, inbox UI — mirrored in generacy-cloud.
- Agency `auto.md` gate-mode rework (`--gates=ui|local|auto`) — separate agency-repo issue.

---

*Generated by speckit; enhanced with plan-doc grounding on 2026-07-21.*
