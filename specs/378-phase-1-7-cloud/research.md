# Research: Conversation Metadata JSONL Logging

## Technology Decisions

### JSONL Format
**Decision**: Use newline-delimited JSON (JSONL) — one JSON object per line, appended to file.

**Rationale**: JSONL is the natural format here because:
- Append-only writes without parsing the existing file
- Each line is independently parseable (no surrounding array brackets)
- Standard format consumed by many tools (jq, pandas, etc.)
- Matches the existing pattern in OutputCapture which already processes newline-delimited JSON from Claude CLI

**Alternatives considered**:
- **Single JSON array file**: Requires reading, parsing, modifying, and rewriting the entire file on each append — poor for concurrent/crash-resilient writes
- **SQLite**: Overkill for a simple append log committed to git
- **CSV**: Loses nested structure (file_paths array, optional fields)

### Separate Class vs. Extending OutputCapture
**Decision**: New `ConversationLogger` class composed into OutputCapture.

**Rationale**: OutputCapture is responsible for parsing CLI output and extracting operational data (session ID, implement results). Adding JSONL persistence would mix concerns. A separate class:
- Can be tested independently with mock events
- Can be made optional (null object pattern)
- Doesn't increase complexity of the already nuanced OutputCapture parsing
- Can evolve independently (e.g., adding new event types later)

**Alternatives considered**:
- **Extend OutputCapture directly**: Simpler wiring but violates SRP, makes OutputCapture harder to test
- **Post-process PhaseResult.output after phase completes**: Loses periodic flush capability, no crash resilience
- **Event emitter pattern**: OutputCapture emits events, ConversationLogger subscribes — adds indirection without clear benefit given the 1:1 relationship

### Buffer + Periodic Flush Strategy
**Decision**: Buffer in memory, flush every 50 events or 30 seconds, plus explicit flush at phase boundaries.

**Rationale**: Per clarification Q5 answer. Balances:
- Crash resilience (periodic flush preserves recent data)
- I/O efficiency (not opening/appending file on every event)
- Simplicity (single timer + count threshold)

The 50-event threshold handles burst scenarios (rapid tool calls). The 30s timer handles long gaps between events.

### Tool Duration Calculation
**Decision**: Maintain `Map<toolCallId, startTimestamp>` to pair tool_use → tool_result events.

**Rationale**: Per clarification Q3 answer. Pre-calculating `duration_ms` in the JSONL makes the file self-contained for analysis. The state tracking is minimal — the map holds at most a handful of entries (parallel tool calls are rare in Claude CLI).

### File Path Extraction from tool_use
**Decision**: Best-effort extraction from known tool input schemas.

**Rationale**: Per clarification Q4 answer. Well-known tools have predictable input structures:
- `Read`, `Write`, `Edit`: `file_path` parameter
- `Glob`: `path` or `pattern` parameter
- `Grep`: `path` parameter

For unknown tools or tools with complex inputs (Bash), return empty array. This is strictly additive information.

## Implementation Patterns

### appendFile for JSONL Writes
Use `fs.appendFile()` for writes. This:
- Creates the file if it doesn't exist
- Appends if it does exist
- Is atomic enough for single-process writes (no concurrent writers)
- Naturally implements the append-only requirement

### Graceful Degradation Pattern
All optional field extraction follows the same pattern:
```typescript
const entry: JournalEntry = {
  timestamp: new Date().toISOString(),
  phase: this.currentPhase,
  event_type: 'tool_use',
  session_id: this.sessionId,
  // Only include if available:
  ...(model && { model }),
  ...(tokensIn != null && { tokens_in: tokensIn }),
  ...(filePaths.length > 0 && { file_paths: filePaths }),
};
```
This keeps JSONL lines compact by omitting undefined fields rather than writing `null` values.

## Key Sources

- Existing `OutputCapture` implementation: `packages/orchestrator/src/worker/output-capture.ts`
- Phase loop orchestration: `packages/orchestrator/src/worker/phase-loop.ts`
- CLI spawner process management: `packages/orchestrator/src/worker/cli-spawner.ts`
- JSONL specification: https://jsonlines.org/
