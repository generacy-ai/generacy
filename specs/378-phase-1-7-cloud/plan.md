# Implementation Plan: Conversation Metadata JSONL Logging

**Feature**: Extend OutputCapture to write summary metadata JSONL files alongside spec artifacts
**Branch**: `378-phase-1-7-cloud`
**Status**: Complete

## Summary

Add a `ConversationLogger` component that buffers JSONL metadata entries (phase boundaries, tool events, errors) and periodically flushes them to `specs/{issue-number}/conversation-log.jsonl`. This is wired into OutputCapture's existing event parsing and committed alongside spec artifacts at phase completion. Text content is excluded — only structural metadata is logged.

## Technical Context

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js
- **Package**: `packages/orchestrator`
- **Key dependencies**: Node `fs/promises` for file I/O, existing `OutputCapture` event parsing
- **Build**: Part of the orchestrator package build (likely esbuild or tsc)

## Architecture

The implementation adds a single new class (`ConversationLogger`) that is composed into the existing phase-loop flow. OutputCapture delegates event notifications to ConversationLogger, which buffers and flushes JSONL entries.

```
PhaseLoop
  ├── creates ConversationLogger(specDir)
  ├── passes logger to CliSpawner/OutputCapture
  │
  OutputCapture.processChunk()
  │   ├── existing event parsing (unchanged)
  │   └── NEW: calls ConversationLogger.logEvent(chunk)
  │
  ConversationLogger
  │   ├── buffers events in memory (Array<JournalEntry>)
  │   ├── periodic flush (every 50 events OR 30s timer)
  │   ├── tracks tool_use start times (Map<string, number>)
  │   ├── extracts file_paths from tool_use inputs (best-effort)
  │   └── flush() → appendFile to conversation-log.jsonl
  │
  PhaseLoop (phase complete)
      └── ConversationLogger.flush() + add file to git stage
```

## Project Structure

### New Files

| File | Purpose |
|------|---------|
| `packages/orchestrator/src/worker/conversation-logger.ts` | ConversationLogger class — buffering, JSONL serialization, flush logic |
| `packages/orchestrator/src/worker/conversation-logger.test.ts` | Unit tests for ConversationLogger |

### Modified Files

| File | Changes |
|------|---------|
| `packages/orchestrator/src/worker/output-capture.ts` | Add ConversationLogger integration — call `logEvent()` on each parsed chunk |
| `packages/orchestrator/src/worker/phase-loop.ts` | Create ConversationLogger instance, pass spec dir, call `setPhase()` at phase start, `flush()` at phase end, add JSONL to git stage |
| `packages/orchestrator/src/worker/types.ts` | Add `JournalEntry` interface and `JournalEventType` type |
| `packages/orchestrator/src/worker/cli-spawner.ts` | Thread ConversationLogger through to OutputCapture (or accept as constructor param) |

## Implementation Steps

### Step 1: Define Types (`types.ts`)

Add `JournalEntry` interface and `JournalEventType` union type to the existing types file.

### Step 2: Implement ConversationLogger (`conversation-logger.ts`)

Core responsibilities:
1. **Constructor** accepts `specDir: string` (path to `specs/{issue-number}/`)
2. **`setPhase(phase, sessionId, model?)`** — called at phase start, emits `phase_start` entry
3. **`logEvent(chunk: OutputChunk)`** — processes tool_use, tool_result, complete, error events
4. **`flush()`** — writes buffered entries to JSONL file, clears buffer
5. **`close()`** — final flush + emit `phase_complete` entry + clear timer

Internal mechanics:
- **Buffer**: `JournalEntry[]` in memory
- **Flush triggers**: buffer.length >= 50, or 30s interval timer, or explicit flush()
- **Tool duration tracking**: `Map<string, number>` mapping `toolCallId → startTimestamp`
- **File path extraction**: Parse `file_path`/`path` fields from tool_use inputs for known tools (Read, Write, Edit, Glob, Grep)
- **Token extraction**: Best-effort parse from `complete` event data (`tokens_in`, `tokens_out` or similar fields)
- **File I/O**: `appendFile()` — creates file if not exists, appends otherwise (naturally append-only)

### Step 3: Wire into OutputCapture (`output-capture.ts`)

- Add optional `conversationLogger?: ConversationLogger` constructor parameter
- In `processChunk()`, after parsing each JSON line into an `OutputChunk`, call `this.conversationLogger?.logEvent(chunk)`
- No changes to existing event handling logic

### Step 4: Wire into PhaseLoop (`phase-loop.ts`)

- At loop start: create `ConversationLogger` with spec directory path derived from `context.checkoutPath` and issue number
- At each phase start: call `logger.setPhase(phase, sessionId, model)`
- At each phase end: call `logger.close()` (triggers final flush + phase_complete entry)
- In `commitPushAndEnsurePr` call or just before: ensure `conversation-log.jsonl` is `git add`-ed to the staging area
- The logger instance persists across phases (append-only file)

### Step 5: Thread through CliSpawner (`cli-spawner.ts`)

- Accept `ConversationLogger` as parameter in `spawnPhase()`
- Pass it to `OutputCapture` constructor

### Step 6: Add to Git Stage

- In the phase completion flow (before or during `prManager.commitPushAndEnsurePr()`), ensure the JSONL file path is included in `git add`
- This may already be handled if `git add -A` or similar is used in PrManager, but verify and add explicit staging if needed

### Step 7: Tests

- Unit test ConversationLogger in isolation:
  - Verify JSONL line format for each event type
  - Verify buffer flush at 50 events
  - Verify timer-based flush at 30s
  - Verify tool duration pairing (tool_use → tool_result)
  - Verify file path extraction from tool_use inputs
  - Verify append-only behavior (multiple flushes append, don't overwrite)
  - Verify graceful handling of missing token data
  - Verify phase_start and phase_complete entries

## Constitution Check

No `constitution.md` found — no governance constraints to verify against.

## Key Design Decisions

1. **Separate class (ConversationLogger) rather than extending OutputCapture**: Keeps concerns separated — OutputCapture handles CLI parsing, ConversationLogger handles JSONL persistence. Avoids bloating an already complex class.

2. **Composition over inheritance**: ConversationLogger is passed to OutputCapture rather than subclassing it, allowing independent testing and optional use.

3. **Hybrid flush strategy**: Balances crash resilience (periodic flush) with I/O efficiency (not per-event). 50 events / 30 seconds matches the spec's clarification answer.

4. **Best-effort everywhere**: Token counts, file paths from tool_use, model info — all use graceful degradation rather than hard failures.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Token count fields unavailable in CLI output | Best-effort extraction, omit fields when missing |
| Tool call ID missing from events (can't pair for duration) | Skip duration_ms for unpaired events |
| JSONL file grows unbounded over many workflow runs | Out of scope per spec; file size is small without text events |
| Periodic flush timer not cleaned up | `close()` method clears interval; PhaseLoop calls close at phase end |
