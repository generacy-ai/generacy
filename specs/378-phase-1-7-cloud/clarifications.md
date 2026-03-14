# Clarifications: Conversation Metadata JSONL Logging

## Batch 1 — 2026-03-14

### Q1: Text Event Granularity
**Context**: FR-003 includes `text` as a captured event type. `OutputCapture` emits a `text` event for every streamed text chunk from Claude CLI, which could mean hundreds of events per phase. Logging all of them would produce very large JSONL files and contradicts the "lightweight metadata" goal stated in the summary.
**Question**: Should all `text` chunk events be logged individually, or should text be aggregated (e.g., one summary entry per phase, or omitted entirely since full conversations are available via the cluster relay)?
**Options**:
- A: Log every text chunk event (high volume, complete record)
- B: Log a single aggregated text summary per phase (character count, line count)
- C: Omit text events entirely — full content is available via cluster relay by session ID

**Answer**: *Pending*

### Q2: Token Count Source Format
**Context**: FR-005 and FR-009 assume token counts (`tokens_in`, `tokens_out`) are available in Claude CLI `complete` events. However, `OutputCapture` does not currently parse token counts from any event type. The spec's Assumptions section says "Token counts are available in Claude CLI complete events" but this is unverified.
**Question**: Has the Claude CLI `complete` event JSON structure been verified to contain token usage fields? If so, what are the exact field names/paths? If not, should this feature degrade gracefully (omit token fields) when counts are unavailable?
**Options**:
- A: Token counts are confirmed available — provide the field path in Claude CLI output
- B: Best-effort extraction — include when available, omit when not (no error)
- C: Token counts are not currently available — defer this requirement

**Answer**: *Pending*

### Q3: Tool Call Duration Calculation
**Context**: FR-007 requires `duration_ms` for tool calls. `OutputCapture` currently processes events independently without tracking temporal relationships between `tool_use` and `tool_result` event pairs. Calculating duration requires pairing these events and tracking start timestamps.
**Question**: Should `duration_ms` for tool calls be calculated by pairing `tool_use` → `tool_result` events (requires state tracking in OutputCapture), or should it only be recorded on events that natively include timing data?
**Options**:
- A: Pair tool_use/tool_result events to calculate duration (adds state tracking complexity)
- B: Only record duration where natively available in event data
- C: Record wall-clock timestamps only; let consumers calculate duration

**Answer**: *Pending*

### Q4: File Paths Extraction Scope
**Context**: FR-006 requires `file_paths` for `tool_use` and `tool_result` events. Currently, `OutputCapture` only extracts `filePath` from `tool_result` metadata. `tool_use` events contain tool input parameters which may or may not include file paths depending on the tool (Edit, Read, Write have paths; Bash, Grep may not).
**Question**: For `tool_use` events, should file paths be extracted by parsing tool-specific input parameters (requires per-tool parsing logic), or should `file_paths` only be populated on `tool_result` events where they're already available?
**Options**:
- A: Parse tool-specific inputs on tool_use to extract file paths (more complete, more complex)
- B: Only populate file_paths on tool_result events using existing extraction (simpler, less complete)
- C: Populate on both — use existing tool_result extraction and add best-effort tool_use extraction

**Answer**: *Pending*

### Q5: JSONL Write Strategy
**Context**: FR-002 says "write one JSON object per line, incrementally as events occur" and FR-008 says "extend OutputCapture class to write JSONL." However, OutputCapture currently runs within the spawned Claude CLI process context. Writing to the spec directory incrementally means opening/appending a file on every event, which has I/O implications and requires the spec directory path to be available inside OutputCapture.
**Question**: Should JSONL entries be written incrementally (append on each event) or buffered and flushed at phase completion? Incremental writes survive crashes but add I/O overhead; batch writes are simpler but lose data on crashes.
**Options**:
- A: Incremental append on each event (crash-resilient, more I/O)
- B: Buffer in memory, flush at phase completion (simpler, data loss risk on crash)
- C: Hybrid — buffer with periodic flush (e.g., every N events or every M seconds)

**Answer**: *Pending*
