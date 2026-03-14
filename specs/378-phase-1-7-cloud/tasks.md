# Tasks: Conversation Metadata JSONL Logging

**Input**: Design documents from `/specs/378-phase-1-7-cloud/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Types & Setup

- [ ] T001 [US1] Add `JournalEventType` and `JournalEntry` types to `packages/orchestrator/src/worker/types.ts`
  - Add `JournalEventType = 'phase_start' | 'phase_complete' | 'tool_use' | 'tool_result' | 'error'`
  - Add `JournalEntry` interface with required fields (`timestamp`, `phase`, `event_type`, `session_id`) and optional fields (`model`, `tokens_in`, `tokens_out`, `tool_name`, `tool_call_id`, `file_paths`, `duration_ms`, `error_message`)

## Phase 2: Core Implementation

- [ ] T002 [US1] Implement `ConversationLogger` class in `packages/orchestrator/src/worker/conversation-logger.ts`
  - Constructor accepts `specDir: string`, computes `filePath` as `specDir/conversation-log.jsonl`
  - `setPhase(phase, sessionId, model?)` — stores phase state, emits `phase_start` entry, starts 30s flush timer
  - `logEvent(chunk: OutputChunk)` — processes `tool_use`, `tool_result`, `complete`, `error` events into `JournalEntry` objects; skips `text` and `init` events (init handled by setPhase)
  - Buffer management: `JournalEntry[]` in memory, auto-flush at 50 events
  - Tool duration tracking: `Map<string, number>` mapping `toolCallId → Date.now()`, populated on `tool_use`, consumed on `tool_result` to compute `duration_ms`
  - File path extraction from `tool_use` inputs for known tools (Read/Write/Edit → `file_path`, Glob/Grep → `path`); from `tool_result` via existing `metadata.filePath`
  - Token extraction from `complete` events (best-effort, omit when missing)
  - `flush()` — serializes buffered entries as JSONL lines, appends to file via `fs.appendFile()`, clears buffer
  - `close()` — emits `phase_complete` entry, final flush, clears timer and tool start times
  - Graceful degradation: spread optional fields only when defined (no nulls in JSONL)

## Phase 3: Integration

- [ ] T003 [US1] Wire `ConversationLogger` into `OutputCapture` in `packages/orchestrator/src/worker/output-capture.ts`
  - Add optional `conversationLogger?: ConversationLogger` as fourth constructor parameter
  - In `processChunk()`, after parsing each JSON line into `OutputChunk`, call `this.conversationLogger?.logEvent(chunk)`

- [ ] T004 [P] [US1] Wire `ConversationLogger` through `CliSpawner` in `packages/orchestrator/src/worker/cli-spawner.ts`
  - Add optional `conversationLogger?: ConversationLogger` parameter to `spawnPhase()` method
  - Pass it through to `OutputCapture` constructor

- [ ] T005 [US1] Wire `ConversationLogger` into `PhaseLoop` in `packages/orchestrator/src/worker/phase-loop.ts`
  - Create `ConversationLogger` instance at loop start with spec directory path (derived from `context.checkoutPath` and issue number)
  - At each phase start (before `spawnPhase`): call `logger.setPhase(phase, sessionId, model)`
  - Pass logger to `cliSpawner.spawnPhase()` and through to `OutputCapture`
  - At each phase end: call `logger.close()` to trigger final flush + `phase_complete` entry
  - Logger instance persists across phases (single JSONL file, append-only)

- [ ] T006 [US1] Ensure JSONL file is included in git stage at phase completion
  - Verify that `prManager.commitAndPush()` uses `github.stageAll()` which would include the JSONL file
  - If `stageAll()` already stages all changes, no code change needed — just verify behavior
  - If explicit staging is needed, add `conversation-log.jsonl` path to the staging step

## Phase 4: Tests

- [ ] T007 [US1] Write unit tests for `ConversationLogger` in `packages/orchestrator/src/worker/__tests__/conversation-logger.test.ts`
  - Test JSONL line format for each event type (`phase_start`, `tool_use`, `tool_result`, `phase_complete`, `error`)
  - Test buffer auto-flush at 50 events threshold
  - Test timer-based periodic flush at 30s (use fake timers)
  - Test tool duration pairing: `tool_use` → `tool_result` via `tool_call_id` computes correct `duration_ms`
  - Test file path extraction from `tool_use` inputs for known tools (Read, Write, Edit, Glob, Grep)
  - Test file path extraction from `tool_result` via `metadata.filePath`
  - Test append-only behavior: multiple `flush()` calls append to file, don't overwrite
  - Test graceful handling of missing token data in `complete` events
  - Test `phase_start` and `phase_complete` entries have correct fields
  - Test `close()` clears timer and emits `phase_complete`
  - Test unknown/unsupported tool_use events produce entries without `file_paths`
  - Test `setPhase()` resets state correctly for a new phase

- [ ] T008 [P] [US1] Add integration-level tests verifying OutputCapture → ConversationLogger wiring
  - Test that `OutputCapture.processChunk()` calls `ConversationLogger.logEvent()` for each parsed chunk
  - Test that a mock ConversationLogger receives expected events from a sample Claude CLI output stream
  - Test that passing no ConversationLogger (undefined) doesn't break OutputCapture

## Dependencies & Execution Order

```
T001 (types)
  ↓
T002 (ConversationLogger)
  ↓
T003 (OutputCapture wiring) ←── T004 [P] (CliSpawner wiring)
  ↓
T005 (PhaseLoop wiring)
  ↓
T006 (git staging verification)
  ↓
T007 (unit tests) ←── T008 [P] (integration tests)
```

**Phase boundaries** (sequential):
- Phase 1 → Phase 2 → Phase 3 → Phase 4

**Parallel opportunities**:
- T004 can run in parallel with T003 (different files, both depend on T002)
- T008 can run in parallel with T007 (different test files, both depend on Phase 3)

**Notes**:
- T006 may require no code changes if `stageAll()` already covers the JSONL file — verify and close
- All token extraction is best-effort; tests should verify graceful degradation, not exact values
