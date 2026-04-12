# Tasks: Create ClaudeCodeLaunchPlugin (Phase 2)

**Input**: Design documents from `/specs/428-goal-phase-2-spawn/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Type Definitions & Constants

- [ ] T001 Create intent types file `packages/generacy-plugin-claude-code/src/launch/types.ts` — define `PhaseIntent`, `PrFeedbackIntent`, `ConversationTurnIntent`, and `ClaudeCodeIntent` union type. `PhaseIntent.phase` excludes `validate` (compile-time). `ConversationTurnIntent` has flattened fields (message, sessionId?, model?, skipPermissions).
- [ ] T002 [P] Create constants file `packages/generacy-plugin-claude-code/src/launch/constants.ts` — copy `PHASE_TO_COMMAND` map (5 phases only, no `validate`), embed `PTY_WRAPPER` Python script verbatim from `conversation-spawner.ts:47-57`.
- [ ] T003 Update `packages/orchestrator/src/launcher/types.ts` — extend `LaunchIntent` union to include `ClaudeCodeIntent`. Update `createOutputParser` signature to `createOutputParser(intent: LaunchIntent)`.
- [ ] T004 Update `packages/orchestrator/src/launcher/generic-subprocess-plugin.ts` — add `_intent: LaunchIntent` parameter to `createOutputParser` method signature (no-op, backward compatible).

## Phase 2: Plugin Implementation

- [ ] T005 Create `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts` — implement `ClaudeCodeLaunchPlugin` class with `pluginId: "claude-code"`, `supportedKinds: ["phase", "pr-feedback", "conversation-turn"]`. Implement `buildLaunch(intent)` discriminating by `intent.kind`:
  - **phase**: `command: "claude"`, args: `['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose']` + optional `--resume <sessionId>` + prompt
  - **pr-feedback**: `command: "claude"`, args: `['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose', prompt]`
  - **conversation-turn**: `command: "python3"`, args: `['-u', '-c', PTY_WRAPPER, 'claude', '-p', message, '--output-format', 'stream-json', '--verbose']` + conditional `--resume`, `--dangerously-skip-permissions`, `--model`. Returns `stdioProfile: "interactive"`.
- [ ] T006 Implement `createOutputParser(intent)` on `ClaudeCodeLaunchPlugin` — returns no-op parser (same as `GenericSubprocessPlugin`). Full parser logic deferred to Wave 3 when callers migrate.

## Phase 3: Registration & Exports

- [ ] T007 Update `packages/orchestrator/src/worker/claude-cli-worker.ts` — import `ClaudeCodeLaunchPlugin` from `@generacy-ai/generacy-plugin-claude-code` and register it in constructor after `GenericSubprocessPlugin`: `this.agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin())`.
- [ ] T008 [P] Update `packages/generacy-plugin-claude-code/src/index.ts` — add exports for `ClaudeCodeLaunchPlugin`, `PhaseIntent`, `PrFeedbackIntent`, `ConversationTurnIntent`, `ClaudeCodeIntent` from `./launch/`.

## Phase 4: Tests

- [ ] T009 Create snapshot test file `packages/generacy-plugin-claude-code/src/launch/__tests__/claude-code-launch-plugin.test.ts`:
  - Snapshot `buildLaunch()` output for each of the 5 phase intents (specify, clarify, plan, tasks, implement)
  - Snapshot `buildLaunch()` for phase intent with `sessionId` (resume path)
  - Snapshot `buildLaunch()` for pr-feedback intent
  - Snapshot `buildLaunch()` for conversation-turn intent with all flag combinations (skipPermissions true/false, with/without sessionId, with/without model)
- [ ] T010 [P] Add unit tests to the same file:
  - Verify `pluginId === "claude-code"`
  - Verify `supportedKinds` contains `["phase", "pr-feedback", "conversation-turn"]`
  - Verify `createOutputParser(intent)` returns a valid `OutputParser` for each intent kind
  - Defensive test: unsupported intent kind throws
- [ ] T011 Add integration sanity test — create `AgentLauncher` with registered `ClaudeCodeLaunchPlugin`, verify `launcher.launch({ pluginId: "claude-code", intent: { kind: "phase", ... }, cwd, env })` routes to plugin. Use `RecordingProcessFactory` from Wave 1 harness.

## Phase 5: Verification

- [ ] T012 Run full orchestrator test suite — confirm all existing tests pass unchanged (no caller migration, pure additive change).
- [ ] T013 Run plugin package tests — confirm new snapshot and unit tests pass, snapshot files are committed.

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 + T002 (parallel) → T005 (plugin needs types + constants)
- T003 + T004 (parallel) → T005 (plugin implements updated interface)
- T005 → T006 (parser is part of plugin class, but can be added after buildLaunch)
- T005 + T006 → T007 (registration needs complete plugin)
- T001 → T008 (exports need types to exist)
- T005 + T006 → T009, T010, T011 (tests need plugin)
- T009 + T010 + T011 → T012 + T013 (verification after all code + tests written)

**Parallel opportunities**:
- T001 ‖ T002 (different files, no dependency)
- T003 ‖ T004 (different files in same package, independent changes)
- T007 ‖ T008 (different packages)
- T009 ‖ T010 (different test groups in same file, but can be written together)

**Suggested execution order**:
1. T001 + T002 + T003 + T004 (all parallel — type foundations)
2. T005 + T006 (plugin implementation)
3. T007 + T008 (parallel — registration + exports)
4. T009 + T010 + T011 (tests)
5. T012 + T013 (verification)
