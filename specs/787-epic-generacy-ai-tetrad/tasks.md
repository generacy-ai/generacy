# Tasks: `generacy cockpit watch` + `generacy cockpit status`

**Input**: Design documents from `/specs/787-epic-generacy-ai-tetrad/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/cli-flags.md, contracts/cockpit-event.schema.json, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to — single story (US1: operator monitors epic state via cockpit verbs)

## Phase 1: Setup

- [ ] T001 [US1] Add `chalk@^5` and `@generacy-ai/cockpit` (workspace:*) to `packages/generacy/package.json` `dependencies`; run `pnpm install` to update the lockfile.
- [ ] T002 [P] [US1] Create empty directory skeleton under `packages/generacy/src/cli/commands/cockpit/` with subfolders `shared/`, `watch/`, `status/`, `__tests__/` (touch `.gitkeep` or first file per folder so the structure exists before T010+).

## Phase 2: Foundation — `@generacy-ai/cockpit` cross-issue additions

These three foundation tasks unblock every cockpit verb task. Per plan D11 / R5, whichever PR (#787 or #789) lands first owns these additions. If they already exist on `develop` when this branch rebases, skip T010–T012 and proceed.

- [ ] T010 [US1] In `packages/cockpit/src/gh/wrapper.ts`, add `PullRequestSummary` interface and the two methods on `GhWrapper` / `GhCliWrapper`: `resolveIssueToPR(repo, issueNumber): Promise<number | null>` (shells `gh issue view --json closedByPullRequestsReferences,timelineItems`) and `getPullRequest(repo, prNumber): Promise<PullRequestSummary>` (shells `gh pr view --json state,mergedAt,closedAt,url,isDraft,labels`). Also add `createdAt: string` (ISO 8601) to the existing `Issue` shape and update its zod parser (per R4 sub-decision).
- [ ] T011 [US1] In `packages/cockpit/src/index.ts`, re-export `PullRequestSummary` and ensure `GhWrapper`/`Issue` updated surface is exported.
- [ ] T012 [P] [US1] In `packages/cockpit/src/gh/__tests__/wrapper.test.ts` (or a new sibling file matching the existing per-method convention), add tests covering: `resolveIssueToPR` returns the first linked PR / `null` when none, `getPullRequest` parses `state`/`mergedAt`/`closedAt`/`isDraft`/`labels` correctly, and `Issue.createdAt` round-trips through the zod parser.

## Phase 3: Shared modules (used by both verbs)

All five `shared/*` modules are independent files — every task here is `[P]` against the others in this phase, but each depends on T010–T012.

- [ ] T020 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/shared/scoping.ts` implementing `resolveScope({ epic, config, gh })` per plan D10. Parse `--epic owner/repo#NNN` with the documented regex; reject malformed input with `Error("--epic must be owner/repo#NNN")`; on success call foundation `resolveEpicIssues`; without `--epic` return `{ kind: 'repos', repos: config.repos }`.
- [ ] T021 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/shared/pagination.ts` implementing `listAllIssues(gh, query, opts)` per plan D6 / R4. Loop with `pageSize` default 100, advance via `created:<ISO` cursor predicate, stop when page < limit, warn once to stderr per cycle when cumulative results exceed `safetyCap` (default 1000).
- [ ] T022 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/shared/classify-issue.ts` — thin wrapper over foundation `classify(labels)` that always returns `{ state, sourceLabel, labels }` (never `undefined`); collapses the foundation's `ClassifyResult` shape into the snapshot type's needs.
- [ ] T023 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/shared/pr-link.ts` exporting `extractPrUrl(issue): string | null` — pulls the first linked PR URL from issue body/timeline; used by `status`'s row builder when `kind === 'issue'`.
- [ ] T024 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/shared/orchestrator-footer.ts` implementing `getFooter(client, timeoutMs = 1500)` per plan D9 / R6. Race `client.getJobs()` + `client.getWorkers()` against `setTimeout`; on any failure return `{ available: false, reason }`; never throws.

## Phase 4: `watch` implementation (pure-function pipeline)

T030–T035 are pure modules; mostly parallel. T036 (`watch.ts`) is the shell that imports all of them and the shared modules — it depends on the entire phase.

- [ ] T030 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts` defining `IssueSnapshot`, `PrSnapshot`, `SnapshotKey` (`${repo}#${kind}#${number}`), `SnapshotMap`, plus builder helpers `buildIssueSnapshot(issue, classified)` and `buildPrSnapshot(issue, classified, lifecycle, rollup)` (data-model §"Internal snapshot types").
- [ ] T031 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/watch/check-rollup.ts` exporting `rollup(checks): 'pending' | 'success' | 'failure'` per plan D4 (success iff every check is SUCCESS/NEUTRAL/SKIPPED; failure iff any FAILURE/CANCELLED; empty → pending).
- [ ] T032 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/watch/pr-state.ts` exporting `derivePrLifecycle(prev, issue, getPullRequest)` per plan D5 — derives `'open' | 'closed' | 'merged'`, calls `getPullRequest` only when state flipped to CLOSED since `prev`.
- [ ] T033 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` exporting `computeTransitions(prev, curr): CockpitEvent[]` per data-model §`computeTransitions`. Implements precedence: `label-change` → lifecycle (`issue-closed`/`pr-merged`/`pr-closed`) → `pr-checks`. Skip first-poll baseline (R9).
- [ ] T034 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/watch/emit.ts` exporting `emit(event: CockpitEvent): void` per plan D7. Run `CockpitEventSchema.parse(event)` (zod), then `process.stdout.write(JSON.stringify(parsed) + '\n')`. Also export `CockpitEventSchema` mirroring `contracts/cockpit-event.schema.json`.
- [ ] T035 [US1] Create `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts` exporting `runOnePoll(prev, deps): Promise<{ curr, events }>` per plan D2. Pure function: orchestrates `listAllIssues` → `classify` per item → build snapshot per `kind` (issue vs PR via URL match per R8) → `getPullRequestCheckRuns` for PRs → `rollup` → `computeTransitions`. Depends on T020–T024, T030–T034.
- [ ] T036 [US1] Create `packages/generacy/src/cli/commands/cockpit/watch.ts` — Commander action handler. Builds `Command` with `--epic`, `--repos`, `--interval`, `--safety-cap` flags (defaults per data-model `WatchOptions` + cli-flags contract). Wires SIGINT → `stopped = true`, runs the `while (!stopped) { runOnePoll → emit each → sleep(interval) }` shell, prints startup banner to stderr (R9). Maps exit codes per cli-flags §"Exit codes". Depends on T035.

## Phase 5: `status` implementation

T040–T043 are pure modules and parallel. T044 (`status.ts`) is the shell.

- [ ] T040 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/status/color.ts` exporting `STATE_COLOR: Record<CockpitState, ChalkFn>` per data-model §"Color map" and a `Colorizer` interface with an `identity` no-op implementation for non-TTY mode (plan D8).
- [ ] T041 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/status/row.ts` exporting `buildStatusRow(issue, prNumber, checks): StatusRow` per data-model `StatusRow`.
- [ ] T042 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/status/group.ts` exporting `groupRows(rows, scope)` per R7 — epic mode groups by phase (when manifest declares phases) or flat by issue number; repos mode groups by repo with header row per repo.
- [ ] T043 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/status/render-table.ts` exporting `renderTable(rows, { tty, json, colorizer })` per data-model §"Table-render contract". `padEnd`/`padStart` column widths exactly as specified (repo 20, number 5, state 8, sourceLabel 30, prNumber 5, checks 8, title 60 truncated with `…`). Apply `colorizer` to `state` column only. When `json: true`, return single-line `JSON.stringify({ rows, orchestrator })` envelope.
- [ ] T044 [US1] Create `packages/generacy/src/cli/commands/cockpit/status.ts` — Commander action handler. Flags `--epic`, `--repos`, `--json` per cli-flags contract. Calls `loadCockpitConfig` → `resolveScope` → `listAllIssues` per repo → resolves PR per row (`resolveIssueToPR` when `kind: issue`) → `getPullRequestCheckRuns` + `rollup` → `groupRows` → `getFooter` → `renderTable`. Depends on T020–T024, T031 (rollup), T040–T043.

## Phase 6: Wire-up

- [ ] T050 [US1] Create `packages/generacy/src/cli/commands/cockpit/index.ts` exporting `cockpitCommand()` that returns a Commander `Command('cockpit')` with `.addCommand(watchCommand()).addCommand(statusCommand())` per plan D1. Imports T036 (`watch`) and T044 (`status`).
- [ ] T051 [US1] In `packages/generacy/src/cli/index.ts`, add a single line: `program.addCommand(cockpitCommand());` next to existing command registrations. Verify `generacy cockpit --help`, `generacy cockpit watch --help`, `generacy cockpit status --help` all render.

## Phase 7: Tests

Test files are independent and `[P]` against each other. They depend on the modules they cover (listed inline). Place all under `packages/generacy/src/cli/commands/cockpit/__tests__/`.

- [ ] T060 [P] [US1] `watch.diff.test.ts` — fixtures for each transition branch in `computeTransitions`: label-change, issue-closed, pr-merged, pr-closed, pr-checks (PENDING↔SUCCESS↔FAILURE), simultaneous transitions in precedence order, first-poll baseline emits nothing. Covers T033.
- [ ] T061 [P] [US1] `watch.poll-loop.test.ts` — inject fake `GhWrapper` returning scripted payloads across 2 cycles; assert `runOnePoll` returns expected `events[]` and updated `curr` map. Covers T035.
- [ ] T062 [P] [US1] `watch.no-mutations.test.ts` — strict-mode `CommandRunner` that throws on any `gh issue edit` or `gh pr edit`; run a full poll cycle and assert no throw. Regression catcher for "sensor invariant" (plan D2 / data-model invariants).
- [ ] T063 [P] [US1] `watch.epic-walk.test.ts` — SC-002 integration. Load `__tests__/fixtures/phase-walk.json` (10 sequential poll-response payloads per R10); assert the 10 transitions sum to the full phase walk `pending → plan → waiting-for:plan-review → … → terminal`.
- [ ] T064 [P] [US1] `watch.pagination.test.ts` — paginate-to-completeness (3 pages of 100, 1 page of 47); safety-cap warn emits exactly once to stderr on overflow but pagination continues. Covers T021.
- [ ] T065 [P] [US1] `watch.emit.test.ts` — for each event variant, build a `CockpitEvent`, assert `CockpitEventSchema.parse(event)` succeeds and that `emit` writes exactly one `\n`-terminated line through a stubbed `stdout`. Covers T034.
- [ ] T066 [P] [US1] `watch.check-rollup.test.ts` — all combinations of `CheckRunSummary[]` conclusions, empty array → pending, mixed FAILURE+SUCCESS → failure. Covers T031.
- [ ] T067 [P] [US1] `status.render.test.ts` — non-TTY plain path (string equality) per data-model §"Table-render contract"; `--json` branch emits valid single-line JSON parseable as `StatusEnvelope`. Covers T043.
- [ ] T068 [P] [US1] `status.color.test.ts` — TTY-on path uses correct chalk fn per state via a sentinel-wrapping mock (no real chalk dep). Asserts color applied to state column only. Covers T040.
- [ ] T069 [P] [US1] `status.footer.test.ts` — orchestrator stub mode renders `"orchestrator: (no token; set ORCHESTRATOR_API_TOKEN to enable)"`; timeout renders `"(unavailable — timeout)"`; happy path renders `"orchestrator: <N> jobs, <M> workers"`. Covers T024.
- [ ] T070 [P] [US1] `shared.scoping.test.ts` — `--epic` present (well-formed → resolves; malformed `tetrad-development#85` / `#85` → throws); absent → falls back to `config.repos`. Covers T020.

## Dependencies & Execution Order

**Phase-level**:
1. **Phase 1 → Phase 2 → Phase 3** (sequential — deps, then foundation surface, then shared modules consuming it).
2. **Phase 3 → Phase 4 + Phase 5** (parallel — watch and status share zero files after the `shared/` layer).
3. **Phase 4 + Phase 5 → Phase 6** (wire-up needs both verb handlers).
4. **Phase 7** (tests) can run alongside Phases 4 / 5 / 6 — each test file depends only on its target module(s).

**Critical path** (minimum serial chain): T001 → T010 → T035 → T036 → T050 → T051 (~6 task widths). Everything else parallelizes.

**Parallel opportunities**:
- Phase 3: all five `shared/*` modules (T020–T024).
- Phase 4 internals: T030–T034 in parallel; T035 + T036 serial after.
- Phase 5 internals: T040–T043 in parallel; T044 serial after.
- Phase 7: all eleven test files (T060–T070) parallel.
- Phase 4 ⫽ Phase 5 entirely.

**Cross-package isolation** (SC-002 invariant): the only files that may be touched outside `packages/generacy/src/cli/commands/cockpit/` are `packages/generacy/src/cli/index.ts` (T051, one-line registration), `packages/generacy/package.json` (T001, chalk dep), `packages/cockpit/src/gh/wrapper.ts` (T010), `packages/cockpit/src/gh/__tests__/wrapper.test.ts` (T012), and `packages/cockpit/src/index.ts` (T011). A pre-PR `git diff --name-only` check should enforce this.

---

**Total**: 26 tasks (T001–T002 setup, T010–T012 foundation, T020–T024 shared, T030–T036 watch, T040–T044 status, T050–T051 wire-up, T060–T070 tests).

Next step: `/speckit:implement` to begin execution.
