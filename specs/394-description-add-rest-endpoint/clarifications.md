# Clarifications: Sessions REST Endpoint

## Batch 1 — 2026-03-19

### Q1: Pagination Convention
**Context**: The spec requests `?limit=N&offset=N` pagination, but the existing orchestrator API (e.g., workflows endpoint) uses `?page=N&pageSize=N` with a `{ items, pagination: { page, pageSize, total, hasMore } }` response envelope. Using a different convention would create an inconsistent API surface.
**Question**: Should the sessions endpoint use `limit/offset` as specified, or align with the existing `page/pageSize` pagination pattern used by the workflows endpoint?
**Options**:
- A: Use `limit/offset` as specified (different from existing endpoints)
- B: Use `page/pageSize` to match the existing workflows endpoint convention

**Answer**: B — Use `page/pageSize` to match the existing workflows endpoint convention. Consistency across the API is more important.

### Q2: Session Type Inference
**Context**: FR-006 requires inferring session `type` as `interactive` or `workflow` from `permissionMode` or `userType` in the JSONL data. However, the documented JSONL format only lists `type` (message type: `queue-operation`, `user`, `assistant`, `last-prompt`), `sessionId`, `uuid`, `timestamp`, `slug`, `gitBranch`, `message.model`, and `message.usage`. Neither `permissionMode` nor `userType` appear in the documented fields.
**Question**: What specific JSONL fields and values should be used to distinguish interactive from workflow sessions? Are `permissionMode`/`userType` present in the actual JSONL data but undocumented, or should we use a different heuristic?

**Answer**: `permissionMode` and `userType` ARE present in the actual JSONL data — they were discovered during exploration but not fully documented in the issue. Each user/assistant message line includes `"permissionMode": "bypassPermissions"` and `"userType": "external"`. For session type inference:
- **workflow**: sessions where messages were initiated by the orchestrator workflow engine (look for `queue-operation` entries with workflow-related metadata, or sessions triggered via the `-p` flag pattern)
- **interactive**: sessions with `"permissionMode": "bypassPermissions"` that were started via the conversation manager
- **developer**: sessions from VS Code / CLI usage (no `bypassPermissions`, typically `"permissionMode": "default"`)

However, for Phase 1 **don't over-invest in type inference**. A simple heuristic is fine — e.g., if the first user message has `permissionMode: "bypassPermissions"`, mark it as `automated`, otherwise `developer`. We can refine later.

### Q3: Workspace-to-Session Directory Mapping
**Context**: The orchestrator config maps workspace IDs to filesystem paths (e.g., `{ "main": "/workspaces/generacy" }`), but Claude Code stores sessions at `~/.claude/projects/-workspaces-{name}/{uuid}.jsonl` where the directory name is a path-encoded version. The implementation needs a reliable way to map from the configured workspace path to the corresponding Claude Code session directory.
**Question**: Should the implementation derive the Claude session directory by encoding the workspace path (replacing `/` with `-`, e.g., `/workspaces/generacy` → `-workspaces-generacy`), or is there a different mapping mechanism?

**Answer**: Yes, derive the Claude session directory by encoding the workspace path — replacing `/` with `-`. For example `/workspaces/todo-list-example1` → `-workspaces-todo-list-example1`. This is Claude Code's standard path encoding convention. You can verify by listing `~/.claude/projects/` and matching against configured workspace paths.

### Q4: Session Discovery Scope
**Context**: The issue says "list all sessions for configured workspaces," and the orchestrator config has a `workspaces` map. However, `~/.claude/projects/` may contain session directories for workspaces not in the orchestrator config (e.g., from ad-hoc VS Code usage).
**Question**: Should `GET /sessions` (without a workspace filter) return sessions only from workspaces registered in the orchestrator config, or should it scan all directories under `~/.claude/projects/`?
**Options**:
- A: Only configured workspaces (requires explicit registration)
- B: All directories under `~/.claude/projects/` (auto-discovers all sessions)

**Answer**: B — Scan all directories under `~/.claude/projects/`. Auto-discovery is better because it captures VS Code sessions and any ad-hoc usage without requiring explicit registration. The workspace filter parameter can still be used to narrow results when needed.

### Q5: Response Envelope Format
**Context**: The spec says the response is "a JSON array of session metadata objects" with "total count for pagination UI," but doesn't specify the exact envelope. The existing workflows endpoint returns `{ workflows: [...], pagination: { page, pageSize, total, hasMore } }`. Returning a flat array with total count would require a custom header or wrapper.
**Question**: Should the response follow the existing envelope pattern (e.g., `{ sessions: [...], pagination: {...} }`) or return a flat JSON array with total count in a response header?
**Options**:
- A: Envelope object matching existing pattern: `{ sessions: [...], pagination: {...} }`
- B: Flat JSON array with `X-Total-Count` header

**Answer**: A — Use the envelope object matching the existing pattern: `{ sessions: [...], pagination: { page, pageSize, total, hasMore } }`. Consistency with the workflows endpoint.
