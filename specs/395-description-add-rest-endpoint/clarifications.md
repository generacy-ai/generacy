# Clarifications: Add /sessions/:id REST Endpoint

## Batch 1 — 2026-03-19

### Q1: Session JSONL File Location
**Context**: The spec assumes JSONL files are in "a known location within each workspace directory" (e.g., `~/.claude/projects/<project>/`). However, `~/.claude/projects/` is a global directory — it is NOT inside workspace directories. The orchestrator's workspace config maps IDs to workspace paths (e.g., `/workspaces/generacy`), but Claude Code session files live elsewhere. Implementation needs to know exactly where to look.
**Question**: What is the exact filesystem path pattern for Claude Code session JSONL files, and how should the endpoint locate a session file given a sessionId and optional workspaceId? Is there a mapping from workspace path → Claude Code project directory?
**Options**:
- A: Session files are at `~/.claude/projects/<workspace-path-hash>/<sessionId>.jsonl` (global location, workspace path hashed to find project dir)
- B: Session files are within the workspace directory itself (e.g., `<workspace>/.claude/sessions/<sessionId>.jsonl`)
- C: Use Claude Code CLI or API to discover session file locations

**Answer**: *Pending*

### Q2: Tool Result Extraction Strategy
**Context**: In Claude Code's actual JSONL format, tool results appear as content blocks within `user`-type entries (role "user" with `tool_result` content blocks), not as separate top-level entries. The spec's API response shape shows `tool_result` as a separate message type with its own `timestamp`, `tool_use_id`, `content`, and `is_error` fields. Implementation needs to know how to transform the source format.
**Question**: Should the endpoint extract tool_result content blocks from user-type JSONL entries and promote them to separate top-level messages in the response? Or should tool results remain nested within user messages?
**Options**:
- A: Extract tool_result blocks from user entries and emit as separate top-level messages (matching the spec's response shape)
- B: Keep tool results nested within user messages and adjust the response schema

**Answer**: *Pending*

### Q3: Queue-Operation and Last-Prompt Handling
**Context**: The spec states queue-operation and last-prompt JSONL entry types "may be skipped or minimally represented" (lines 78-79). This is ambiguous for implementation — skipping them entirely vs including minimal info changes the message array and count.
**Question**: Should queue-operation and last-prompt entries be excluded entirely from the response, or included with a minimal representation?
**Options**:
- A: Exclude entirely — skip these types during parsing, don't count them in messageCount
- B: Include with minimal representation (type + timestamp only, no content)

**Answer**: *Pending*

### Q4: Metadata Source for Slug and Branch
**Context**: The response schema includes `metadata.slug` and `metadata.branch` fields, but the JSONL entry structure described in the spec only contains message content, UUIDs, model, and usage data — no slug or branch fields. These values need to come from somewhere.
**Question**: Where should slug and branch metadata be sourced from? Are they stored in the JSONL file (e.g., in a header entry), derived from the filesystem path, read from a separate metadata file, or obtained from the orchestrator's ConversationManager state?
**Options**:
- A: Parsed from the JSONL file (specific entry type or header line)
- B: Derived from the workspace/project directory structure
- C: Read from a separate Claude Code metadata file alongside the JSONL
- D: Only available for active sessions via ConversationManager — omit for historical sessions

**Answer**: *Pending*

### Q5: In-Progress Session Reads
**Context**: The spec marks "Real-time streaming of in-progress sessions" as out of scope, but doesn't clarify whether a regular GET request should return the current snapshot of an active session (just without streaming updates). The assumption "JSONL files are not actively being written to during reads (or partial reads are acceptable)" suggests this might be intended.
**Question**: Should the GET endpoint serve partial data for sessions that are currently active (in-progress), returning whatever has been written to the JSONL file so far? Or should it only serve completed sessions?
**Options**:
- A: Serve whatever is in the JSONL file at read time (partial data for active sessions is acceptable)
- B: Only serve completed sessions — return 409 or similar if session is still active
- C: Serve partial data but include an `isActive: boolean` field in metadata

**Answer**: *Pending*
