# Tasks: Onboarding Slash Command Suite

**Input**: Design documents from `/specs/382-phase-4-2-cloud/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- US1: /onboard:evaluate (readiness assessment)
- US2: /onboard:stack (tech stack detection)
- US3: /onboard:plugins (plugin configuration)
- US4: /onboard:mcp (MCP server configuration)
- US5: /onboard:init (project initialization)
- US6: /onboard:architecture (architecture docs)
- US7: /onboard:backlog (backlog population)

## Phase 1: Package Scaffolding & Shared Types

- [X] T001 Create `agency-plugin-onboard` package skeleton — `package.json`, `tsconfig.json`, `src/index.ts` in `/workspaces/agency/packages/agency-plugin-onboard/`
- [X] T002 [P] Create `claude-plugin-agency-onboard` package skeleton — `package.json`, `.claude-plugin/plugin.json` in `/workspaces/agency/packages/claude-plugin-agency-onboard/`
- [X] T003 Register both packages in pnpm workspace config (`pnpm-workspace.yaml` or root `package.json`)
- [X] T004 [P] Define shared types — `src/types/readiness.ts` (TrafficLight, CheckResult, CategoryResult, ReadinessReport), `src/types/stack.ts` (Confidence, DetectedItem, DetectionResult), `src/types/catalog.ts` (PluginDefinition, PluginSelection, McpServerDefinition, McpJsonEntry), `src/types/index.ts` barrel
- [X] T005 [P] Create plugin manifest — `src/manifest.ts` declaring 7 tools (`onboard.evaluate_readiness`, `onboard.detect_stack`, `onboard.configure_plugins`, `onboard.configure_mcp`, `onboard.init_project`, `onboard.analyze_architecture`, `onboard.populate_backlog`), modes, and dependencies
- [X] T006 [P] Create config schema — `src/config.ts` with Zod schemas for onboard plugin configuration and `parseConfig()` function

## Phase 2: Detectors & Catalogs

- [X] T010 [P] [US2] Implement language detector — `src/detectors/language.ts` scanning for `package.json`, `go.mod`, `Cargo.toml`, `requirements.txt`, `*.py`, `*.rs`, `*.go`, `*.java` etc.
- [X] T011 [P] [US2] Implement build tools detector — `src/detectors/build-tools.ts` scanning for `turbo.json`, `nx.json`, `webpack.config.*`, `vite.config.*`, `tsconfig.json`, detecting package manager from lockfiles
- [X] T012 [P] [US2] Implement testing detector — `src/detectors/testing.ts` scanning for vitest/jest/pytest/go test configs in dependency files and config files
- [X] T013 [P] [US2] Implement CI/CD detector — `src/detectors/ci-cd.ts` scanning for `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`, `circle.yml`
- [X] T014 [P] [US2] Implement infrastructure detector — `src/detectors/infrastructure.ts` scanning for `docker-compose.yml`, `Dockerfile`, `firebase.json`, database config files
- [X] T015 [P] [US3] Create plugin catalog — `src/catalogs/plugins.ts` with hardcoded 6-plugin catalog (git, npm, docker, firebase, humancy, spec-kit) per `contracts/plugin-catalog.ts`
- [X] T016 [P] [US4] Create MCP server catalog — `src/catalogs/mcp-servers.ts` with hardcoded 3-server catalog (agency, playwright, vscode) per `contracts/mcp-catalog.ts`, plus logic to load custom servers from `.generacy/mcp-servers.yaml`

## Phase 3: Tool Implementation

- [X] T020 [US2] Implement `detect_stack` tool — `src/tools/detect-stack.ts` orchestrating all detectors, merging results, writing `.generacy/stack.yaml` with idempotent merge semantics
- [X] T021 [P] [US1] Implement `evaluate_readiness` tool — `src/tools/evaluate-readiness.ts` with traffic-light scoring across 4 categories (environment, configuration, permissions, documentation), overall = worst category
- [X] T022 [P] [US3] Implement `configure_plugins` tool — `src/tools/configure-plugins.ts` reading `.generacy/stack.yaml`, matching stack signals to plugin catalog, returning recommendations, writing `.generacy/config.yaml` plugins section
- [X] T023 [P] [US4] Implement `configure_mcp` tool — `src/tools/configure-mcp.ts` reading `.generacy/stack.yaml`, matching stack signals to MCP catalog + custom servers, writing `.mcp.json` with merge semantics
- [X] T024 [P] [US5] Implement `init_project` tool — `src/tools/init-project.ts` creating/updating CLAUDE.md, .gitignore entries, verifying devcontainer config
- [X] T025 [P] [US6] Implement `analyze_architecture` tool — `src/tools/analyze-architecture.ts` scanning directory structure, identifying patterns, generating architecture markdown document
- [X] T026 [P] [US7] Implement `populate_backlog` tool — `src/tools/populate-backlog.ts` analyzing project state (TODOs, missing tests, gaps), suggesting issues in batches, creating via Octokit

## Phase 4: Plugin Class & Tool Factory

- [X] T030 Create tool factory — `src/tools/index.ts` with `createTools()` returning all 7 tools as `AgencyTool[]`
- [X] T031 Implement plugin class — `src/plugin.ts` (`OnboardPlugin` extending `AgencyPlugin`) with `initialize()` registering tools and `shutdown()` cleanup
- [X] T032 Wire up barrel exports — `src/index.ts` exporting plugin class, factory function, manifest, types, catalogs

## Phase 5: Command Prompts (Claude Code Plugin)

- [X] T040 [P] [US1] Write `/onboard:evaluate` command — `commands/onboard-evaluate.md` instructing agent to call `evaluate_readiness` tool, present traffic-light report, suggest next steps
- [X] T041 [P] [US2] Write `/onboard:stack` command — `commands/onboard-stack.md` instructing agent to call `detect_stack` tool, present findings, ask confirmation before writing `.generacy/stack.yaml`
- [X] T042 [P] [US3] Write `/onboard:plugins` command — `commands/onboard-plugins.md` instructing agent to call `configure_plugins` tool, present recommendations, walk through selection, confirm before writing `.generacy/config.yaml`
- [X] T043 [P] [US4] Write `/onboard:mcp` command — `commands/onboard-mcp.md` instructing agent to call `configure_mcp` tool, present recommendations, confirm before writing `.mcp.json`
- [X] T044 [P] [US5] Write `/onboard:init` command — `commands/onboard-init.md` instructing agent to call `init_project` tool, present proposed changes, confirm before applying
- [X] T045 [P] [US6] Write `/onboard:architecture` command — `commands/onboard-architecture.md` instructing agent to call `analyze_architecture` tool, present findings, confirm before writing docs
- [X] T046 [P] [US7] Write `/onboard:backlog` command — `commands/onboard-backlog.md` instructing agent to call `populate_backlog` tool, present issues in batches, get approval per batch

## Phase 6: Testing

- [ ] T050 [P] [US2] Write unit tests for detectors — `tests/detectors.test.ts` testing each detector with fixture project directories (empty, Node.js, Go, Python, monorepo)
- [ ] T051 [P] [US1] Write unit tests for `evaluate_readiness` tool — `tests/evaluate-readiness.test.ts` testing scoring logic, category aggregation, worst-wins overall
- [ ] T052 [P] [US2] Write unit tests for `detect_stack` tool — `tests/detect-stack.test.ts` testing detector orchestration and `.generacy/stack.yaml` output
- [ ] T053 [P] [US3] Write unit tests for `configure_plugins` tool — `tests/configure-plugins.test.ts` testing stack signal matching, catalog lookups, config writing
- [ ] T054 [P] [US4] Write unit tests for `configure_mcp` tool — `tests/configure-mcp.test.ts` testing stack signal matching, custom server loading, `.mcp.json` writing
- [ ] T055 [P] [US5] Write unit tests for `init_project` tool — `tests/init-project.test.ts` testing CLAUDE.md creation, .gitignore updates, devcontainer verification
- [ ] T056 [P] [US6] Write unit tests for `analyze_architecture` tool — `tests/analyze-architecture.test.ts` testing directory scanning, pattern detection
- [ ] T057 [P] [US7] Write unit tests for `populate_backlog` tool — `tests/populate-backlog.test.ts` testing issue suggestion, batching, Octokit integration
- [ ] T058 Write idempotency tests — `tests/idempotency.test.ts` running each config-writing tool twice, verifying no duplication or corruption
- [ ] T059 Write integration test — `tests/integration.test.ts` full flow: detect stack → configure plugins → configure mcp → verify outputs are consistent

## Dependencies & Execution Order

**Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 + Phase 6**

### Phase 1: Package Scaffolding (sequential then parallel)
- T001 must complete before T003 (workspace registration needs packages to exist)
- T002 can run in parallel with T001
- T004, T005, T006 can run in parallel after T001 (they create files within the MCP package)

### Phase 2: Detectors & Catalogs (all parallel)
- T010–T016 can all run in parallel — independent files with no shared dependencies
- Requires Phase 1 complete (types and package structure needed)

### Phase 3: Tool Implementation (partially parallel)
- T020 depends on T010–T014 (uses all detectors)
- T021 is independent — can run in parallel with T020
- T022 depends on T015 (uses plugin catalog) and T020 (reads stack.yaml output)
- T023 depends on T016 (uses MCP catalog) and T020 (reads stack.yaml output)
- T024, T025, T026 are independent — can run in parallel with others
- **Parallel groups**: {T020} → {T021, T022, T023, T024, T025, T026}

### Phase 4: Plugin Class (sequential)
- T030 depends on all tools (T020–T026) being implemented
- T031 depends on T030 (needs tool factory)
- T032 depends on T031 (needs plugin class)

### Phase 5: Command Prompts (all parallel)
- T040–T046 can all run in parallel — independent .md files
- Can start after Phase 4 (need tool names finalized)

### Phase 6: Testing (mostly parallel)
- T050–T057 can all run in parallel
- T058 depends on T052–T055 (needs config-writing tools tested first)
- T059 depends on T050–T057 (integration test runs after unit tests)
- Phase 6 can overlap with Phase 5 (command prompts and tests are independent)

---

*Generated by speckit*
