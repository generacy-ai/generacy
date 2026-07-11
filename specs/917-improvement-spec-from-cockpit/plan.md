# Implementation Plan: `generacy cockpit mcp` — stdio MCP server transport for cockpit verbs

**Feature**: Improvement spec from the cockpit v1.5 auto-mode smoke test efficiency workstream — add a stdio MCP server transport for the cockpit verb set (`cockpit_status`, `cockpit_context`, `cockpit_queue`, `cockpit_advance`, `cockpit_resume`, `cockpit_merge`) plus a long-poll batched event tool (`cockpit_await_events`), registered user-scope inside the orchestrator container only.
**Branch**: `917-improvement-spec-from-cockpit`
**Status**: Complete

## Summary

The cockpit v1.5 auto session drives everything through Bash + the cockpit CLI. Snappoll ledger (run-7, 2026-07-10) attributed the dominant per-run cost to transport, not engine work: syntax-negotiation rounds (`--help`, `<pr-ref>` vs `<issue>` confusion), JSON re-parsing (every `--json` result flows through shell text and back into agent reasoning), and event-delivery granularity (~100 watch events each landed as a separate wakeup → separate dispatch round; ~4–5k token growth per round).

This PR ships **one new CLI subcommand** — `generacy cockpit mcp` — that serves the cockpit verb set as typed MCP tools over stdio. Design invariants (see spec § Design):

1. **Same internal functions, two transports.** Each MCP tool handler calls the same `run<Verb>(...)` function today's CLI wraps. No shelling out to `generacy cockpit <verb>` from the MCP server — that would drift the two surfaces on every future edit.
2. **Typed error results, no stdout parsing.** The discriminated-union shapes CLI emits as `--json` are returned directly as tool results (JSON-shape parity, deep-equal per SC-parity fixture). Errors are `{status: "error", class, detail}` tool results, not bare non-zero exits.
3. **Ref/schema-level rejection.** A PR number passed as `<issue>` is a tool-schema error with actionable guidance — subsumes generacy#906's guard at this transport (still enforced at CLI too; both transports share the resolver).
4. **`cockpit_await_events` — long-poll + coalescing batch tool.** `maxWaitMs=55000`, `coalesceWindowMs=3000`, `maxBatchSize=256` server defaults, all per-call tunable. Cursor-based, verbatim event bodies (byte-equal to `cockpit watch` NDJSON lines), discriminated invalid-cursor handling (`{class: "invalid-cursor"}` for malformed vs `{resetFrom: "expired"}` reset-to-head for expired/discarded). Delivery batching, never filtering — agency#394 invariant.
5. **Orchestrator-only registration.** Not `.mcp.json` (repo-scoped, would leak into worker containers). Registered user-scope in the orchestrator container's `~/.claude.json` by the cluster-base entrypoint. Overwrite-unconditionally-on-conflict (source of truth = entrypoint; upgrades self-heal). `GENERACY_CLUSTER_ROLE=worker` env var (new; set by scaffolder) triggers structural refusal on `cockpit mcp` startup — defense in depth.

Companion to agency#403 (playbook cost contract); independent, composable.

## Technical Context

- **Language**: TypeScript (strict, ESM, Node.js >=22).
- **Package touched**: `@generacy-ai/generacy` (CLI). Cockpit verb internal functions (`runStatus`, `runContext`, `runAdvance`, `runResume`, `runQueue`, `runMerge`) live in `packages/generacy/src/cli/commands/cockpit/` — reused verbatim by tool handlers.
- **New runtime dependency**: `@modelcontextprotocol/sdk` (official SDK, TypeScript, stdio transport). Zero MCP libraries exist in the repo today (grep confirmed); this is the first MCP server we ship.
- **Existing deps used**: `zod` (already at ^3.23.0 in `packages/generacy/package.json`) for tool input schemas — `@modelcontextprotocol/sdk` accepts Zod schemas directly via `zodToJsonSchema`.
- **Event source**: same source as `cockpit watch` — `runOnePoll` from `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts` + `computeTransitions` + `computeAggregateEvents`. Wrapped in an in-process event bus with cursor bookkeeping.
- **Testing**: vitest. New unit tests in `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/`. Parity tests (each tool result deep-equals CLI `--json`) reuse existing status/context/advance/queue/merge/resume test fixtures.
- **No stack.md update** (per CLAUDE.md guidance, plan does not touch `specs/<feature>/stack.md`).

## Project Structure

### Files to add (production)

```
packages/generacy/src/cli/commands/cockpit/mcp/
├── index.ts                    # Command factory (`cockpitMcpCommand()`) — refuses on GENERACY_CLUSTER_ROLE=worker, wires stdio transport
├── server.ts                   # buildMcpServer(deps) — @modelcontextprotocol/sdk Server instance, registers 7 tools
├── tools/
│   ├── cockpit_status.ts       # tool handler → wraps runStatus (JSON envelope path)
│   ├── cockpit_context.ts      # tool handler → wraps runContext
│   ├── cockpit_queue.ts        # tool handler → wraps runQueue
│   ├── cockpit_advance.ts      # tool handler → wraps runAdvance (map CockpitExit → {status:"error",class,detail})
│   ├── cockpit_resume.ts       # tool handler → wraps runResume (same CockpitExit mapping)
│   ├── cockpit_merge.ts        # tool handler → wraps runMerge
│   └── cockpit_await_events.ts # long-poll event tool — cursor bookkeeping, coalesce window, batch cap
├── event-bus.ts                # In-proc event bus — subscribes to poll loop, buffers events with monotonic cursor, retention TTL
├── schemas.ts                  # Zod input schemas for all 7 tools (IssueRefInput, EpicRefInput, GateNameInput, AwaitEventsInput)
├── ref-input.ts                # {owner, repo, number} | string ref normalizer — routes into resolveIssueContext, PR-number-as-issue rejected here
└── errors.ts                   # Typed error result helpers — map thrown Error/CockpitExit into {status:"error", class, detail}
```

### Files to modify

```
packages/generacy/src/cli/commands/cockpit/index.ts    # Register cockpitMcpCommand()
packages/generacy/src/cli/commands/cluster/scaffolder.ts
                                                       # Add GENERACY_CLUSTER_ROLE=orchestrator to orchestrator service env
                                                       # Add GENERACY_CLUSTER_ROLE=worker to worker service env
                                                       # (Both `environment` arrays — matches existing DEPLOYMENT_MODE pattern at ~line 216, 248)
packages/generacy/package.json                         # Add @modelcontextprotocol/sdk dependency
```

### Files to add (tests)

```
packages/generacy/src/cli/commands/cockpit/mcp/__tests__/
├── ref-input.test.ts                     # Ref normalizer: {owner,repo,number} accepted, string forms accepted, PR-number-as-issue rejected (subsumes #906), invalid shapes → schema error
├── server-refuses-worker-role.test.ts    # process.env.GENERACY_CLUSTER_ROLE='worker' → command exits non-zero with role error message (SC-004 path a)
├── event-bus.test.ts                     # cursor monotonicity, verbatim NDJSON bytes, retention TTL discard → next await returns resetFrom:"expired", ordering across resumes
├── await-events-coalesce.test.ts         # 1 event → wait coalesceWindowMs → drain sibling burst → return batch; empty window → maxWaitMs timeout returns empty batch; maxBatchSize soft-cap triggers early close with continuation cursor (Q5)
├── await-events-cursor-classes.test.ts   # malformed cursor → {status:"error",class:"invalid-cursor"}; never-issued cursor → same; expired → {resetFrom:"expired"} silent reset with events from head (Q3-D discriminated behavior)
├── tool-schema-invalid-refs.test.ts      # Each mutation tool rejects PR number as <issue> at schema layer; unknown gate name → typed error result (not exception); FR-014 (b)
├── parity-status.test.ts                 # cockpit_status tool result === renderJsonEnvelope from runStatus fixture (deep-equal)
├── parity-context.test.ts                # cockpit_context tool result === CLI --json fixture
├── parity-advance.test.ts                # cockpit_advance tool result === CLI stdout structured envelope (both happy path and refusal path)
├── parity-resume.test.ts                 # cockpit_resume tool result deep-equal
├── parity-queue.test.ts                  # cockpit_queue tool result deep-equal
└── parity-merge.test.ts                  # cockpit_merge tool result deep-equal
```

### Files to add (scaffolder-adjacent)

```
packages/generacy/src/cli/commands/cluster/__tests__/scaffolder-cluster-role-env.test.ts
                                                       # Compose scaffolder emits GENERACY_CLUSTER_ROLE=orchestrator on orchestrator service
                                                       # AND GENERACY_CLUSTER_ROLE=worker on worker service (both assertions in one test — the pair is the invariant, and mocking Q2 confirms these ship together or not at all)
```

### Companion (out of tree — cluster-base repo)

Not in this PR, tracked as **required companion** in `contracts/entrypoint-registration.md`:

- `cluster-base/entrypoint-orchestrator.sh` — invoke `claude mcp add --scope user cockpit -- generacy cockpit mcp` (or write `~/.claude.json` directly with idempotent overwrite semantics). Emit one log line on reconciliation.
- `cluster-base/entrypoint-worker.sh` — no change (must NOT register the server).

Merge order: this PR (generacy) can land first; the tool is inert until the entrypoint registers it. Cloud-deploy compose generation must ship `GENERACY_CLUSTER_ROLE=*` in lockstep with this scaffolder change — flagged in `contracts/scaffolder-env-var.md` as the known drift hazard from the Q2 clarification.

## Design Decisions (from clarifications)

- **Q1 → B** — Concrete defaults: `maxWaitMs=55000`, `coalesceWindowMs=3000`. Rationale: stdio server on same container, no network keepalive to blow past. 55s halves idle wakeups vs 25s; 3s covers the near-simultaneous sibling clusters at phase boundaries observed on the snappoll ledger. Locked in the SC-006 fixture. Both per-call tunable via `AwaitEventsInput`. Constants exposed as `AWAIT_EVENTS_DEFAULTS` from `schemas.ts` — single source, referenced from Zod defaults and from the fixture assertion.
- **Q2 → A** — New `GENERACY_CLUSTER_ROLE` env var written by the compose scaffolder: `orchestrator` on orchestrator service, `worker` on worker service. `cockpit mcp` refuses to start when `process.env.GENERACY_CLUSTER_ROLE === 'worker'`. Companion cluster-base entrypoint change required — documented drift hazard between scaffolder + cloud-deploy noted in `contracts/scaffolder-env-var.md`.
- **Q3 → D** — Discriminated invalid-cursor handling. Malformed / never-issued cursor → typed error result `{status: "error", class: "invalid-cursor", detail}` (caller-bug class; fail loud). Expired / discarded cursor (server restart, retention TTL exceeded) → silent reset to head with `resetFrom: "expired"` load-bearing signal that events may have been missed. Startup-sweep recovery engages on the `resetFrom` marker.
- **Q4 → A** — Overwrite unconditionally when the entrypoint finds an existing `cockpit` entry whose command differs. Emit one idempotent log line noting the reconciliation. No relay event (no consumer yet). Entrypoint is source of truth; cluster upgrades self-heal invocation-path changes.
- **Q5 → D** — Caller-controlled `maxBatchSize` on `cockpit_await_events`, server default `256`, soft-cap semantics (per Q5 option B). When exceeded, batch closes early (before `coalesceWindowMs`) and returned cursor points at the next undelivered event; caller re-arms immediately. No `truncated` flag — the cursor is the continuation. Ordering + verbatim guarantees intact.

## Implementation Sequence (high-level)

1. **Add `@modelcontextprotocol/sdk`** to `packages/generacy/package.json`. Confirm ESM + Node >=22 compatibility (SDK ships ESM natively).
2. **Ref normalizer + schemas** (`ref-input.ts`, `schemas.ts`). Wire the ref-input primitive into `resolveIssueContext` — the resolver already has the bare-number → cwd-inference path (#850) and qualified-form parsing. Add the PR-number-as-issue guard: when `{owner, repo, number}` resolves to a PR, return a typed `class: "wrong-kind"` error with actionable copy naming `<owner>/<repo>#N` as the issue form.
3. **Errors module** (`errors.ts`). `mapCockpitExitToToolError(exit): ToolErrorResult` — the shared advance/resume `CockpitExit` codes (2 = parse/argument, 3 = gate refusal, 1 = transport) map to distinct `class` values (`invalid-args`, `gate-refusal`, `transport`). Thrown Errors also caught here at the tool-boundary — the internal `run<Verb>()` functions never throw uncaught into the MCP transport (a raw exception would collapse the whole tool call to a JSON-RPC error rather than a typed tool result).
4. **Verb tool handlers** (six files under `tools/`). Each imports the corresponding `run<Verb>()` function from its sibling module and calls it with a capturing stdout/stderr collector; the CLI-side text lines are discarded — the tool result is the *structured* envelope. For `cockpit_status`, invoke `runStatus(...)` with `options.json = true` and parse the single-line JSON envelope written to the captured stdout (already the CLI's JSON contract). For `cockpit_advance` / `cockpit_resume`: `runAdvance` returns `void` and throws `CockpitExit` on refusal — the tool handler catches, maps via `mapCockpitExitToToolError`, and constructs a structured `{status: "ok" | "error", ...}` result body.
5. **Event bus** (`event-bus.ts`). In-process broadcaster subscribed to `runOnePoll`'s output for a given epic. Assigns monotonically-increasing cursor tokens per event. Retention buffer capped (LRU by cursor; default retention TTL ~10 min or 10 000 events, whichever hits first — sized to survive routine agent-side restarts, but not full server restarts, which is the correct fault domain for the `resetFrom: "expired"` reset). Consumers keyed by epic-ref; multiple concurrent `cockpit_await_events` calls against the same epic share the same subscriber.
6. **`cockpit_await_events` tool handler** (`await-events.ts`). Long-poll semantics: check for events at `cursor+1`; if present, drain up to `maxBatchSize` immediately, then wait `coalesceWindowMs` for additional emits, drain again, return. If no events, wait up to `maxWaitMs` for the first emit, then coalesce. Cursor classes handled per Q3-D: `parseCursor(str)` returns `{kind: "valid", position} | {kind: "malformed"} | {kind: "never-issued"}`; expired-vs-discarded distinguished by checking against the buffer's low-watermark. Return shape matches spec: `{events: [...], cursor, resetFrom?}`.
7. **Server builder** (`server.ts`). Instantiates `@modelcontextprotocol/sdk/server` with all seven tools registered. Wires stdio transport.
8. **Command entry** (`index.ts` — `cockpitMcpCommand()`). First-line check: if `process.env.GENERACY_CLUSTER_ROLE === 'worker'`, write role-refusal message to stderr and exit non-zero. Otherwise, build server + connect stdio transport + await.
9. **Register in cockpit command group** (`cockpit/index.ts`). One import + one `addCommand()` line.
10. **Compose scaffolder update** (`cluster/scaffolder.ts` at lines ~213 and ~244). Add `GENERACY_CLUSTER_ROLE=orchestrator` and `GENERACY_CLUSTER_ROLE=worker` respectively to the two services' `environment` arrays. The pair MUST land together — enforced by the scaffolder test.
11. **Parity tests**. For each verb, run the internal function under a controlled fixture (mocked `GhWrapper`) and assert the tool handler's return value deep-equals the CLI's `--json` output on the same fixture. Reuses existing test fixtures wherever possible (see `packages/generacy/src/cli/commands/cockpit/__tests__/`).
12. **Await-events regression tests**. Cursor monotonicity, verbatim NDJSON body bytes (byte-equal to `emit()` output — imported from `watch/emit.ts`), coalesce-window batching, `maxBatchSize` soft-cap, three cursor classes, retention-TTL reset path.

## Files NOT touched (unchanged surfaces)

- `packages/generacy/src/cli/commands/cockpit/watch.ts` — `cockpit watch` NDJSON stays for humans/scripts (spec § Out of scope). New tool uses the same event source but not the same command.
- Any existing `runStatus`/`runContext`/`runAdvance`/`runResume`/`runQueue`/`runMerge` internal function signatures — the tool handlers adapt around them, no refactor to accommodate the new transport.
- `packages/generacy/src/cli/commands/cockpit/resolver.ts` — `parseIssueRef` / `resolveIssueContext` already carry the qualified-form + cwd-inference primitives (#850). Ref normalizer sits *above* them; adds only the PR-kind rejection.
- `agency` playbooks (`auto.md`, `clarify.md`) — migrating them to call the MCP tools is explicit § Out of scope. Follow-up after this ships, written against the frozen tool contract.
- `generacy#913` (gh-shape resolver fixes) — transport-independent, tracked separately.

## Constitution Check

`.specify/memory/constitution.md` does not exist in this repo. CLAUDE.md-derived constraints applied:

- **Single atomic PR** — the branch is one feature: MCP transport for cockpit verbs. Compose scaffolder change is part of the same feature (Q2's `GENERACY_CLUSTER_ROLE` — the env var and the refusal path must ship together).
- **No `stack.md` update from `/plan`** (per #899).
- **Zod-only external validation** — tool inputs validated by Zod schemas; the SDK's `zodToJsonSchema` bridge means the JSON-Schema advertised to Claude is the same shape the tool handler asserts.
- **No new npm deps beyond what's justified** — one new dep (`@modelcontextprotocol/sdk`); no alternative in-repo. Building an MCP server by hand is out of proportion for a v1 that mirrors the CLI 1:1.
- **No hook skipping / no `--no-verify`** — standard PR flow.
- **Fail closed at boundaries** — worker-role refusal (SC-004), invalid-cursor typed error (Q3-D), PR-number-as-issue schema rejection (#906 subsumption).

## Risks

- **@modelcontextprotocol/sdk API drift**: the SDK is young (pre-1.0 at time of writing). Tool registration API has changed in past minor versions. Pin an exact version (`^X.Y.Z` with lockfile) and gate CI on it. Consider committing a small adapter layer so a future SDK bump touches one file.
- **stdio contention** — MCP servers must not write logs to stdout (that's the JSON-RPC channel). All logs from the tool handlers (including any lingering `getLogger()` calls from the wrapped `run<Verb>()` functions) must route to stderr. This is the single most common MCP transport bug; the tool-handler wrappers explicitly redirect the collected stdout/stderr streams — never let the `run<Verb>` functions write directly to `process.stdout`. Enforced by a test that runs a tool handler under mocked `process.stdout.write` and asserts zero calls.
- **Retention TTL sizing** — too small and routine hiccups trigger unnecessary startup sweeps; too large and the server's memory grows unboundedly under a stalled consumer. Chosen defaults (10 min / 10 000 events, whichever comes first) are documented as tunable via env vars (`COCKPIT_MCP_EVENT_RETENTION_MS`, `COCKPIT_MCP_EVENT_RETENTION_COUNT`) — no CLI flag exposure yet (unlike the per-call `maxWaitMs`/`coalesceWindowMs`/`maxBatchSize`, which have per-call knobs).
- **Compose scaffolder drift** — the Q2 clarification names this explicitly: `GENERACY_CLUSTER_ROLE` must land in cloud-deploy's compose generation in lockstep with this repo's scaffolder. Flagged in the contract; a companion issue tracks the cloud-deploy PR.
- **PR-number-as-issue guard cost** — every tool call that takes an `<issue>` now runs an extra `gh api /repos/{owner}/{repo}/issues/{n}` shape-check to distinguish issue from PR. `resolveIssueContext` today does not do this classification. Options: (a) always resolve then check `pull_request` field on the API response, (b) require the caller to distinguish at schema time via a discriminated `{kind: "issue" | "pr"}` — v1 uses (a) for CLI parity and defers (b) to the "migrate playbooks to MCP" follow-up (agency after ship).

## Key Sources / References

- Spec: `specs/917-improvement-spec-from-cockpit/spec.md`
- Clarifications: `specs/917-improvement-spec-from-cockpit/clarifications.md`
- CLI cockpit verb group: `packages/generacy/src/cli/commands/cockpit/index.ts`
- Cockpit resolver (bare-number + qualified forms + PR-number guard base): `packages/generacy/src/cli/commands/cockpit/resolver.ts` (#850)
- Compose scaffolder (env var landing site): `packages/generacy/src/cli/commands/cluster/scaffolder.ts:206-265`
- Watch event source (used by `cockpit_await_events`): `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts` + `emit.ts` + `aggregate-emit.ts` + `stream-event.ts`
- Gate vocabulary (for `cockpit_advance` / `cockpit_resume` tool schemas): `packages/generacy/src/cli/commands/cockpit/gate-vocabulary.ts`
- Companion agency issue: `agency#403` (playbook cost contract)
- Related resolver work: generacy#906 (bare PR number as issue), generacy#850 (bare-number acceptance), generacy#822 (resolveIssueContext adoption)
- Snappoll data source: generacy-ai/tetrad-development#92 (run-7 ledger)
- MCP SDK: `@modelcontextprotocol/sdk` (TypeScript, official) — https://modelcontextprotocol.io

## Next Step

`/speckit:tasks` to generate the ordered task list from this plan.
