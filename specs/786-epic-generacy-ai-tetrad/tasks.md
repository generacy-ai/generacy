# Tasks: @generacy-ai/cockpit engine foundation package

**Input**: Design documents from `/specs/786-epic-generacy-ai-tetrad/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 classifier, US2 manifest+scoping, US3 config loader, US4 orchestrator client)

---

## Phase 1: Setup

- [X] T001 Create `packages/cockpit/package.json` declaring `@generacy-ai/cockpit` (ESM, Node >=22, scripts `build`/`test`/`lint`, deps: `zod`, `yaml`, `@generacy-ai/workflow-engine`, `@generacy-ai/config`; devDeps: `typescript`, `vitest`, `@types/node`). Mirror `packages/credhelper/package.json` shape.
- [X] T002 [P] Create `packages/cockpit/tsconfig.json` (ES2022, NodeNext modules, strict, `outDir: dist`, `rootDir: src`) mirroring `packages/credhelper/tsconfig.json`.
- [X] T003 [P] Create `packages/cockpit/vitest.config.ts` with `test: { globals: true, environment: 'node', include: ['src/**/__tests__/**/*.test.ts'] }` mirroring credhelper.
- [X] T004 Verify pnpm workspace picks up the new package (`pnpm-workspace.yaml` already globs `packages/*` — run `pnpm install` and confirm `@generacy-ai/cockpit` appears in `pnpm list --filter @generacy-ai/cockpit`). Adjust workspace config only if not auto-discovered.

---

## Phase 2: Foundation (shared types)

<!-- Blocks every US phase — all classifier/config/manifest/client modules import from types.ts -->

- [X] T005 Create `packages/cockpit/src/types.ts` exporting `COCKPIT_STATES` tuple (`['pending','active','waiting','error','terminal','unknown']`), `CockpitState` string-literal union, and `ClassifyResult` interface (`{ state: CockpitState; sourceLabel: string }`). Per `data-model.md` §"Curated state".

---

## Phase 3: User Story 1 — Classifier (US1)

### Implementation

- [X] T006 [P] [US1] Create `packages/cockpit/src/state/precedence.ts` exporting `TIER_RANK: Record<CockpitState, number>` (terminal=0, error=1, waiting=2, active=3, pending=4, unknown=5), `WAITING_PIPELINE_ORDER: string[]` (6 gates in `spec-review → clarification → plan-review → tasks-review → implementation-review → manual-validation` order), and `compareSourceLabels(a, b, tier)` returning negative when `a` wins. Per plan.md §D3.
- [X] T007 [P] [US1] Create `packages/cockpit/src/state/label-map.ts` exporting `mapLabelToState(label: string): CockpitState` per the rules in plan.md §D2 (closed/`completed:epic-approval`/`completed:children-complete` → terminal; other `completed:*` → terminal; `failed:*`/`agent:error` → error; `waiting-for:*`/`needs:*` → waiting; `phase:*`/`agent:in-progress`/`agent:dispatched` → active; `agent:paused`/remaining type-process-workflow labels → pending). Build the lookup table once at module load by iterating `WORKFLOW_LABELS` from `@generacy-ai/workflow-engine`.
- [X] T008 [US1] Create `packages/cockpit/src/state/classifier.ts` exporting `classify(labels: Iterable<string>): ClassifyResult`. Walk inputs, call `mapLabelToState`, skip `unknown`, reduce by `TIER_RANK` then `compareSourceLabels`. Returns `{ state: 'unknown', sourceLabel: '' }` when input has no known labels. Depends on T005, T006, T007.

### Tests

- [X] T009 [P] [US1] Create `packages/cockpit/src/__tests__/classifier.test.ts` covering: (a) one case per `CockpitState` tier, (b) precedence (terminal > error > waiting > active > pending), (c) `waiting` tie-break via `WAITING_PIPELINE_ORDER`, (d) non-`waiting` tie-break via `WORKFLOW_LABELS` index, (e) SC-001 static check — iterate `WORKFLOW_LABELS` asserting every entry yields a non-`unknown` `state` and populated `sourceLabel`, (f) empty/unknown-only input → `unknown` with empty `sourceLabel`.

---

## Phase 4: User Story 2 — Manifest + scoping (US2)

### Implementation

- [X] T010 [P] [US2] Create `packages/cockpit/src/manifest/schema.ts` exporting `EpicEntrySchema`, `PhaseEntrySchema`, `EpicManifestSchema` (Zod) and `EpicManifest` type per `data-model.md` §"Epic manifest schema". Validate `epic.repo` and `phases[*].repos` entries against `/^[^/]+\/[^/]+$/`, `phases[*].issues` against `/^[^/]+\/[^/]+#\d+$/`.
- [X] T011 [US2] Create `packages/cockpit/src/manifest/io.ts` exporting `readManifest(path)` (returns `null` on ENOENT, throws on malformed YAML/schema), `writeManifest(path, manifest)` (atomic via `<path>.tmp` + `fs.rename`), and `appendChildIssue(path, phaseName, issue)` (idempotent, touches only target phase's `issues` array). Use `yaml` package. Depends on T010.
- [X] T012 [US2] Create `packages/cockpit/src/manifest/scoping.ts` exporting `resolveEpicIssues(epic: number, owner: string, repo: string, opts?: { manifestRoot?: string; gh?: GhWrapper }): Promise<number[]>` per plan.md §D5. Steps: (1) glob `${manifestRoot ?? cwd + '/.generacy/epics'}/*.yaml`, parse each, return union of `phases[*].issues` matching `owner/repo` when `epic.issue === epic`; (2) fallback to two `gh` queries via injected wrapper (`epic-child` label + body-ref); dedupe and return numbers. Depends on T010, T011 (read path) and Phase 5 `GhWrapper` interface (forward-declare via type import only — concrete `gh/wrapper.ts` lands in T015).

### Tests

- [X] T013 [P] [US2] Create `packages/cockpit/src/__tests__/manifest-io.test.ts` covering: round-trip read→write→read, `readManifest` returns `null` on missing file, throws on malformed YAML, throws on schema violation, `appendChildIssue` adds entry once (idempotent re-call is a no-op), `appendChildIssue` only touches target phase. Use tmpdir for fixtures.
- [X] T014 [P] [US2] Create `packages/cockpit/src/__tests__/manifest-scoping.test.ts` covering SC-004: (a) manifest-hit branch — fixture manifest with `epic.issue === N` returns union of phases[*].issues filtered to `owner/repo`; (b) manifest-miss branch — empty `manifestRoot` falls back to injected mock `gh` returning labeled issues; (c) dedupe across both `gh` queries; (d) ordering deterministic. Include `packages/cockpit/src/__tests__/fixtures/epic-cockpit.yaml` reference fixture.

---

## Phase 5: User Story 3 — Config loader (US3)

### Implementation

- [X] T015 [P] [US3] Create `packages/cockpit/src/config/schema.ts` exporting `CockpitConfigSchema` (Zod) per `data-model.md` §"Config schema" — `owner` optional string, `repos` array of `owner/repo` strings (default `[]`), `orchestrator: { baseUrl? URL, token? string }` (default `{}`). Export `CockpitConfig` and `LoadedCockpitConfig` types.
- [X] T016 [US3] Create `packages/cockpit/src/config/loader.ts` exporting `loadCockpitConfig(opts?: { cwd?; env?; whoami?; logger? }): Promise<LoadedCockpitConfig>` per plan.md §D8: call `findWorkspaceConfigPath()` from `@generacy-ai/config`, read YAML manually (non-throwing on absent `cockpit:` block), validate `cockpit` sub-key with `CockpitConfigSchema` (throws on malformed). Apply defaults: `owner` from explicit > `whoami` (parses `gh auth status`) > undefined; `repos` from `cockpit.repos` > parsed `MONITORED_REPOS` env (split-on-comma + trim + regex-validate) > `[]` with warn-log; `orchestrator.token` from explicit > `ORCHESTRATOR_API_TOKEN` env; `orchestrator.baseUrl` from explicit > `ORCHESTRATOR_URL` env > `http://127.0.0.1:3100`. Return `{ config, source, warnings }`. Depends on T015.

### Tests

- [X] T017 [P] [US3] Create `packages/cockpit/src/__tests__/config-loader.test.ts` covering SC-003 + the 4 loader scenarios from spec.md US3 AC: (a) full config present, (b) partial config (only `repos` set, `owner` derived from `whoami` mock), (c) missing/empty config — `repos: []` + warn entry + does not throw, (d) malformed config (bad YAML or wrong type in `cockpit:` block) → throws with Zod issue. Plus: `MONITORED_REPOS` env fallback applied when `cockpit.repos` absent. Include fixture YAML files under `packages/cockpit/src/__tests__/fixtures/config-samples/`.

---

## Phase 6: User Story 4 — Orchestrator client + gh wrapper (US4)

### Implementation

- [X] T018 [P] [US4] Create `packages/cockpit/src/gh/command-runner.ts` exporting `CommandRunner` type (`(cmd, args, opts?) => Promise<{stdout, stderr, exitCode}>`) and a default `nodeChildProcessRunner` implementation using `node:child_process`. No top-level execution; pure module per plan.md §D6.
- [X] T019 [US4] Create `packages/cockpit/src/gh/wrapper.ts` exporting `GhCliWrapper` class (constructor DI for `CommandRunner`), `GhWrapper` interface, `Issue` and `CheckRunSummary` types per `data-model.md` §"gh wrapper data shapes". Methods: `listIssues(query, opts?)` (uses `gh issue list --json …`), `addLabels(repo, issue, labels)` and `removeLabels(repo, issue, labels)` (uses `gh issue edit`), `getPullRequestCheckRuns(repo, prNumber)` (uses `gh pr checks --json …`). Validate JSON output with Zod and throw descriptive errors on shape mismatch. Depends on T018.
- [X] T020 [P] [US4] Create `packages/cockpit/src/orchestrator/http.ts` exporting a `NativeHttpClient` (near-copy of `packages/activation-client/src/client.ts` adapted for GET) using `node:http`/`node:https`. No new HTTP deps.
- [X] T021 [P] [US4] Create `packages/cockpit/src/orchestrator/stub.ts` exporting `createStubOrchestratorClient()` returning an `OrchestratorClient` where `isAvailable()` returns `false` and every async method resolves to `{ available: false, reason: 'no-token' }`. Never throws.
- [X] T022 [US4] Create `packages/cockpit/src/orchestrator/client.ts` exporting `OrchestratorClient` interface, result envelopes (`HealthResult`, `JobsResult`, `WorkersResult`, `JobSummary`, `WorkerSummary`) per `data-model.md` §"Orchestrator client shapes", and `createOrchestratorClient(config)` factory per plan.md §D7. Factory: when `config.token` is empty/undefined return stub from T021; else build live client wrapping `NativeHttpClient` from T020, with `getJobs()` → `GET ${baseUrl}/queue` and `getWorkers()` → `GET ${baseUrl}/dispatch/queue/workers`. Live client maps HTTP errors to `{ available: false, reason: 'http-error', statusCode }` and network errors to `{ available: false, reason: 'cloud-unreachable' }` — never throws. Depends on T020, T021.

### Tests

- [X] T023 [P] [US4] Create `packages/cockpit/src/__tests__/gh-wrapper.test.ts` mocking `CommandRunner` to assert: (a) `listIssues` constructs correct `gh issue list --json …` args and parses output; (b) `addLabels`/`removeLabels` build correct `gh issue edit` invocations; (c) `getPullRequestCheckRuns` parses `gh pr checks --json` output; (d) malformed JSON output throws descriptive error.
- [X] T024 [P] [US4] Create `packages/cockpit/src/__tests__/orchestrator-client.test.ts` covering SC-005: (a) stub mode — no token → `isAvailable()` is `false`, all methods resolve to `{ available: false, reason: 'no-token' }`, never throw; (b) live mode with mocked `HttpClient` — 200 → `{ available: true, … }`; (c) HTTP 5xx → `{ available: false, reason: 'http-error', statusCode }`; (d) network error → `{ available: false, reason: 'cloud-unreachable' }`; (e) `ORCHESTRATOR_API_TOKEN` env var picked up via factory when explicit token absent.

---

## Phase 7: Integration & Polish

- [X] T025 Create `packages/cockpit/src/index.ts` re-exporting the full public API surface listed in `data-model.md` §"Public API surface" (state + classifier + precedence consts, config schema + loader, manifest schemas + io + scoping, `GhCliWrapper` + types, orchestrator factory + types + envelopes). Internal modules (`state/label-map.ts`, `gh/command-runner.ts`, `orchestrator/http.ts`, `orchestrator/stub.ts`) are NOT exported. Depends on T005–T022.
- [X] T026 [P] Create `packages/cockpit/README.md` (FR-013) documenting: package purpose, install, public API examples (`classify`, `loadCockpitConfig`, `resolveEpicIssues`, `createOrchestratorClient`), the `cockpit:` config block schema, and degraded-mode semantics. Reference: spec.md US1–US4.
- [X] T027 Run `pnpm --filter @generacy-ai/cockpit build && pnpm --filter @generacy-ai/cockpit test` and confirm green (SC-002, SC-006). Fix any type or test issues surfaced.
- [X] T028 Verify SC-007 isolation: `git diff --name-only develop...HEAD` shows only `packages/cockpit/**` changes (plus pnpm-lock.yaml / pnpm-workspace.yaml if changed in T004). Flag any out-of-scope edit before merging.

---

## Dependencies & Execution Order

**Phase-level dependencies** (sequential):
- Phase 1 (Setup) → Phase 2 (Types) → Phases 3–6 (US implementations, parallelizable) → Phase 7 (Integration & Polish)

**Within-phase parallel opportunities**:
- **Phase 1**: T002, T003 can run in parallel after T001. T004 follows T001.
- **Phase 2**: T005 is a single task — blocks every downstream phase.
- **Phase 3 (US1)**: T006 and T007 run in parallel after T005; T008 depends on both; T009 (test) runs in parallel with T008 once T006/T007 land.
- **Phase 4 (US2)**: T010 first; T011 and T012 follow (T012 forward-declares the `GhWrapper` type via `import type` only, so doesn't strictly block on Phase 6); tests T013/T014 parallel.
- **Phase 5 (US3)**: T015 → T016; test T017 parallel with T016 once T015 lands.
- **Phase 6 (US4)**: T018, T020, T021 parallel after T005; T019 follows T018; T022 follows T020+T021; tests T023/T024 parallel.

**Cross-phase parallel opportunities**: Phases 3, 4, 5, 6 are largely independent of each other after Phase 2 lands. A single developer can land them in sequence, but multiple agents can fan out (one per US) — the only seam is Phase 4 T012's `import type { GhWrapper }`, which is resolved at compile time by T019.

**Phase 7**: T025 depends on every implementation task (T005–T022). T026 can land in parallel with T025. T027/T028 run sequentially after T025/T026 — they verify the final state.

---

## Story-to-Acceptance-Criteria Mapping

- **US1** → T006–T009 → spec.md AC for US1 (FR-002, FR-003, FR-004) and SC-001, SC-002.
- **US2** → T010–T014 → spec.md AC for US2 (FR-006, FR-007) and SC-004.
- **US3** → T015–T017 → spec.md AC for US3 (FR-005) and SC-003.
- **US4** → T018–T024 → spec.md AC for US4 (FR-008, FR-009, FR-010) and SC-005.
- **Cross-cutting** → T025 (FR-012), T026 (FR-013), T027 (SC-002, SC-006, FR-011), T028 (SC-007).
