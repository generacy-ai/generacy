# Feature Specification: ## Phase 4

**Branch**: `381-phase-4-1-cloud` | **Date**: 2026-03-14 | **Status**: Draft

## Summary

## Phase 4.1 — Cloud Platform Buildout

### Summary
Add a new orchestrator capability to spawn Claude Code in interactive (non-workflow) mode, streaming stdin/stdout bidirectionally through the relay for cloud UI conversations.

### Context
The cloud UI needs to support interactive Claude Code conversations — not automated workflow phases, but real-time chat where users interact through the web UI. This enables agent-driven onboarding (issue 4.4) and general-purpose AI assistance from the cloud dashboard.

### Requirements

**Conversation lifecycle management**:
```typescript
interface ConversationManager {
  start(options: {
    conversationId: string;
    workingDirectory: string;  // repo identifier ("primary", "dev") resolved by orchestrator
    initialCommand?: string;   // e.g., '/onboard-evaluate'
    model?: string;
    skipPermissions?: boolean; // default true; false enables permission forwarding to UI
  }): Promise<void>;

  sendMessage(conversationId: string, message: string): Promise<void>;

  end(conversationId: string): Promise<void>;

  list(): ConversationInfo[];
}
```

**Claude Code spawning**:
- Research CLI capabilities first: determine if `--output-format stream-json` works without `-p` flag for true interactive multi-turn over stdin; fallback is `-p --output-format stream-json` with `--resume` for per-message invocations
- Set working directory to the resolved repo path (orchestrator maps repo identifiers to filesystem paths)
- If `initialCommand` provided, send it as the first message
- Stream stdout as `conversation` messages through the relay
- Accept stdin from `conversation` messages received through the relay
- Permission handling: `skipPermissions` option (default `true`) controls whether `--dangerously-skip-permissions` is used; when `false`, permission prompts are forwarded to UI for approval

**Multiplexing**:
- Support multiple simultaneous conversations (each with unique conversationId)
- Each conversation runs in its own Claude Code process
- Conversations are independent — different repos, different commands

**Process management**:
- Track active conversation processes
- Clean up on conversation end (SIGTERM → SIGKILL after timeout)
- Handle unexpected process exit (notify cloud UI)
- Resource limits: max concurrent conversations (configurable, default 3)

**API endpoints** (accessible via REST-over-relay using existing `api_request`/`api_response` pattern):
- `POST /conversations` — start a new conversation
- `POST /conversations/:id/message` — send a message
- `DELETE /conversations/:id` — end a conversation
- `GET /conversations` — list active conversations

**Relay message format** (dedicated `conversation` message type for real-time I/O streaming):
```typescript
// Cloud → Cluster (stdin streaming)
{ type: 'conversation', conversationId: string, action: 'message', data: any }

// Cluster → Cloud (stdout streaming)
{ type: 'conversation', conversationId: string, event: 'output' | 'tool_use' | 'tool_result' | 'complete' | 'error', data: any }
```

**Transport architecture** (Hybrid):
- Lifecycle operations (start/end/list) use REST-via-relay through existing Fastify routes
- Real-time I/O streaming uses dedicated `conversation` relay message type — bidirectional, per-conversation-id multiplexed, separate from SSE event forwarding

### Technical Notes
- Different from workflow worker execution — no label management, no phase loop, no spec directory
- The existing `CliSpawner` (`packages/orchestrator/src/worker/cli-spawner.ts`) spawns Claude in `--print` mode — this needs a different spawn mode for interactive use
- Claude CLI supports JSON output mode which will be needed for structured streaming — spike needed to confirm `--output-format stream-json` works without `-p` flag
- `workingDirectory` uses repo identifiers (e.g., "primary", "dev") mapped to configured paths by the orchestrator — no raw filesystem paths exposed through relay
- Consider session resumption — if a conversation is interrupted, can it be resumed?
- Permission handling is configurable per-conversation via `skipPermissions` (default `true` for v1)

### Dependencies
- Phase 2 (relay infrastructure) for message transport
- Consumed by: issues 4.3 (chat UI), 4.4 (onboarding integration)

### Reference
See `docs/cloud-platform-buildout-reference.md` in tetrad-development for full architectural context.

### Labels
`process:speckit-feature`

## User Stories

### US1: Cloud UI Interactive Conversation

**As a** cloud dashboard user,
**I want** to start interactive Claude Code conversations from the web UI,
**So that** I can get real-time AI assistance and run agent-driven tasks against my repos without needing local CLI access.

**Acceptance Criteria**:
- [ ] Can start a conversation targeting a specific repo (by identifier)
- [ ] Can send messages and receive streamed responses in real-time
- [ ] Can end a conversation and have the process cleaned up
- [ ] Can run multiple simultaneous conversations (up to configured limit)
- [ ] Conversation lifecycle uses REST-via-relay; streaming uses dedicated conversation message type

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | ConversationManager with start/sendMessage/end/list | P1 | Core lifecycle |
| FR-002 | Claude CLI spawning with structured JSON output | P1 | Spike needed for interactive mode support |
| FR-003 | REST endpoints for lifecycle via existing relay pattern | P1 | Fastify routes |
| FR-004 | Dedicated `conversation` relay message type for streaming | P1 | Bidirectional, multiplexed |
| FR-005 | Repo identifier resolution to filesystem paths | P1 | No raw paths through relay |
| FR-006 | Configurable `skipPermissions` per conversation | P2 | Default true for v1 |
| FR-007 | Max concurrent conversations limit (default 3) | P2 | Configurable |
| FR-008 | Process cleanup on end (SIGTERM → SIGKILL) | P1 | |
| FR-009 | Unexpected process exit notification to cloud UI | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Conversation round-trip latency | < 500ms for relay overhead | Measure time from message send to first output event |
| SC-002 | Concurrent conversation support | 3+ simultaneous conversations | Load test with parallel sessions |
| SC-003 | Process cleanup reliability | 100% cleanup on end/crash | Monitor for orphaned processes |

## Assumptions

- Phase 2 relay infrastructure is operational and supports new message types
- Claude CLI supports structured JSON output in some form usable for interactive conversations
- Orchestrator has configured workspace paths for repo identifier resolution

## Out of Scope

- Bidirectional permission forwarding UI (deferred; `skipPermissions: true` for v1)
- Session resumption after process crash (noted for future consideration)
- Chat UI implementation (issue 4.3)
- Onboarding integration (issue 4.4)

---

*Generated by speckit*
