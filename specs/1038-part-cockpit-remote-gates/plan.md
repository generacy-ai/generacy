# Implementation Plan: Cockpit gates — read-only gate-status query + stable sweep generation derivation

**Feature**: Cluster-side dependency of the agency sweep fix — adds a cheap "is a gate already open?" MCP/HTTP query so the `--gates=ui` startup sweep can skip drafting for already-pending gates, and stabilises the per-gate-type `generation` derivation so sweep-derived and live-derived `gateId`s coalesce.
**Branch**: `1038-part-cockpit-remote-gates`
**Status**: Complete
**Spec**: [spec.md](./spec.md) · [clarifications.md](./clarifications.md)

## Summary

Two coupled cluster-side additions that unblock generacy-ai/agency's `--gates=ui` sweep:

1. **Read-only gate query** — a new MCP tool pair (`cockpit_gate_status`, `cockpit_gate_list`) backed by a new orchestrator route (`GET /cockpit/gates`), which itself proxies to cloud (Firestore) over the *same* relay path that carries `gate-open` and answers. The query never asks for drafted `title`/`body`/`options`; the sweep calls it *before* invoking the drafting subagent. Sweep primitive is `cockpit_gate_list` by `(issueRef, gateType)` prefix (Q4→B), so cutover survives pre-existing `generation=1` gates without a cloud migration.

2. **Stable, durable-GitHub-state-derived `generation`** for the two sweep-critical gate types:
   - `clarification` — canonical hash of the sorted-by-`questionNumber` list of `{ questionNumber, questionText }` for every question in the current *unanswered* batch (Q1→A). Question identity only; drafted answers excluded. Same round of asks → same generation across restart/takeover.
   - `implementation-review` — head SHA of the PR under review (already exposed by `deriveImplementationReviewGeneration`).
   `@generacy-ai/cockpit` gains the canonicalization + hash helper so the sweep path (agency, out-of-repo) and the live path (this repo) hash identical bytes. `deriveGateId` output MUST be identical across paths (SC-002, regression-tested).

**Not in scope here**: fixing the `generation=1` hard-code in `packages/claude-plugin-cockpit/commands/auto.md` (that lives in `generacy-ai/agency`); Firestore query implementation (`generacy-cloud` sibling); generation derivation for `artifact-review` / `manual-validation` / `escalation` / `phase-queue` / `filing` / `scope-drained`.

## Technical Context

**Language/Version**: TypeScript 5.x, Node ≥22 (ESM only, per repo baseline).
**Primary Dependencies**:
- `zod` — MCP boundary + wire schemas (already a dep everywhere touched).
- `@modelcontextprotocol/sdk` — MCP tool registration in `mcp/server.ts`.
- `fastify` — orchestrator route registration.
- `@generacy-ai/cockpit` — shared wire contracts + generation derivation helpers.
- `@generacy-ai/cluster-relay` — new envelope pair for cluster→cloud query.
- `ws` — already the relay's transport.
- `node:crypto` — sha256 for the canonical clarification-batch hash.

**Storage**: None on cluster. Source of truth for gate status is cloud Firestore (`generacy-cloud`, out of scope). Cluster is a read-through client; no local cache in v1 (SC-003 target = 0 duplicate subagent spawns per already-pending gate, achievable without caching by making the query cheap).

**Testing**: `vitest` (existing repo standard). Fixture-based parity tests for `deriveGateId` equality (SC-002). Mocked-orchestrator unit tests for the two new tools (matches the existing pattern in `gates/__tests__/client.test.ts`). One integration path exercised via the existing `cockpit-gates-integration.integration.test.ts` harness — extended with a status-query scenario against the fake peer.

**Target Platform**: Linux cluster container (orchestrator + MCP stdio server) + npx client on operator laptop (macOS/Linux/Windows via cross-platform Node).

**Project Type**: Monorepo (pnpm workspace). No new packages — all changes land in existing `packages/generacy/`, `packages/orchestrator/`, `packages/cockpit/`, `packages/cluster-relay/`.

**Performance Goals**:
- Query latency: p95 ≤ 500ms per single-gate lookup and ≤ 1s per per-issue list against a warmed relay. This is a startup-sweep primitive; sub-second per issue matters when a scope has 20+ issues.
- Retry budget: bounded ~3 attempts / ~5s total per FR-011 to ride out the startup relay-not-connected race, then fail-loud with `class: 'query-unreachable'`.

**Constraints**:
- **Single-transport invariant**: query goes over the same relay envelope path as `gate-open` and answers. No direct HTTPS-to-cloud fallback in v1 — single degraded-mode story (spec Assumptions §96).
- **Fail-closed on transport failure**: the tool NEVER returns `absent` when it can't reach cloud (FR-011). Sweep MUST distinguish "cloud unreachable" from "no gate exists" and abort.
- **Sweep-body-free**: query MUST NOT require `title`/`body`/`options` in the request (FR-002).
- **Project-wide list scope** (Q5→A): `cockpit_gate_list` returns non-terminal gates from *any* cluster in the project (predecessor takeover-safe).
- **Cutover without migration** (Q4→B): sweep queries by `(issueRef, gateType)` prefix; pre-existing `generation=1` rows suppress drafting until they drain naturally.
- **Idempotency via identity**: `deriveGateId` for a natural gate `(issueRef, gateType, derived-generation)` MUST be byte-identical across sweep and live paths (SC-002).

**Scale/Scope**:
- ~5 files added, ~4 files modified in this repo.
- New public exports: `deriveClarificationGeneration` input shape (breaking change from `{batchId}` to `{questions:[]}` — see Complexity Tracking below).
- Existing 14 MCP tools → 16 (both new tools appear under `/mcp` — SC-004).

## Constitution Check

No `.specify/memory/constitution.md` in this repo. Applying CLAUDE.md-derived project gates:

| Gate | Status | Notes |
|------|--------|-------|
| **Changeset file added** (`.changeset/*.md`, non-test src touched) | Will be added at implement phase | Bump levels: `@generacy-ai/generacy` **minor** (new MCP tools + orchestrator route), `@generacy-ai/cockpit` **minor** (breaking input-shape change to `deriveClarificationGeneration`, plus new canonical hash export), `@generacy-ai/cluster-relay` **patch** (additive envelope pair, no removed types). Single changeset lists all three packages. |
| **Per-feature `stack.md`** (per CLAUDE.md → #899) | Not required — see comment | This spec's technical context lives in this `plan.md`; `stack.md` is a future convention and not enforced by CI. |
| **Test-only diff exemption** | Not applicable — non-test `src/` changes present | The changeset is mandatory. |
| **CLAUDE.md addendum entry** | Will be added in step 5 | Feature summary block per the existing per-feature convention. |
| **No net-new abstractions beyond what the task requires** (CLAUDE.md guidance) | Held | One new client (`query-client.ts`) is added strictly because the existing POST client's fixed error-mapping table cannot express `'query-unreachable'` retries without conflating with POST semantics. The two clients share `resolveGateOptions` and error class enum — no duplicated infra. |

**Verdict**: PASS. Proceed to design.

## Project Structure

### Documentation (this feature)

```text
specs/1038-part-cockpit-remote-gates/
├── spec.md              # (from /specify, read-only here)
├── clarifications.md    # (from /clarify, read-only here)
├── plan.md              # This file (/plan output)
├── research.md          # Phase 0 output (/plan output)
├── data-model.md        # Phase 1 output (/plan output)
├── quickstart.md        # Phase 1 output (/plan output)
├── contracts/           # Phase 1 output (/plan output)
│   ├── cockpit_gate_status.md
│   ├── cockpit_gate_list.md
│   ├── get-cockpit-gates.md
│   └── gate-query-relay-envelope.md
├── checklists/          # empty; populated later by /checklist if requested
└── tasks.md             # Phase 2 output (/tasks — NOT created by /plan)
```

### Source Code (repository root)

Following the monorepo's existing layout — one new file per concern, sibling to the closest existing analogue:

```text
packages/cockpit/src/gates/                        # SHARED — sweep + live paths import
├── generation.ts                                  # MODIFIED — ClarificationGenerationInput
│                                                  #            changes: { batchId } →
│                                                  #            { questions: {questionNumber,
│                                                  #            questionText}[] } + canonical
│                                                  #            sha256; @internal until
│                                                  #            re-exported from index.ts
├── index.ts                                       # MODIFIED — re-export new input type
└── __tests__/
    └── gates-generation.test.ts                   # MODIFIED — parity fixture for SC-002

packages/cluster-relay/src/                        # NEW ENVELOPE PAIR
├── messages.ts                                    # MODIFIED — add GateQueryRequestMessage
│                                                  #            + GateQueryResponseMessage,
│                                                  #            wire into RelayMessage union
│                                                  #            + RelayMessageSchema
└── index.ts                                       # MODIFIED — re-export new types

packages/orchestrator/src/
├── routes/
│   ├── cockpit-gates.ts                           # MODIFIED — add GET /cockpit/gates handler
│   │                                              #            (delegates to query service)
│   └── __tests__/cockpit-gates.test.ts            # MODIFIED — add GET handler cases
├── services/
│   ├── gate-status-query.ts                       # NEW — cluster→cloud query dispatcher:
│   │                                              #       correlationId map, relay.send(),
│   │                                              #       awaits response, bounded retry
│   │                                              #       (~3 attempts / ~5s), fail-loud
│   │                                              #       503 with a distinct code on
│   │                                              #       sustained outage.
│   └── __tests__/gate-status-query.test.ts        # NEW — unit tests against a mock relay
├── types/relay.ts                                 # MODIFIED — surface new envelope types
└── server.ts                                      # MODIFIED — wire GateStatusQueryService
                                                   #            into the GET route

packages/generacy/src/cli/commands/cockpit/mcp/
├── errors.ts                                      # MODIFIED — add 'query-unreachable' to
│                                                  #            ErrorClass union
├── gates/
│   ├── schemas.ts                                 # MODIFIED — add:
│   │                                              #   GateStatusInputSchema
│   │                                              #   GateListInputSchema
│   │                                              #   GateStatusResponseSchema
│   │                                              #   GateListResponseSchema
│   ├── query-client.ts                            # NEW — GET-shaped HTTP client with
│   │                                              #       bounded retry (~3/~5s) that maps
│   │                                              #       sustained transport failure to
│   │                                              #       'query-unreachable', not
│   │                                              #       'transport'.
│   └── __tests__/query-client.test.ts             # NEW — retry + error-mapping unit tests
├── schemas.ts                                     # MODIFIED — re-export the two new input
│                                                  #            schemas for MCP registration
├── server.ts                                      # MODIFIED — registerTool(
│                                                  #              'cockpit_gate_status'…)
│                                                  #            and cockpit_gate_list
├── tools/
│   ├── cockpit_gate_status.ts                     # NEW — single-gate lookup
│   └── cockpit_gate_list.ts                       # NEW — per-issue non-terminal list
└── __tests__/
    ├── cockpit_gate_status.test.ts                # NEW — happy + error paths (incl.
    │                                              #        query-unreachable)
    └── cockpit_gate_list.test.ts                  # NEW — happy + empty + error paths

.changeset/
└── 1038-cockpit-gate-status-query.md              # NEW — minor/minor/patch trio (see gate
                                                   #        table above)
```

**Structure Decision**: All changes land in existing monorepo packages — no new packages. The four touched packages already own the concerns being extended (shared wire = `@generacy-ai/cockpit`, transport = `@generacy-ai/cluster-relay`, HTTP surface = orchestrator, MCP surface = generacy CLI). One new service file (`gate-status-query.ts`) in the orchestrator is the only net-new module; it isolates the correlation-id + retry logic so the route handler stays thin (mirrors the existing `retained-cockpit-events.ts` retainer pattern).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| Breaking change to `deriveClarificationGeneration` input shape (`{batchId}` → `{questions:[]}`) | FR-007 mandates a hash of question identity from durable GitHub state so sweep and live paths produce identical bytes. The current single-string `batchId` cannot represent that identity without a caller-side canonicalization that would drift between paths. The whole point of exporting the helper from `@generacy-ai/cockpit` is that both paths hash *the exact same bytes*, so the canonicalization MUST live inside the helper. | Keeping `{batchId}` and adding a *new* `deriveClarificationGeneration2` — rejected because a "1" and "2" pair produces exactly the two-path-drift SC-002 is designed to prevent, defeats the purpose of the shared helper, and forces the sweep to pick which version to call. Bumping the package minor version + a `## Breaking changes` section in the changeset is the CLAUDE.md-sanctioned path. |
| New relay envelope pair (`gate_query_request` / `gate_query_response`) instead of reusing `api_request`/`api_response` | The existing HTTP-tunnel envelope semantics are cloud→cluster (relay dispatches to orchestrator or unix sockets via `routes[]`). Sending an `api_request` cluster→cloud would invert the dispatcher's contract and require a second dispatcher on the cloud side that mirrors the cluster's — a much larger cross-repo change than a purpose-built envelope pair. | Direct HTTPS from cluster to cloud (bypass relay) — rejected because it violates the spec's single-transport invariant (Assumptions §96): a second transport path means a second degraded-mode story (cluster relay up, HTTPS down, or vice versa), which is exactly what this feature exists to *prevent* in the sweep path. |

## Design invariants (surface here for /tasks + code-review)

- **INV-1** — `deriveGateId(deriveGateKey(issueRef, gateType, derivedGeneration))` is bit-identical across the sweep path (agency) and the live path (this repo) for `clarification` and `implementation-review`. Regression-fixture asserts hash equality (SC-002).
- **INV-2** — `cockpit_gate_status` / `cockpit_gate_list` NEVER return `absent` on transport failure. The distinct fail-loud MCP error class is `'query-unreachable'` (FR-011).
- **INV-3** — Status mapping to the three-state response is fixed (Q2→C): `open` = cloud `open`; `answered` = cloud `answered | delivered | applied`; `absent` = no matching gate OR terminal-negative (`superseded | failed | expired`).
- **INV-4** — `cockpit_gate_list` returns non-terminal (`open | answered | delivered`) gates project-wide, from any cluster in the project (Q5→A, predecessor takeover-safe).
- **INV-5** — Sweep primitive is `cockpit_gate_list` by `(issueRef, gateType)` prefix, NOT `cockpit_gate_status` by full `gateId` — any currently-open gate for that pair suppresses drafting, regardless of generation match. This kills the gen=1 cutover duplicate without a cloud migration (Q4→B).
- **INV-6** — Single transport: the query rides the same relay path as `gate-open` / answers (spec Assumptions §96). No direct HTTPS to cloud in v1.
- **INV-7** — Query does NOT require `title`/`body`/`options` in the request (FR-002).

## Cross-repo dependencies (informational)

- **`generacy-ai/generacy-cloud` sibling (out of scope here)** — must ship the cloud-side responder for `gate_query_request`: a Firestore query by `(issueRef, gateType?)` returning the `{ gateId, gateType, status }[]` list, gated by project membership so cross-project isolation holds. The relay-envelope contract is documented in `contracts/gate-query-relay-envelope.md` so the cloud sibling can mirror the exact wire shape. This repo's implementation ships the up-path envelope and a mocked responder for unit tests; end-to-end integration lands when the cloud sibling merges.
- **`generacy-ai/agency` sibling (out of scope here)** — replaces the `generation=1` hard-code in `packages/claude-plugin-cockpit/commands/auto.md:198` with a call into the new `@generacy-ai/cockpit` helpers, and inserts the `cockpit_gate_list` skip-drafting check per INV-5. Tracked in `generacy-ai/agency#450`.

## Next step

Run `/tasks` to break this plan into ordered tasks (dependency-marked, parallelization-friendly). This plan intentionally leaves task-level ordering (which file first, which test scaffolds where) to that phase.
