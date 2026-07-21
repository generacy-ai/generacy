# Implementation Plan: Cockpit MCP — `cockpit_gate_open` + `cockpit_gate_ack`

**Feature**: Add two thin HTTP-client MCP tools to the cockpit MCP server so `/cockpit:auto` can open a remote gate on the orchestrator (rendered by generacy.ai's operator inbox) and ack its outcome, with a matchable `transport` error class that triggers a local `AskUserQuestion` fallback whenever the cloud path is unavailable.
**Branch**: `1022-part-cockpit-remote-gates`
**Status**: Complete
**Spec**: [`spec.md`](./spec.md)

## Summary

Two new MCP tools land on the cockpit MCP server (`packages/generacy/src/cli/commands/cockpit/mcp/`):

1. **`cockpit_gate_open(gateRecord)`** → `{ gateId, status }` — validates the caller-supplied gate record via the epic's shared gate schemas, POSTs to the orchestrator's `POST /cockpit/gates` route, returns the orchestrator's response inside the standard `ToolResult` envelope.
2. **`cockpit_gate_ack({ gateId, outcome, detail? })`** — POSTs to `POST /cockpit/gates/:id/ack` and returns `{ status: 'ok', data: <orchestrator-payload> }` on 2xx.

Both tools are **thin HTTP clients** — no business logic, no local persistence, no CLI-verb twin (see D-1 below). The orchestrator route implementation and the wire contracts themselves (gate record, answer NDJSON line, outcome ack, `gateId`/`generation` rules) are **owned by the epic** and land in a sibling PR — this branch implements those contracts as written; any proposed contract change is escalated on the epic issue **before** any code diverges (spec § Context).

**Design invariants:**

1. **Cloud fallback is `transport`-classed.** Orchestrator-unreachable, network errors, 5xx, and cluster-not-cloud-activated all collapse to `class: 'transport'` (Q1 → A). `/cockpit:auto --gates=auto` pattern-matches on that single class to route the gate through `AskUserQuestion` instead of pausing.
2. **Base URL and timeout are dependency-injected.** Both tools resolve `options.orchestratorUrl ?? process.env['ORCHESTRATOR_URL'] ?? 'http://127.0.0.1:3100'` (Q2 → C) and consume a 5s default timeout from the same options bag (Q5 → C). Matches the `worker-scaler.ts:345-346` in-cluster-caller pattern that FR-006 cites.
3. **4xx mapping is granular, not collapsed.** 400 → `invalid-args`, 404 → `unknown-gate`, 409 → `invalid-args`, any other 4xx → `internal` (Q4 → B). Aligns with the `toMcpResult` table in `errors.ts` (#928) that established the granular-mapping precedent.
4. **Worker-role refusal reuses the existing gate in `mcp/index.ts:40-48`** — the two new tools inherit it for free (they never register unless `buildMcpServer` runs, which the index guards).

## Technical Context

**Language/Version**: TypeScript, Node.js ≥22 (matches `packages/generacy/package.json`).
**Primary Dependencies**: `@modelcontextprotocol/sdk`, `zod` (already present); no new deps. HTTP calls use `undici`'s global `fetch` (Node ≥22 built-in) with `AbortController` for the 5s timeout.
**Storage**: None — both tools are stateless HTTP clients.
**Testing**: `vitest` (matches sibling parity suites — `parity-advance.test.ts`, `parity-claim.test.ts`). Mocked orchestrator via a `fetchImpl` injection seam on the options bag; `undici`'s `MockAgent` optional but not needed for the ~12 unit branches in scope.
**Target Platform**: In-cluster orchestrator (Linux, Node ≥22). Workers refuse to start the MCP server (`mcp/index.ts:40`).
**Project Type**: Single-package extension of `packages/generacy` (`cli/commands/cockpit/mcp/`). No changes to `packages/cockpit`, `packages/control-plane`, `packages/orchestrator`, or any other package.
**Performance Goals**: 5s hard timeout per call (Q5 → C). No retry loop — the caller (`/cockpit:auto`) is responsible for the fallback branch on `transport` failures.
**Constraints**: Zero coupling to orchestrator internals — the tools speak only over the localhost HTTP loopback and treat the response body as opaque JSON (validated shape at the tool boundary). Must not add any new CLI subcommand (Q3 → A). Must not read `process.env` outside the fallback chain in the options resolver, so tests can inject cleanly.
**Scale/Scope**: Two new MCP tools; two new Zod input schemas; one new options-bag field pair (`orchestratorUrl`, `orchestratorTimeoutMs`) threaded through `BuildMcpServerDeps`; two new tool contract docs; ~12 vitest branches; one changeset. Skill-side `auto.md` consumption is P4, out of scope for this branch.

## Constitution Check

*No `.specify/memory/constitution.md` exists in this repo (verified). Standard project conventions apply:*

- ✅ **Changesets** (CLAUDE.md gate): the implementation PR will add `.changeset/1022-cockpit-remote-gates-mcp.md` bumping `@generacy-ai/generacy` **minor** (two new MCP tools = new capability). No `@generacy-ai/cockpit` changes → no bump there.
- ✅ **Design invariant #1 exception** (Q3 → A): documented inline in `mcp/server.ts` above the two tool registrations. The other 12 tools wrap standalone CLI verbs; these two are HTTP clients with no standalone operator use, so a CLI twin would ship barely-usable UX.
- ✅ **`ErrorClass` union** (`mcp/errors.ts:15-27`): no new members. Reuses existing `transport`, `invalid-args`, `unknown-gate`, `internal` — matches spec Q1/Q4 answers.
- ✅ **Worker-role refusal**: unchanged. `mcp/index.ts:40-48` already guards `GENERACY_CLUSTER_ROLE=worker`; the two new tools inherit that by construction.
- ✅ **Options-bag pattern**: reuses the `BuildMcpServerDeps` seam already established for `runner`. Adding two optional fields (`orchestratorUrl`, `orchestratorTimeoutMs`, plus a test-only `fetchImpl`) is non-breaking.
- ✅ **Never-merge-on-red / gate-ack idempotency**: unaffected — this feature does not touch `cockpit_merge` or the label protocol. `cockpit_gate_ack` is remote-orchestrator idempotency (owned there), not GitHub-label idempotency.

## Deferred Clarifications — Plan-Phase Decisions

Two implementer-selectable decisions were deferred from the spec's clarification phase:

### D-1: Where the options-bag threading happens

**Choice**: Extend **`BuildMcpServerDeps`** in `mcp/server.ts:42` with `orchestratorUrl?: string`, `orchestratorTimeoutMs?: number`, and `fetchImpl?: typeof fetch`. `runCockpitMcp` in `mcp/index.ts` passes them through unchanged; the two new tool handlers destructure them off the `deps` object received in `buildMcpServer`.

**Rationale**:
- Matches the existing `deps: BuildMcpServerDeps = {}` seam pattern already used by every other tool registration in `server.ts:60-178`. Adding fields to the same interface keeps the injection surface uniform — no separate `GateToolsDeps` interface that consumers would then have to compose.
- `runCockpitMcp` at `mcp/index.ts:31` currently constructs `buildMcpServer()` with no arguments; the production path can stay that way (tools resolve env-var fallback at call time). Tests inject via `buildMcpServer({ orchestratorUrl, orchestratorTimeoutMs, fetchImpl })` directly, without any change to `runCockpitMcp`.
- Alternative (per-tool options passed only to `cockpitGateOpen(input, deps)` at handler-invocation time) rejected because the handler is invoked by the MCP SDK's `registerTool` closure — there's no ergonomic way to thread per-request deps from outside without touching every tool registration.

### D-2: HTTP client — `fetch` vs `node:http`

**Choice**: Use Node's built-in **`fetch`** (undici under the hood, stable in Node ≥22 which this package already requires). Timeout via `AbortController`.

**Rationale**:
- The two closest in-cluster HTTP callers (`packages/control-plane/src/services/worker-scaler.ts`, `packages/orchestrator/src/routes/internal-relay-events.ts`) already use `fetch`. Consistency wins over the older `node:http` pattern used by `activation-client` and `credhelper-daemon`, both of which predate Node 22 availability.
- Zero dependencies (undici is bundled). No `import 'node:http'` boilerplate; no manual body-buffering.
- Alternative (`node:http` with a socket-path/`unix://` variant for future orchestrator-over-socket work) rejected because the orchestrator gate routes are HTTP-over-TCP-loopback per the epic contracts; no unix-socket variant is in scope. If that changes, `fetch` + `dispatcher` swap is trivial.

## Project Structure

### Documentation (this feature)

```text
specs/1022-part-cockpit-remote-gates/
├── plan.md                     # This file
├── spec.md                     # Feature specification (read-only)
├── clarifications.md           # Batch 1 clarifications (read-only)
├── research.md                 # Phase 0 output (new)
├── data-model.md               # Phase 1 output (new)
├── contracts/
│   ├── cockpit_gate_open.md    # MCP tool contract (new)
│   ├── cockpit_gate_ack.md     # MCP tool contract (new)
│   └── error-mapping.md        # HTTP status → ErrorClass table (new)
├── quickstart.md               # Implementer + skill-author usage (new)
└── checklists/                 # Empty (no checklist requested)
```

### Source Code (repository root)

New files (all under `packages/generacy/src/cli/commands/cockpit/mcp/`):

```text
packages/generacy/src/cli/commands/cockpit/mcp/
├── gates/
│   ├── client.ts               # NEW — HTTP client: buildRequest, invoke, timeout, error-mapping.
│   ├── options.ts              # NEW — resolveGateOptions({url?, timeoutMs?, fetchImpl?}, env)
│   ├── schemas.ts              # NEW — Zod schemas for gate record (mirrors epic contract),
│   │                           #        gate-ack input, orchestrator response envelopes.
│   └── __tests__/
│       ├── client.test.ts      # NEW — unreachable, 2xx, 400/404/409/500 mapping, timeout, abort
│       └── options.test.ts     # NEW — precedence: arg > env > default
├── tools/
│   ├── cockpit_gate_open.ts    # NEW — MCP tool handler (thin wrapper over gates/client.ts)
│   └── cockpit_gate_ack.ts     # NEW — MCP tool handler (thin wrapper over gates/client.ts)
├── schemas.ts                  # MODIFIED — export CockpitGateOpenInputSchema + CockpitGateAckInputSchema
├── server.ts                   # MODIFIED — register cockpit_gate_open + cockpit_gate_ack;
│                               #             extend BuildMcpServerDeps with orchestratorUrl,
│                               #             orchestratorTimeoutMs, fetchImpl; document the
│                               #             invariant-#1 exception in a header comment above
│                               #             the two new registrations.
├── errors.ts                   # UNMODIFIED — reuses existing ErrorClass union.
└── __tests__/
    ├── parity-gate-open.test.ts    # NEW — MCP-boundary tests: 2xx / 400 / 404 / 409 / 500 /
    │                                #        network-error / timeout / schema-validation / worker-refusal-inheritance
    ├── parity-gate-ack.test.ts     # NEW — as above, for cockpit_gate_ack
    └── tool-schema-audit.test.ts   # MODIFIED — assert the two new tool names appear in the
                                    #             registered tool list; assert their input schemas
                                    #             reject `{}` and accept a canonical fixture.
```

Changeset (project root):

```text
.changeset/
└── 1022-cockpit-remote-gates-mcp.md    # NEW — minor bump for @generacy-ai/generacy
```

**Skill-side prose (out of scope for this branch, tracked separately in the epic P4)**: `agency` repo — `packages/claude-plugin-cockpit/commands/auto.md` needs to:
1. Add a `--gates=auto|local` frontmatter arg.
2. In the gate-open dispatch step, try `cockpit_gate_open` first; on `class: 'transport'`, fall back to `AskUserQuestion`; on any other error class, propagate as today.
3. On resolution, call `cockpit_gate_ack({ gateId, outcome, detail? })` once with the operator's decision.
4. Feature-flag `--gates=local` bypasses the MCP tools entirely (existing behavior).

**Structure Decision**: The `gates/` sub-folder mirrors the sibling `claim/` folder (`mcp/claim/`, from #1015) and `scope/` folder pattern — grouping the tool-boundary logic (client, options, schemas) that would otherwise clutter `mcp/`. Two thin `tools/cockpit_gate_open.ts` + `tools/cockpit_gate_ack.ts` handlers keep the MCP-server registration list uniform with the other 12 tools.

## Constitution Re-Check (Post-Design)

- ✅ **No new `ErrorClass` members** — verified against `errors.ts:15-27`. All four mapped classes (`transport`, `invalid-args`, `unknown-gate`, `internal`) already exist.
- ✅ **No new dependencies** — `fetch` is built into Node ≥22, already required by this package.
- ✅ **Options-bag surface** — three new optional fields on `BuildMcpServerDeps` (`orchestratorUrl`, `orchestratorTimeoutMs`, `fetchImpl`). All optional, all defaulted, non-breaking for existing tool registrations.
- ✅ **Worker-role refusal** — inherited from `mcp/index.ts:40`; no separate guard needed in the tool handlers.
- ✅ **Contract ownership** — the gate record + ack shape are **read-only imports** of the epic's wire contracts (documented in `contracts/`). Any drift from the epic contract is a spec violation, not a plan-phase decision.
- ✅ **Test isolation** — `fetchImpl` injection means zero real HTTP calls in unit tests; no `nock`/`msw` needed.

## Complexity Tracking

No constitution violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none)    | —          | —                                    |

## Next Step

Run `/speckit:tasks` to generate the ordered task list.
