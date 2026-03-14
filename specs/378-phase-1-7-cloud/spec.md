# Feature Specification: ## Phase 1

**Branch**: `378-phase-1-7-cloud` | **Date**: 2026-03-14 | **Status**: Draft

## Summary

## Phase 1.7 — Cloud Platform Buildout

### Summary
Extend the orchestrator's phase-loop output capture to write summary metadata JSONL files alongside spec artifacts, committed to source control at phase completion.

### Context
The cloud UI (Phase 3) needs to display workflow history and load conversations on demand. Rather than centralizing conversation data, we store lightweight metadata in the repo alongside specs. This metadata provides enough info (session IDs, timestamps, model info) to locate and load full conversations via the cluster relay.

### Requirements

**JSONL file output**:
- Path: `specs/{issue-number}/conversation-log.jsonl` (same directory as spec.md, plan.md, etc.)
- One JSON object per line
- Hybrid write strategy: buffer events in memory with periodic flush (every 50 events or 30 seconds), plus final flush at phase completion

**Event types captured**:
- `phase_start`, `phase_complete`, `error` — phase boundary events
- `tool_use`, `tool_result` — tool call events with metadata
- Text events are **omitted** — full conversation content is available via cluster relay by session ID; JSONL files contain metadata only

**Line format**:
```json
{
  "timestamp": "2026-03-14T10:30:00Z",
  "phase": "specify",
  "event_type": "phase_start | tool_use | tool_result | phase_complete | error",
  "session_id": "session_abc123",
  "model": "claude-sonnet-4-6",
  "tokens_in": 1500,
  "tokens_out": 800,
  "tool_name": "Edit",
  "file_paths": ["src/index.ts"],
  "duration_ms": 2500
}
```

**Token counts** (`tokens_in`, `tokens_out`):
- Best-effort extraction from Claude CLI output events
- Include when available, omit when not (no error on missing data)
- Graceful degradation — do not block on unverified CLI output format

**Tool call duration** (`duration_ms`):
- Calculated by pairing `tool_use` → `tool_result` events using tool call ID
- Maintain a `Map<toolCallId, startTimestamp>` in OutputCapture, cleared after each pairing
- Pre-calculated in JSONL so consumers don't need temporal pairing logic

**File paths** (`file_paths`):
- Populated on both `tool_use` and `tool_result` events
- `tool_result`: use existing `filePath` extraction
- `tool_use`: best-effort extraction from tool input parameters for well-known tools (Read, Write, Edit, Glob, Grep)
- Graceful fallback for tools with non-obvious inputs (Bash, etc.)

**Integration points**:
- Extend `OutputCapture` class (`packages/orchestrator/src/worker/output-capture.ts`) to write JSONL
- Extract model and token metadata from Claude CLI output events (init, complete events)
- Write at phase boundaries and on significant events (tool calls, errors)
- Committed alongside other spec artifacts in the phase completion git commit

**Commit behavior**:
- The JSONL file is added to the git stage at phase completion (same commit as spec artifacts)
- Append-only within a workflow run — new phases append to the same file
- New workflow runs on the same issue append to the existing file (preserves history)

### Technical Notes
- `OutputCapture` already parses Claude CLI newline-delimited JSON output
- It tracks event types: init, tool_use, tool_result, text, complete, error
- Session ID is already extracted from init events
- The phase-loop (`packages/orchestrator/src/worker/phase-loop.ts`) manages the spec directory path
- Token counts may be available in `complete` events from Claude CLI
- Text events are not logged to JSONL (metadata-only files)

### Dependencies
- None (can start immediately)
- Consumed by: issues 3.3 (workflow history), 3.4 (conversation viewer)

### Reference
See `docs/cloud-platform-buildout-reference.md` in tetrad-development for full architectural context.

### Labels
`process:speckit-feature`

## User Stories

### US1: Workflow History Visibility

**As a** cloud UI user,
**I want** lightweight metadata about each workflow phase stored in the repo,
**So that** I can browse workflow history and load full conversations on demand via the cluster relay.

**Acceptance Criteria**:
- [ ] A `conversation-log.jsonl` file is created/appended in the spec directory during phase execution
- [ ] Each JSONL entry contains timestamp, phase, event_type, session_id, and model fields
- [ ] Tool events include tool_name, file_paths, and duration_ms
- [ ] Token counts are included when available from CLI output
- [ ] The JSONL file is committed alongside spec artifacts at phase completion
- [ ] Text content events are not logged (metadata only)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Write JSONL to `specs/{issue-number}/conversation-log.jsonl` | P1 | Same directory as spec artifacts |
| FR-002 | Hybrid write strategy — buffer with periodic flush (50 events / 30s) | P1 | Balances crash resilience with I/O efficiency |
| FR-003 | Capture phase_start, tool_use, tool_result, phase_complete, error events | P1 | Text events omitted — metadata only |
| FR-004 | Extract session_id and model from init events | P1 | Already available in OutputCapture |
| FR-005 | Best-effort token count extraction (tokens_in, tokens_out) | P2 | Omit gracefully when unavailable |
| FR-006 | Extract file_paths from tool_use (best-effort) and tool_result (existing) | P1 | Well-known tools: Read, Write, Edit, Glob, Grep |
| FR-007 | Calculate duration_ms by pairing tool_use → tool_result via tool call ID | P1 | Map<toolCallId, startTimestamp> |
| FR-008 | Extend OutputCapture class to produce JSONL entries | P1 | Existing event parsing infrastructure |
| FR-009 | Append-only JSONL — new phases and workflow runs append to existing file | P1 | Preserves full history |
| FR-010 | Add JSONL file to git stage at phase completion | P1 | Same commit as spec artifacts |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | JSONL file produced | Every phase execution produces entries | Run a workflow and verify file exists |
| SC-002 | Metadata completeness | All tool events have tool_name, file_paths, duration_ms | Parse JSONL and validate fields |
| SC-003 | File size | Reasonable size without text events | Compare with/without text logging |
| SC-004 | Crash resilience | Periodic flush preserves recent events | Kill process mid-phase, check JSONL |

## Assumptions

- OutputCapture already parses Claude CLI newline-delimited JSON output
- Session ID is already extracted from init events
- Token counts may or may not be available in Claude CLI complete events (best-effort)
- The phase-loop manages the spec directory path and can pass it to OutputCapture
- Tool call IDs are available in both tool_use and tool_result events for duration pairing

## Out of Scope

- Storing full conversation text content in JSONL (available via cluster relay)
- Centralized conversation storage
- Real-time streaming of JSONL to cloud UI
- JSONL file rotation or size management

---

*Generated by speckit*
