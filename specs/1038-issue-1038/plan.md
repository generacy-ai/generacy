# Implementation Plan: Cockpit gates — read-only status query + stable sweep generation derivation

**Feature**: Add two read-only MCP query tools (`cockpit_gate_status`, `cockpit_gate_list`), the orchestrator `GET /cockpit/gates` route that backs them (cluster → cloud HTTPS with the cluster API key), and a durable, GitHub-state-derived `generation` discriminator for `clarification` and `implementation-review` gates so sweep-derived and live-derived `gateId`s coalesce.
**Branch**: `1038-issue-1038`
**Status**: Complete
**Spec**: [`spec.md`](./spec.md)
**Epic**: Cockpit Remote Gates (generacy-ai/generacy-cloud#850)

## Summary

Three additive changes land together so they solve the sweep-duplicate bug end to end:

1. **Cluster-side query surface** — two new MCP tools on the cockpit MCP server:
   - `cockpit_gate_status({ issueRef, gateType, generation })` → `{ gateId, status: 'open' | 'answered' | 'absent' }`
   - `cockpit_gate_list({ issueRef, gateType? })` → `{ gates: [{ gateId, gateType, generation, status }] }`
   Both are **thin HTTP clients** that call the new orchestrator route. They are read-only — never open, ack, retain, or mutate a gate.
2. **Orchestrator route** — new `GET /cockpit/gates` in `packages/orchestrator/src/routes/cockpit-gates.ts`. Query-string carries `issueRef`, optional `gateType`, and optional `generation`. The route makes an authenticated HTTPS `GET /api/clusters/:clusterId/cockpit/gates?...` to `GENERACY_API_URL` using the cluster API key — the same auth+transport pattern already in `packages/control-plane/src/services/cloud-pull-client.ts` and `packages/activation-client`. Cloud (Firestore) is the source of truth; the route is a pass-through.
3. **Durable `generation` derivation** in `@generacy-ai/cockpit`:
   - New pure helper `computeClarificationAnswerSetHash({ questions })` — sorted-by-`questionNumber` list of `{ questionNumber, questionText }`, JSON-canonical, `sha256`, first 12 hex chars (per Q1 → A). The existing `deriveClarificationGeneration({ batchId })` stays; its `batchId` input now MAY be sourced from the new helper. Both agency (sweep) and the live path call the same helper — single source of truth (FR-009).
   - `deriveImplementationReviewGeneration({ headSha })` already exists in `packages/cockpit/src/gates/generation.ts`; documented as canonical (no code change, plan asserts it).
   - `artifact-review`, `manual-validation`, `escalation` helpers already exist; documented and covered by fixture tests to prove sweep/live parity per SC-002.

The transport, retry, and error-mapping details for the two query tools are frozen by clarifications: **Q2 → C** (cloud status → three-state collapse), **Q3 → D** (~3 attempts / ~5s → `class: 'query-unreachable'`), **Q4 → B** (sweep skips drafting when any gate for `(issueRef, gateType)` is currently non-terminal, using `cockpit_gate_list` as the primary primitive), **Q5 → A** (list returns non-terminal gates project-wide).

**Design invariants:**

1. **Observer independence** — the two query tools MUST NOT import gate-mutation code paths. A static import-scan test locks this in (FR-012 / SC-005), mirroring `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/observer-independence.test.ts` from #1015.
2. **Firestore is the source of truth** — the orchestrator route is a stateless proxy. No local cache. No side effects. Any local caching in later work is advisory only (FR-004).
3. **Transport-failure is fail-loud** — sustained cloud/relay outage after the retry budget throws MCP error `class: 'query-unreachable'`, never `status: 'absent'`. Callers see a distinct error class; the sweep aborts the scope's `--gates=ui` run rather than silently re-drafting (FR-014, SC-007).
4. **`absent` is not an error** — a legitimately-missing gate returns `{ status: 'absent', gateId: null }` inside a `ToolOkResult`, not inside an error envelope (FR-013). Distinguishes "no gate here" from "query failed."
5. **`generation` derivation is pure** — every generation-derivation helper in `@generacy-ai/cockpit` takes explicit inputs, returns a deterministic string, and has zero I/O. Sweep and live-path callers construct the inputs from their respective sources (GitHub state, PR head SHA); the helper never reads them itself.

## Technical Context

**Language/Version**: TypeScript, Node.js ≥22 (matches `packages/generacy/package.json`, `packages/orchestrator/package.json`, `packages/cockpit/package.json`).
**Primary Dependencies**: `@modelcontextprotocol/sdk`, `zod`, `fastify`, `node:https`, `node:crypto` — all already present. No new runtime deps.
**Storage**: None cluster-side. Cloud Firestore is the authoritative store (owned by generacy-cloud).
**Testing**: `vitest`. Injection seams: `fetchImpl` (MCP client), `httpsRequestImpl` (orchestrator cloud-query client), a stubbed Fastify server for orchestrator-route tests. Mirrors the existing `parity-gate-open.test.ts` / `parity-gate-ack.test.ts` patterns from #1022 and the `cockpit-gates-integration.integration.test.ts` harness from #1024.
**Target Platform**: In-cluster orchestrator (Linux, Node ≥22). Workers refuse to start the MCP server (`mcp/index.ts:40-48`); the two query tools inherit that guard.
**Project Type**: Multi-package additive extension of the epic. Touches three packages:
- `@generacy-ai/cockpit` — new pure `computeClarificationAnswerSetHash` helper; documents the existing generation helpers as canonical.
- `@generacy-ai/generacy` — two new MCP tools; new `mcp/gates/query-client.ts`; register in `mcp/server.ts`.
- `@generacy-ai/orchestrator` — new `GET /cockpit/gates` route; new cluster→cloud query client (mirror of `cloud-pull-client.ts`).

**Performance Goals**: 5s hard timeout per HTTP call, matched to sibling #1022's `orchestratorTimeoutMs` default. Retry: 3 attempts (initial + 2 retries) with delays `0ms → 1500ms → 3500ms` — total budget ≤5s (~5s per Q3 → D). Zero calls into drafting subagents (SC-004).
**Constraints**:
- Zero coupling between the query tools and the write path (`cockpit_gate_open`, `cockpit_gate_ack`, `packages/generacy/src/cli/commands/cockpit/mcp/gates/client.ts`). Observer independence is a hard invariant enforced by static import-scan test (SC-005).
- No changes to the existing `deriveClarificationGeneration` signature. The new `computeClarificationAnswerSetHash` helper is additive — existing callers continue to pass a `batchId` string opaquely; new callers (sweep + live) construct the batchId via the helper.
- No new relay message types. The cluster → cloud query rides direct HTTPS with the cluster API key, exactly like `cloud-pull-client.ts` (#766, v1.5) and the activation client.

**Scale/Scope**: Two new MCP tools, one new orchestrator route + cloud-query client, one new `@generacy-ai/cockpit` helper, one new `ErrorClass` value (`query-unreachable`), three contract docs, one JSON Schema mirror, one changeset, ~15 vitest branches. Skill-side agency consumption (removing `generation=1`, wiring the sweep to call `cockpit_gate_list`) is **out of scope** — tracked in generacy-ai/agency#450.

## Constitution Check

*No `.specify/memory/constitution.md` exists in this repo (verified). Standard project conventions apply:*

- ✅ **Changesets** (CLAUDE.md gate): the PR adds `.changeset/1038-cockpit-gates-query.md` — `@generacy-ai/cockpit` **minor** (new `computeClarificationAnswerSetHash` public export), `@generacy-ai/generacy` **minor** (two new MCP tools + new `ErrorClass` union member), `@generacy-ai/orchestrator` **patch** (new route + internal client; not a public-surface bump).
- ✅ **`ErrorClass` union** (`mcp/errors.ts:15-27`): **one new member** — `query-unreachable`. Justified by FR-014 (must be distinct from `transport` so the sweep can dispatch differently — `transport` triggers the local `AskUserQuestion` fallback for writes; `query-unreachable` aborts the sweep). Added exactly one entry; no other members changed.
- ✅ **Observer independence** (`__tests__/observer-independence.test.ts` pattern from #1015): extend the existing test to cover `cockpit_gate_status.ts` and `cockpit_gate_list.ts` — no import of `mcp/gates/client.ts`, no import of `cockpit_gate_open.ts` / `cockpit_gate_ack.ts`, no import of `retained-cockpit-events.ts`.
- ✅ **Worker-role refusal** (`mcp/index.ts:40-48`): inherited by construction — no separate guard needed.
- ✅ **No new dependencies** — `fetch`, `node:https`, `node:crypto` are Node built-ins already required by these packages.
- ✅ **Design invariant #1 exception** (from `mcp/server.ts` #1022 header): the two new query tools are **also** exempt from the "each MCP tool wraps a CLI verb" invariant. They only make sense inside an active `/cockpit:auto` sweep step; an operator invoking `generacy cockpit gate-status` by hand has no legitimate use-case. Documented in a `server.ts` header comment above the two new registrations, matching the existing #1022 comment.
- ✅ **Contract source-of-truth** — the query response shapes (three-state collapse per Q2 → C) are **local to this feature's cluster boundary**. The cloud's Firestore representation is authoritative for the seven statuses; the collapse-to-three happens in the orchestrator route (per the mapping table in `contracts/gate-query.md`). Any change to that mapping is a spec violation.
- ✅ **Never-merge-on-red / label-protocol** — unaffected.

## Deferred Clarifications — Plan-Phase Decisions

Four implementer-selectable decisions were deferred from the clarification phase to `/plan`:

### D-1: Transport — cluster → cloud query path

**Choice**: The orchestrator route makes a **direct HTTPS request to `GENERACY_API_URL`** using the cluster API key at `/var/lib/generacy/cluster-api-key`, exactly like `packages/control-plane/src/services/cloud-pull-client.ts` and `packages/activation-client/src/client.ts`. No new relay-message types.

**Rationale**:
- Two sibling cluster→cloud clients already exist (`cloud-pull-client.ts` from #766, `activation-client` from #500) with the same auth story (Bearer cluster API key). Reusing the pattern keeps the mental model uniform.
- Relay message types are load-bearing for cloud→cluster push and up-path event fan-out; adding a synchronous cluster→cloud query would double the connection state machine for no functional gain.
- HTTPS + Bearer decouples the query from relay availability. If the relay is disconnected (the exact startup race Q3 identifies) HTTPS still works — bounded retry handles the transient DNS/TLS race, `query-unreachable` handles sustained outage.
- Failure-mode symmetry: `cluster.json` + cluster API key are the two files activation writes; both are required for any cluster→cloud call. Any code path that assumes activation completed can use this client.

**Alternatives considered**:
- **New relay message pair** (`gate_query_request` / `gate_query_response`): rejected — doubles the correlation-id state machine, forces the cloud to add a new WebSocket handler branch, and gains nothing over HTTPS given the relay is a WebSocket over HTTPS anyway.
- **Reuse the existing `ApiRequestMessage` schema** but flip the direction: rejected — `ApiRequestMessage` currently means "cloud calls the cluster's HTTP proxy"; reusing it in reverse would require cloud-side dispatcher rework and confuse the existing dispatcher tests.
- **Route via the control-plane** (`packages/control-plane/src/services/`): rejected — control-plane is for cluster-internal state (credentials, code-server, VS Code tunnel). Gate queries are orchestrator's concern (matches the write path in `packages/orchestrator/src/routes/cockpit-gates.ts`).

### D-2: Retry policy for `query-unreachable`

**Choice**: **3 attempts total** (1 initial + 2 retries), delays `0ms → 1500ms → 3500ms` (~5s budget per Q3 → D). Retry loop lives **inside the MCP tool handler** (`tools/cockpit_gate_status.ts` and `tools/cockpit_gate_list.ts`), not inside the HTTP client — matches the existing "HTTP client speaks HTTP + status codes; tool handler owns policy" split from #1022 (see `mcp/gates/client.ts` header). Retry triggers on: `transport`-class errors from the HTTP client, HTTP 502/503/504, and network errors. Retry does NOT trigger on: 4xx (that's a caller bug — surface immediately), 200 with malformed body (that's an orchestrator bug — surface immediately).

**Rationale**:
- Q3 → D fixes both the number (~3) and the budget (~5s). The `0/1500/3500` schedule keeps the initial attempt at zero cost and rides out the ~3s window during which the orchestrator's `cloud-pull-client`-analog might see a relay-startup race.
- Placing the retry in the tool handler (not the shared HTTP client) means `cockpit_gate_status` and `cockpit_gate_list` can share the retry policy without polluting the HTTP client's single-call contract that other callers depend on.
- Failure envelope after exhaustion: `{ status: 'error', class: 'query-unreachable', detail: '<last attempt error message>', hint?: 'query gate status after connectivity is restored' }`. `hint` is optional and lets the CLI/skill render a resolvable error message.

**Alternatives considered**:
- **No retry** (Q3 → A directly): rejected — Q3 → D was chosen because startup is exactly when the relay may not be connected yet, and 5s of bounded retry rides out that specific race.
- **Retry inside the HTTP client** (shared with the write-path client): rejected — the write-path client is intentionally single-call (see `#1022` R9 — "MCP tools are not idempotent; skill decides whether to retry"). Adding retry to the shared client would leak query-side policy into the write-path.
- **Exponential backoff to a 10s budget**: rejected — spec Q3 → D says ~5s; longer holds up the sweep for no additional coverage of the identified race.

### D-3: Where the `generation`-derivation change lands

**Choice**: **New pure helper `computeClarificationAnswerSetHash({ questions })`** in `@generacy-ai/cockpit`, additive alongside the existing `deriveClarificationGeneration({ batchId })`. Both agency (sweep) and any live-path code that opens a `clarification` gate must call `computeClarificationAnswerSetHash` first to build the `batchId`, then feed it into `deriveClarificationGeneration`. The two-step split is intentional: the hash helper is trivially testable against the fixed Q1 → A canonicalization; the derivation helper stays a stable one-liner that any future non-hash `batchId` source (e.g., a bare integer) can still reach.

**Rationale**:
- Backward-compatible: existing consumers of `deriveClarificationGeneration({ batchId: '<literal>' })` continue to work. Only callers that want the durable Q1 → A hash need to opt in.
- Same "pure + explicit inputs" invariant as every other helper in `packages/cockpit/src/gates/generation.ts`. The helper takes an already-fetched `questions[]` array — it does not do the GitHub read itself. That's the sweep's responsibility (agency-side), or the live path's (this repo's `auto.md`-adjacent code).
- Canonical hash: `sha256(JSON.stringify(sortedQuestions))` with `sortedQuestions = questions.sort((a,b) => a.questionNumber - b.questionNumber)`. First 12 hex chars — matches the `gateId`-truncation feel and avoids emitting a 64-char discriminator into `gateKey`. 12 hex = 48 bits → collision probability of ~2⁻²⁴ at 4k open gates project-wide, which is comfortably lower than any realistic operator inbox.

**Alternatives considered**:
- **Extend the existing helper to accept `questions[]` directly**: rejected — breaks the current call signature. Some existing tests + fixtures pass a literal `batchId`; migrating them all just to add a hash mode is churn.
- **Compute the hash inside the MCP tool (`cockpit_gate_open`)**: rejected — the MCP tool would need to grow a `questions[]` field on its input schema, which duplicates presentation concerns that already live in the skill's prompt-drafting step. Keeping the hash as an input to the derivation helper preserves the "MCP tools take semantic + presentation fields; helpers do the pure math" separation from #1022.
- **`sha256` first 24 chars** (match `gateId` length): rejected — the `generation` string ends up as a substring of `gateKey`, which itself feeds `sha256` again for `gateId`. 12 hex is already collision-safe for the population and keeps `gateKey` readable in logs.

### D-4: `cockpit_gate_list` response envelope shape

**Choice**: **`{ gates: [{ gateId, gateType, generation, status }], truncated?: boolean }`**. `truncated` is optional and set to `true` by the orchestrator route only when the cloud upstream paginates and the caller did not follow through (a real paging surface is not in scope for this feature). Response is a `ToolOkResult` with `data` matching the shape above.

**Rationale**:
- Q5 → A pins the return set (non-terminal gates project-wide); the shape choice is envelope-only. Wrapping the array in an object leaves room for future fields (`truncated`, `nextCursor`, `serverTime`) without breaking the tool's response type. The sibling `cockpit_status` MCP tool uses the same envelope-object convention (`{ epic, phases, ... }` inside `data`).
- Caller pattern (from Q4 → B): `const { gates } = result.data; if (gates.some(g => g.gateType === wantedType)) skip();`. Iteration is trivial; filtering by `gateType` is one line.
- `truncated` is deliberately opt-in — until the cloud actually paginates, the flag is absent (not `false`) so a downstream length-check on `gates` remains truthful.

**Alternatives considered**:
- **Raw array `Gate[]`**: rejected — no room to grow. Envelope-object is the sibling pattern.
- **`Map<gateType, Gate[]>`**: rejected — the sweep's iteration is per-`(issueRef, gateType)` pair anyway; grouping in the response saves no code.
- **Include full gate records** (title/body/options): rejected — that's what `cockpit_gate_open` is for. The query is intentionally cheap (SC-004).

## Project Structure

### Documentation (this feature)

```text
specs/1038-issue-1038/
├── plan.md                            # This file
├── spec.md                            # Feature specification (read-only)
├── clarifications.md                  # Batch 1 clarifications (read-only)
├── research.md                        # Phase 0 output (new)
├── data-model.md                      # Phase 1 output (new)
├── contracts/
│   ├── cockpit_gate_status.md         # MCP tool contract (new)
│   ├── cockpit_gate_list.md           # MCP tool contract (new)
│   ├── gate-query.md                  # Orchestrator route + cloud-status mapping (new)
│   ├── gate-query.schema.json         # JSON Schema mirror for cloud consumer (new)
│   └── generation-derivation.md       # generation-per-gateType canonicalization (new)
├── quickstart.md                      # Implementer + skill-author usage (new)
└── checklists/                        # Empty
```

Cross-repo wire-contract update (per FR-010) also lands in this PR:

```text
specs/1020-part-cockpit-remote-gates/contracts/
├── gate-query.md                      # NEW — mirror of specs/1038/contracts/gate-query.md
└── gate-query.schema.json             # NEW — mirror of the JSON Schema
```

### Source Code (repository root)

New / modified files:

```text
packages/cockpit/
├── src/gates/
│   ├── clarification-hash.ts          # NEW — computeClarificationAnswerSetHash({ questions })
│   ├── generation.ts                  # MODIFIED — inline comment cross-refs clarification-hash for
│   │                                  #             the canonical batchId construction (existing
│   │                                  #             signature unchanged).
│   ├── index.ts                       # MODIFIED — re-export computeClarificationAnswerSetHash
│   └── __tests__/
│       ├── clarification-hash.test.ts # NEW — canonicalization + sort + hash-length assertions
│       └── generation-parity.test.ts  # NEW — sweep/live parity: same GitHub state → same gateId

packages/orchestrator/
├── src/
│   ├── routes/
│   │   ├── cockpit-gates.ts           # MODIFIED — add GET /cockpit/gates handler; keep POST routes
│   │   │                              #             (untouched by this feature).
│   │   └── __tests__/
│   │       └── cockpit-gates.test.ts  # MODIFIED — extend for GET /cockpit/gates: 200/absent/upstream-
│   │                                  #             error/4xx-from-cloud/timeout branches.
│   └── services/
│       ├── cloud-gate-query-client.ts # NEW — cluster→cloud HTTPS client; mirror of
│       │                              #        control-plane/src/services/cloud-pull-client.ts.
│       └── __tests__/
│           └── cloud-gate-query-client.test.ts   # NEW — request shape, auth header, retry-none
│                                     #                    (retry lives in the MCP tool, not here),
│                                     #                    JSON parse, error mapping.

packages/generacy/
├── src/cli/commands/cockpit/mcp/
│   ├── gates/
│   │   ├── query-client.ts            # NEW — GET-verb HTTP client for cockpit_gate_status /
│   │   │                              #        cockpit_gate_list. Sibling of gates/client.ts (the
│   │   │                              #        POST-verb client for open/ack). Kept SEPARATE per
│   │   │                              #        observer-independence invariant.
│   │   ├── query-schemas.ts           # NEW — Zod input/response schemas for the two query tools.
│   │   ├── retry.ts                   # NEW — pure retry-with-backoff helper (0/1500/3500ms budget).
│   │   └── __tests__/
│   │       ├── query-client.test.ts   # NEW — success, transport-fail, 4xx, retry-terminates.
│   │       └── retry.test.ts          # NEW — schedule assertions, abort-signal propagation.
│   ├── tools/
│   │   ├── cockpit_gate_status.ts     # NEW — MCP tool handler (thin wrapper: input schema →
│   │   │                              #        query-client → 3-attempt retry → envelope).
│   │   └── cockpit_gate_list.ts       # NEW — MCP tool handler (as above; returns { gates, truncated? }).
│   ├── schemas.ts                     # MODIFIED — export CockpitGateStatusInputSchema +
│   │                                  #             CockpitGateListInputSchema from ./gates/query-schemas.
│   ├── server.ts                      # MODIFIED — register cockpit_gate_status + cockpit_gate_list;
│   │                                  #             header comment documents observer-independence +
│   │                                  #             invariant-#1 exception for query tools.
│   ├── errors.ts                      # MODIFIED — add 'query-unreachable' to ErrorClass union.
│   └── __tests__/
│       ├── parity-gate-status.test.ts # NEW — MCP-boundary tests: happy path (each status), retry
│       │                              #        exhaustion, transport → query-unreachable, absent
│       │                              #        vs error distinction (FR-013).
│       ├── parity-gate-list.test.ts   # NEW — MCP-boundary tests: empty list, single/many, filter
│       │                              #        by gateType, truncated flag, retry exhaustion.
│       ├── observer-independence.test.ts   # MODIFIED — extend the existing static import-scan
│       │                              #                   (from #1015) to cover the two new tool
│       │                              #                   files; assert they do NOT import
│       │                              #                   gates/client.ts, cockpit_gate_open.ts,
│       │                              #                   cockpit_gate_ack.ts, or retained-*.ts.
│       └── tool-schema-audit.test.ts  # MODIFIED — assert the two new tool names appear in the
│                                      #             registered tool list; reject `{}` and accept
│                                      #             the canonical fixtures.
```

Changeset (project root):

```text
.changeset/
└── 1038-cockpit-gates-query.md        # NEW — @generacy-ai/cockpit MINOR (new helper),
                                       #       @generacy-ai/generacy MINOR (new tools +
                                       #       ErrorClass union member), @generacy-ai/orchestrator
                                       #       PATCH (internal route + client; not public API).
```

**Structure Decision**: The `gates/query-*.ts` files sit next to the existing `gates/client.ts` / `gates/schemas.ts` (from #1022) but in **separate files with no shared internal helpers**. This is the concrete mechanism that enforces observer independence — a static import-scan test can assert `tools/cockpit_gate_status.ts` and `tools/cockpit_gate_list.ts` do not import from `gates/client.ts`, `tools/cockpit_gate_open.ts`, `tools/cockpit_gate_ack.ts`, or `routes/retained-cockpit-events.ts`. If a future refactor extracts a truly-shared primitive (e.g., timeout handling), it should land in a new `gates/http-common.ts` that both sides import — never by cross-importing the write-path files.

## Constitution Re-Check (Post-Design)

- ✅ **`ErrorClass` union** — one new member (`query-unreachable`); documented in `errors.ts` header. Justified by dispatch-branch divergence from `transport` (transport → local `AskUserQuestion` fallback for writes; query-unreachable → abort sweep for this scope). This is not a proliferation — it's the second class introduced to distinguish read-fail from write-fail.
- ✅ **No new dependencies** — `fetch`, `node:https`, `node:crypto` are all Node built-ins.
- ✅ **Observer independence** — enforced by static test (SC-005). Concrete import-graph: `tools/cockpit_gate_status.ts` → `gates/query-client.ts` → `gates/query-schemas.ts` → `zod`. Never touches the write-path modules.
- ✅ **Options-bag surface** — reuses `BuildMcpServerDeps` (`orchestratorUrl`, `orchestratorTimeoutMs`, `fetchImpl`) from #1022. No new options field. Retry policy is a compile-time constant in `gates/retry.ts` (per Q3 → D — ~5s is not operator-tunable).
- ✅ **Contract source-of-truth** — the three-state collapse mapping and the retry budget are defined in `contracts/gate-query.md`, which is mirrored under the epic's `specs/1020-part-cockpit-remote-gates/contracts/` per FR-010. The generacy-cloud consumer reads the mirror; drift is a spec violation.
- ✅ **Wire contract preservation** — `gateId` shape (`sha256(gateKey)[:24]`) is unchanged (Assumption 5). Only the `generation` input for `clarification` gates gains a canonical construction path; the derivation function itself stays.
- ✅ **Backward compatibility** (Assumption 4) — the sweep uses `cockpit_gate_list` primarily, so pre-existing `generation=1` gates are covered by the `(issueRef, gateType)` prefix check without a data migration.
- ✅ **Cluster-not-cloud-activated failure mode** — the cloud-query client fails closed if `/var/lib/generacy/cluster-api-key` is missing (returns a `query-unreachable` after retry, same as cloud-unreachable). No silent `absent`.

## Complexity Tracking

No constitution violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none)    | —          | —                                    |

## Next Step

Run `/speckit:tasks` to generate the ordered task list.
