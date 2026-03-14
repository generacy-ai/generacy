# Feature Specification: Conversation Metadata JSONL Logging

**Branch**: `378-phase-1-7-cloud` | **Date**: 2026-03-14 | **Status**: Draft

## Summary

Extend the orchestrator's phase-loop output capture to write summary metadata JSONL files alongside spec artifacts, committed to source control at phase completion. This provides the cloud UI (Phase 3) with lightweight metadata to display workflow history and locate full conversations via the cluster relay.

## Context

The cloud UI needs to display workflow history and load conversations on demand. Rather than centralizing conversation data, we store lightweight metadata in the repo alongside specs. This metadata provides enough info (session IDs, timestamps, model info) to locate and load full conversations via the cluster relay.

## User Stories

### US1: Workflow History Viewer

**As a** developer using the cloud UI,
**I want** to see a timeline of all workflow phases executed on an issue,
**So that** I can understand what happened, when, and which model was used.

**Acceptance Criteria**:
- [ ] Each phase execution produces JSONL entries with timestamps, session IDs, and model info
- [ ] The JSONL file is committed alongside spec artifacts and available in the repo
- [ ] Multiple workflow runs on the same issue append to the same file (preserving history)

### US2: Conversation Locator

**As a** cloud UI component rendering a conversation viewer,
**I want** session IDs and metadata stored in the JSONL log,
**So that** I can request the full conversation from the cluster relay by session ID.

**Acceptance Criteria**:
- [ ] Session ID is captured from Claude CLI init events and included in every JSONL entry
- [ ] Token usage (in/out) is captured from complete events
- [ ] Tool usage is logged with tool name and affected file paths

### US3: Cost & Performance Tracking

**As a** team lead monitoring AI usage,
**I want** token counts and durations logged per event,
**So that** I can track cost and performance across workflow runs.

**Acceptance Criteria**:
- [ ] `tokens_in` and `tokens_out` are recorded for each event where available
- [ ] `duration_ms` is recorded for tool calls and phase execution
- [ ] Data is machine-readable (JSONL format, one object per line)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Write JSONL file to `specs/{issue-number}/conversation-log.jsonl` | P1 | Same directory as spec.md |
| FR-002 | Write one JSON object per line, incrementally as events occur | P1 | Append-only within a run |
| FR-003 | Capture event types: `phase_start`, `tool_use`, `tool_result`, `text`, `phase_complete`, `error` | P1 | Maps to existing OutputCapture event types |
| FR-004 | Include `timestamp`, `phase`, `event_type`, `session_id`, `model` in every entry | P1 | Core metadata fields |
| FR-005 | Include `tokens_in`, `tokens_out` when available (from complete events) | P2 | May not be present in all events |
| FR-006 | Include `tool_name` and `file_paths` for tool_use/tool_result events | P1 | For traceability |
| FR-007 | Include `duration_ms` for tool calls and phase boundaries | P2 | For performance tracking |
| FR-008 | Extend `OutputCapture` class to write JSONL | P1 | `packages/orchestrator/src/worker/output-capture.ts` |
| FR-009 | Extract model and token metadata from Claude CLI output events | P1 | init and complete events |
| FR-010 | Add JSONL file to git stage at phase completion | P1 | Same commit as spec artifacts |
| FR-011 | New workflow runs append to existing JSONL file | P1 | Preserves history across runs |

## JSONL Line Format

```json
{
  "timestamp": "2026-03-14T10:30:00Z",
  "phase": "specify",
  "event_type": "phase_start | tool_use | tool_result | text | phase_complete | error",
  "session_id": "session_abc123",
  "model": "claude-sonnet-4-6",
  "tokens_in": 1500,
  "tokens_out": 800,
  "tool_name": "Edit",
  "file_paths": ["src/index.ts"],
  "duration_ms": 2500
}
```

## Integration Points

- **OutputCapture** (`packages/orchestrator/src/worker/output-capture.ts`): Primary integration — extend to write JSONL alongside event parsing
- **Phase-loop** (`packages/orchestrator/src/worker/phase-loop.ts`): Provides spec directory path; handles git staging at phase completion
- **Claude CLI output**: Source of init, complete, tool_use, tool_result, text, and error events

## Technical Notes

- `OutputCapture` already parses Claude CLI newline-delimited JSON output
- It tracks event types: init, tool_use, tool_result, text, complete, error
- Session ID is already extracted from init events
- Token counts may be available in `complete` events from Claude CLI

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | JSONL file created for every phase execution | 100% of runs | Check file existence after phase completion |
| SC-002 | All required fields present in each JSONL entry | No missing core fields | Validate against schema |
| SC-003 | JSONL file committed with spec artifacts | Every phase completion commit | Check git log for file inclusion |
| SC-004 | Append behavior across runs | No data loss | Run multiple workflows, verify all entries preserved |
| SC-005 | Cloud UI can parse and display entries | Entries load correctly | Integration test with workflow history component |

## Assumptions

- `OutputCapture` already has access to all needed event data from Claude CLI output
- Token counts are available in Claude CLI `complete` events
- The phase-loop's git commit step can be extended to include the JSONL file
- The JSONL file size will remain manageable (metadata only, not full conversation content)

## Out of Scope

- Full conversation content storage (handled by cluster relay)
- Cloud UI implementation (issues 3.3 and 3.4)
- JSONL file rotation or cleanup
- Real-time streaming of JSONL to cloud UI (future enhancement)
- Authentication/authorization for accessing JSONL data

## Dependencies

- **None** — can start immediately
- **Consumed by**: Issue 3.3 (workflow history), Issue 3.4 (conversation viewer)

## Reference

See `docs/cloud-platform-buildout-reference.md` in tetrad-development for full architectural context.

---

*Generated by speckit*
