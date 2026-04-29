# Tasks: CLI claude-login and open commands

**Input**: Design documents from `/specs/496-context-generacy-claude-login/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/cluster-context.ts
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Shared Utilities

- [ ] T001 [US1,US2] Create `packages/generacy/src/cli/utils/cluster-context.ts` — Implement `getClusterContext(options)`: walk up from cwd to find `.generacy/cluster.json`, parse with `ProjectClusterJsonSchema` (Zod), optionally cross-reference `~/.generacy/clusters.json` via `ClusterRegistrySchema`. Support `--cluster <id>` override via registry lookup. Throw clear errors for missing/invalid files.
- [ ] T002 [P] [US1,US2] Create `packages/generacy/src/cli/utils/browser.ts` — Implement `openUrl(url)`: macOS uses `exec('open "<url>"')`, Windows uses `exec('start "" "<url>"')`, Linux prints "Open this URL in your browser:" with the URL. Uses `node:os` for platform detection, `node:child_process` for exec.
- [ ] T003 [P] [US1] Create `packages/generacy/src/cli/commands/claude-login/url-scanner.ts` — Implement a Transform stream that pipes all data through to stdout while scanning for the first URL match (`https?://\S+`). Exposes a promise/callback for the detected URL. First match wins.

## Phase 2: Tests for Shared Utilities

- [ ] T004 Create `packages/generacy/src/cli/utils/__tests__/cluster-context.test.ts` — Unit tests: walk-up resolution finds `.generacy/cluster.json`, stops at filesystem root, handles missing file, invalid JSON, valid parse, `--cluster` registry lookup hit, `--cluster` registry lookup miss.
- [ ] T005 [P] Create `packages/generacy/src/cli/utils/__tests__/browser.test.ts` — Unit tests: mock `child_process.exec` and `os.platform()`, verify correct command for macOS (`open`), Windows (`start`), Linux (no exec, prints URL).
- [ ] T006 [P] Create `packages/generacy/src/cli/commands/claude-login/__tests__/url-scanner.test.ts` — Unit tests: feed strings with URLs, without URLs, multiple URLs (first wins), partial lines, verify passthrough and extraction.

## Phase 3: Command Implementation

- [ ] T007 [US1] Create `packages/generacy/src/cli/commands/claude-login/index.ts` — Implement `claudeLoginCommand()`: resolves cluster via `getClusterContext`, spawns `docker compose exec -it orchestrator claude /login` with `stdio: ['inherit', 'pipe', 'inherit']`, pipes stdout through URL scanner, calls `openUrl()` on detected URL. Uses `--project-name` and `--project-directory` from cluster context. Exits with child process exit code.
- [ ] T008 [P] [US2] Create `packages/generacy/src/cli/commands/open/index.ts` — Implement `openCommand()`: accepts `--cluster <id>` option, resolves cluster via `getClusterContext`, constructs `{cloudUrl}/clusters/{clusterId}` URL, calls `openUrl()`. Fails with clear error when cluster not found.

## Phase 4: Command Registration & Integration Tests

- [ ] T009 [US1,US2] Register both commands in `packages/generacy/src/cli/index.ts` — Import and add `claudeLoginCommand()` and `openCommand()` to `createProgram()`.
- [ ] T010 [P] [US1] Create `packages/generacy/src/cli/commands/claude-login/__tests__/claude-login.test.ts` — Integration test: mock `child_process.spawn` to simulate docker compose exec with a fake claude binary that prints a URL, verify URL scanner detects it and `openUrl` is called with the correct URL.
- [ ] T011 [P] [US2] Create `packages/generacy/src/cli/commands/open/__tests__/open.test.ts` — Unit tests: mock `getClusterContext` and `openUrl`, verify URL construction `{cloudUrl}/clusters/{clusterId}`, verify error handling for missing cluster.

## Dependencies & Execution Order

**Phase 1** (T001, T002, T003): T002 and T003 can run in parallel with each other. T001 is independent but foundational — all commands depend on it.

**Phase 2** (T004, T005, T006): All three test files can run in parallel. Each depends only on its corresponding Phase 1 implementation.

**Phase 3** (T007, T008): Both commands can run in parallel. Each depends on Phase 1 utilities (T001, T002, T003).

**Phase 4** (T009, T010, T011): T009 (registration) is a quick change. T010 and T011 can run in parallel. Both depend on their respective Phase 3 commands.

```
T001 ──┬──> T004 ──┬──> T007 ──┬──> T009
T002 ──┼──> T005 ──┤           │    T010
T003 ──┴──> T006 ──┴──> T008 ──┴──> T011
```
