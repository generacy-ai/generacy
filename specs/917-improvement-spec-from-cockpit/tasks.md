# Tasks: `generacy cockpit mcp` — stdio MCP server for cockpit verbs

**Input**: Design documents from `/specs/917-improvement-spec-from-cockpit/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/mcp-tools.md, contracts/entrypoint-registration.md, contracts/scaffolder-env-var.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = single feature — MCP transport for cockpit verbs)

## Phase 1: Setup

- [X] T001 [US1] Add `@modelcontextprotocol/sdk` dependency to `packages/generacy/package.json` (pin exact version; ensure ESM + Node >=22 compat). Run `pnpm install` to lockfile.
- [X] T002 [US1] Create directory `packages/generacy/src/cli/commands/cockpit/mcp/` and `packages/generacy/src/cli/commands/cockpit/mcp/tools/` (empty scaffolding — files land in Phase 3+).

## Phase 2: Core Primitives

- [X] T003 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts` — `ToolOkResult<T>`, `ToolErrorResult`, `ToolResult<T>`, `ErrorClass` union (per data-model.md § Tool result envelope). Implement `mapCockpitExitToToolError(exit): ToolErrorResult` mapping `CockpitExit.code` 1→`transport`, 2→`invalid-args`, 3→`gate-refusal`. Include a `wrapToolBoundary(fn)` helper that catches thrown `Error` (including `CockpitExit`) and returns `{status: "error", class: "internal" | mapped, detail}` so the MCP transport never receives an uncaught throw.
- [X] T004 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts` — Zod schemas: `IssueRefInputSchema` (object|string union), `EpicRefInputSchema` (alias), `GateNameInputSchema` (built from `listGates()` in `../gate-vocabulary.ts`), `AwaitEventsInputSchema`, plus `AWAIT_EVENTS_DEFAULTS` frozen constant (`maxWaitMs=55000`, `coalesceWindowMs=3000`, `maxBatchSize=256`). Exports referenced from Zod defaults AND the SC-006 fixture.
- [X] T005 [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/ref-input.ts` — `normalizeIssueRef(input, gh)`: object form validates via `IssueRefObject`, string form passes through `resolveIssueContext({issue: str})` (inherits bare-number cwd-inference from #850). Adds PR-kind check: `gh api /repos/{owner}/{repo}/issues/{n}`; if `pull_request` field present and tool requires an issue, return `{status: "error", class: "wrong-kind", detail}`. Depends on T004 (schemas).

## Phase 3: Verb Tool Handlers

- [X] T006 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_status.ts` — wraps `runStatus` with `{json: true}` + captured stdout sink. Parses the single-line JSON envelope from captured stdout, returns as `data`. Uses `errors.ts` `wrapToolBoundary`. Depends on T003, T004, T005.
- [X] T007 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_context.ts` — wraps `runContext` with `{json: true}` + captured stdout sink. Depends on T003, T004, T005.
- [X] T008 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_advance.ts` — wraps `runAdvance`; catches `CockpitExit` and maps via `mapCockpitExitToToolError`; idempotent no-op (`advance.ts:122-127`) returned as `{status: "ok", data: {..., noop: true, action: "already-advanced"}}`. Depends on T003, T004, T005.
- [X] T009 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_resume.ts` — wraps `runResume`; same `CockpitExit` mapping; non-failed issue no-op returns `{status: "ok", data: {action: "no-op", targetPhase: null, precedingGate: null, labelsAdded: [], labelsRemoved: []}}`. Depends on T003, T004, T005.
- [X] T010 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_queue.ts` — wraps `runQueue`; MCP path skips the CLI confirmation gate (agents don't type "y"). Depends on T003, T004, T005.
- [X] T011 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_merge.ts` — wraps `runMerge`; accepts `pr` ref (inverts issue-kind check: an issue-number-as-pr → `{class: "wrong-kind"}`). Depends on T003, T004, T005.

## Phase 4: Event Bus + `cockpit_await_events`

- [X] T012 [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts` — `EpicEventBus` class: monotonic cursor allocation (starts at 1; 0 reserved for "never issued"), LRU buffer capped by `retentionCount` (default 10 000, env `COCKPIT_MCP_EVENT_RETENTION_COUNT`) AND `retentionMs` (default 600 000, env `COCKPIT_MCP_EVENT_RETENTION_MS`). Methods: `emit(event)`, `waitFor({sinceCursor, maxWaitMs, coalesceWindowMs, maxBatchSize})`, `parseCursor(str)` → `CursorParseResult` (`valid | expired | malformed | never-issued | wrong-epic`). Base64-encoded `{epic, position}` JSON cursor. Depends on T004.
- [X] T013 [US1] Wire `EpicEventBus` to the poll loop — subscribe to `runOnePoll` output for the given epic; append every `CockpitStreamEvent` (`watch/emit.ts` + `watch/aggregate-emit.ts` + `watch/stream-event.ts`) via `emit()`. Per-orchestrator-process singleton keyed by epic ref (multiple concurrent `cockpit_await_events` callers share the subscriber). New file `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` or inline in `event-bus.ts`. Depends on T012.
- [X] T014 [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_await_events.ts` — long-poll tool handler implementing the batching algorithm in data-model.md § Batching algorithm: parseCursor → dispatch on cursor class (Q3-D discriminated behavior); drain up to `maxBatchSize`; wait `maxWaitMs` if empty; coalesce `coalesceWindowMs` after first event; soft-cap early close returns continuation cursor. Depends on T003, T004, T012, T013.

## Phase 5: Server + Command Registration

- [X] T015 [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/server.ts` — `buildMcpServer(deps)` returns `@modelcontextprotocol/sdk` `Server` instance with all seven tools registered via `zodToJsonSchema`. Depends on T006–T011, T014.
- [X] T016 [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/index.ts` — `cockpitMcpCommand()` Commander factory. First-line worker-role refusal: if `process.env.GENERACY_CLUSTER_ROLE === 'worker'`, write role-refusal message to stderr (substring `GENERACY_CLUSTER_ROLE=worker`) and `process.exit(2)`. Otherwise build server + connect stdio transport + await. Depends on T015.
- [X] T017 [US1] Modify `packages/generacy/src/cli/commands/cockpit/index.ts` — import `cockpitMcpCommand` and `addCommand` on the cockpit command group. One import + one line. Depends on T016.

## Phase 6: Compose Scaffolder Env Var

- [X] T018 [US1] Modify `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — add `'GENERACY_CLUSTER_ROLE=orchestrator'` to orchestrator service `environment` array (~line 213) AND `'GENERACY_CLUSTER_ROLE=worker'` to worker service `environment` array (~line 244). Both edits in the same commit — the pair is the invariant.

## Phase 7: Regression Tests

- [X] T019 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/ref-input.test.ts` — object form accepted, string forms (bare number, `owner/repo#N`, URL) accepted, PR-number-as-issue rejected with `{class: "wrong-kind"}` (subsumes #906), malformed shapes → `{class: "invalid-args"}`.
- [X] T020 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/server-refuses-worker-role.test.ts` — `process.env.GENERACY_CLUSTER_ROLE='worker'` → command exits non-zero with role-refusal message on stderr (substring `GENERACY_CLUSTER_ROLE=worker`). Second block: `='orchestrator'` under mocked stdio transport → no exit; server enters wait loop.
- [X] T021 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/event-bus.test.ts` — cursor monotonicity, verbatim NDJSON body bytes (structurally-equal to `watch/emit.ts` output), retention TTL discard, ordering across cursor resumes.
- [X] T022 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/await-events-coalesce.test.ts` — 1 event → wait `coalesceWindowMs` → drain sibling burst → return batch; empty window → `maxWaitMs` timeout returns empty batch with same cursor; `maxBatchSize` soft-cap triggers early close with continuation cursor pointing at next undelivered event (Q5). Also asserts `AWAIT_EVENTS_DEFAULTS` values (SC-006 fixture: `55000`/`3000`/`256`).
- [X] T023 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/await-events-cursor-classes.test.ts` — malformed cursor → `{class: "invalid-cursor"}`; never-issued cursor → `{class: "invalid-cursor"}`; wrong-epic cursor → `{class: "invalid-cursor"}`; expired cursor → `{resetFrom: "expired"}` silent reset with events from head (Q3-D discriminated behavior).
- [X] T024 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/tool-schema-invalid-refs.test.ts` — each mutation tool rejects PR number as `<issue>` at the schema / normalizer layer; unknown gate name → `{class: "unknown-gate"}` typed error (not exception).
- [X] T025 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-status.test.ts` — under a fixture, `cockpit_status` tool result deep-equals `renderJsonEnvelope(...)` output from `runStatus`.
- [X] T026 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-context.test.ts` — `cockpit_context` tool result deep-equals CLI `--json` fixture.
- [X] T027 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-advance.test.ts` — `cockpit_advance` tool result deep-equals CLI stdout structured envelope on both happy path and refusal path.
- [X] T028 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-resume.test.ts` — `cockpit_resume` tool result deep-equals CLI `--json` fixture.
- [X] T029 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-queue.test.ts` — `cockpit_queue` tool result deep-equals CLI `--json` fixture.
- [X] T030 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-merge.test.ts` — `cockpit_merge` tool result deep-equals CLI `--json` fixture.
- [X] T031 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/stdout-cleanliness.test.ts` — each tool handler runs under mocked `process.stdout.write` spy; asserts zero direct calls (all `run<Verb>()`-emitted stdout must be captured by the per-call sink, never leaked to the JSON-RPC channel). Guards the single most-common MCP transport bug.
- [X] T032 [P] [US1] Create `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder-cluster-role-env.test.ts` — asserts `scaffoldDockerCompose()` output contains `GENERACY_CLUSTER_ROLE=orchestrator` on orchestrator service AND `GENERACY_CLUSTER_ROLE=worker` on worker service. Both assertions in the same test — the pair is the invariant.

## Dependencies & Execution Order

**Setup gates everything**:
- T001 (add dep) and T002 (scaffold dirs) must land first.

**Phase 2 (core primitives) unblocks Phase 3+**:
- T003 (errors), T004 (schemas) can run in parallel — different files.
- T005 (ref-input) depends on T004 only.

**Phase 3 (verb tool handlers) is fully parallel**:
- T006–T011 all depend on T003, T004, T005 but are independent of each other (different files, one file per tool).

**Phase 4 (event bus) is sequential within**:
- T012 → T013 → T014 (each builds on prior).
- T012 depends on T004 (schemas) only, so it can run alongside Phase 3.

**Phase 5 (server + command) is sequential and gates the CLI wire-up**:
- T015 requires all seven tool files (T006–T011, T014).
- T016 requires T015.
- T017 requires T016.

**Phase 6 (scaffolder) is independent**:
- T018 shares no files with Phases 1–5; can land any time after T002.

**Phase 7 (tests) is fully parallel across the tree**:
- T019 depends on T005.
- T020 depends on T016.
- T021–T023 depend on T012–T014.
- T024 depends on T004 (and its consumers T006–T011).
- T025–T030 (parity tests) depend on the corresponding tool handler (T006–T011).
- T031 depends on all tool handlers.
- T032 depends on T018.
- All test files touch different paths — parallel-safe.

**Critical path** (longest sequential chain):
T001 → T002 → T004 → T005 → T006 → T015 → T016 → T017 (≈ 8 tasks). Everything else parallelizes.

## Grouping Strategy for Issue Creation

Default: `per-story` grouping. This entire tasklist is a single feature (`US1`) shipping in one PR (per plan.md Constitution Check: "Single atomic PR"). Do not split into sub-issues via `epic-grouping:per-task` unless the ship is explicitly re-scoped.

## Next Step

`/speckit:implement` to begin execution.
