# Feature Specification: Interactive Conversation Proxy in Orchestrator

**Branch**: `381-phase-4-1-cloud` | **Date**: 2026-03-14 | **Status**: Draft

## Summary

Add a new orchestrator capability to spawn Claude Code in interactive (non-workflow) mode, streaming stdin/stdout bidirectionally through the relay for cloud UI conversations. This enables real-time chat where users interact with Claude Code through the web UI — distinct from the automated workflow phases used by speckit.

## Context

The cloud UI needs to support interactive Claude Code conversations — not automated workflow phases, but real-time chat where users interact through the web UI. This enables agent-driven onboarding (issue 4.4) and general-purpose AI assistance from the cloud dashboard.

## Requirements

**Conversation lifecycle management**:
```typescript
interface ConversationManager {
  start(options: {
    conversationId: string;
    workingDirectory: string;  // which repo to run in
    initialCommand?: string;   // e.g., '/onboard-evaluate'
    model?: string;
  }): Promise<void>;

  sendMessage(conversationId: string, message: string): Promise<void>;

  end(conversationId: string): Promise<void>;

  list(): ConversationInfo[];
}
```

**Claude Code spawning**:
- Spawn `claude` CLI in interactive mode (not `--print` mode used by workflow workers)
- Set working directory to the specified repo path
- If `initialCommand` provided, send it as the first message
- Stream stdout as `conversation` messages through the relay
- Accept stdin from `conversation` messages received through the relay

**Multiplexing**:
- Support multiple simultaneous conversations (each with unique conversationId)
- Each conversation runs in its own Claude Code process
- Conversations are independent — different repos, different commands

**Process management**:
- Track active conversation processes
- Clean up on conversation end (SIGTERM → SIGKILL after timeout)
- Handle unexpected process exit (notify cloud UI)
- Resource limits: max concurrent conversations (configurable, default 3)

**API endpoints** (accessible via relay):
- `POST /conversations` — start a new conversation
- `POST /conversations/:id/message` — send a message
- `DELETE /conversations/:id` — end a conversation
- `GET /conversations` — list active conversations

**Relay message format**:
```typescript
// Cloud → Cluster
{ type: 'conversation', conversationId: string, action: 'start' | 'message' | 'end', data: any }

// Cluster → Cloud
{ type: 'conversation', conversationId: string, event: 'output' | 'tool_use' | 'tool_result' | 'complete' | 'error', data: any }
```

## Technical Notes

- Different from workflow worker execution — no label management, no phase loop, no spec directory
- The existing `CliSpawner` (`packages/orchestrator/src/worker/cli-spawner.ts`) spawns Claude in `--print` mode — this needs a different spawn mode for interactive use
- Claude CLI supports JSON output mode which will be needed for structured streaming
- Conversations run in the primary or dev repos, not in isolated worker directories
- Consider session resumption — if a conversation is interrupted, can it be resumed?

## Dependencies

- Phase 2 (relay infrastructure) for message transport
- Consumed by: issues 4.3 (chat UI), 4.4 (onboarding integration)

## Reference

See `docs/cloud-platform-buildout-reference.md` in tetrad-development for full architectural context.

## User Stories

### US1: Cloud Dashboard User Starts Interactive Chat

**As a** cloud dashboard user,
**I want** to start an interactive Claude Code conversation from the web UI,
**So that** I can get AI assistance on my codebase without needing a local terminal or CLI setup.

**Acceptance Criteria**:
- [ ] User can initiate a conversation targeting a specific repository
- [ ] Messages stream bidirectionally in real-time between the UI and Claude Code
- [ ] User sees Claude's output (text, tool use, tool results) as it happens
- [ ] Conversation can be ended cleanly from the UI

### US2: Cloud Dashboard User Runs Multiple Conversations

**As a** cloud dashboard user,
**I want** to run multiple independent conversations simultaneously,
**So that** I can work on different tasks or repos in parallel.

**Acceptance Criteria**:
- [ ] Multiple conversations can be active at the same time (up to configurable limit)
- [ ] Each conversation operates independently with its own Claude Code process
- [ ] Listing active conversations shows their status and target repos
- [ ] Conversations don't interfere with each other

### US3: Onboarding Flow Triggers Interactive Session

**As a** new user going through onboarding,
**I want** the onboarding flow to automatically start an interactive Claude Code session with a preset command,
**So that** the AI can evaluate my project and guide me through setup.

**Acceptance Criteria**:
- [ ] A conversation can be started with an `initialCommand` (e.g., `/onboard-evaluate`)
- [ ] The initial command is sent as the first message to Claude Code
- [ ] Output from the initial command streams back through the relay like any other conversation

### US4: System Handles Process Failures Gracefully

**As a** cloud platform operator,
**I want** conversation processes to be managed reliably,
**So that** unexpected exits don't leave orphaned processes or unresponsive UI sessions.

**Acceptance Criteria**:
- [ ] Unexpected Claude Code process exit sends an error event to the cloud UI
- [ ] Ending a conversation sends SIGTERM, then SIGKILL after timeout if needed
- [ ] Max concurrent conversation limit is enforced and returns an appropriate error when exceeded
- [ ] No orphaned processes remain after conversation cleanup

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | ConversationManager `start()` spawns Claude CLI in interactive mode with JSON output | P1 | Different from `--print` mode used by workers |
| FR-002 | ConversationManager `sendMessage()` writes to the Claude process stdin | P1 | Must handle backpressure |
| FR-003 | ConversationManager `end()` terminates the Claude process cleanly | P1 | SIGTERM → SIGKILL after timeout |
| FR-004 | ConversationManager `list()` returns active conversation metadata | P1 | |
| FR-005 | Stdout from Claude process is parsed and forwarded as relay messages | P1 | Events: output, tool_use, tool_result, complete, error |
| FR-006 | Incoming relay `conversation` messages are routed to the correct process | P1 | By conversationId |
| FR-007 | REST endpoints expose conversation lifecycle via relay | P1 | POST/DELETE/GET as specified |
| FR-008 | Configurable max concurrent conversations (default 3) | P2 | Return 429 when limit exceeded |
| FR-009 | Unexpected process exit sends `error` event to cloud UI | P1 | Include exit code and signal |
| FR-010 | Support `initialCommand` sent as first message on start | P2 | Enables onboarding integration |
| FR-011 | Support optional `model` parameter on conversation start | P3 | Pass to Claude CLI |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Conversation start latency | < 3s from request to first Claude output | Timestamp delta in relay messages |
| SC-002 | Message round-trip latency | < 500ms relay overhead (excluding Claude thinking time) | Timestamp delta for stdin write to first stdout chunk |
| SC-003 | Concurrent conversation support | 3+ simultaneous conversations without degradation | Load test with parallel sessions |
| SC-004 | Process cleanup reliability | 100% of ended conversations release resources | Monitor for orphaned processes after test runs |
| SC-005 | Unexpected exit handling | Error event delivered within 1s of process exit | Automated test with forced kill |

## Assumptions

- The relay infrastructure from Phase 2 is operational and supports bidirectional message passing
- Claude CLI is installed and accessible on the cluster nodes
- Claude CLI interactive mode supports JSON-structured output for parsing
- The cluster has sufficient resources to run multiple Claude Code processes concurrently
- Working directories (repo paths) are already checked out and accessible on the cluster

## Out of Scope

- Chat UI implementation (covered by issue 4.3)
- Onboarding flow logic (covered by issue 4.4)
- Session persistence/resumption across orchestrator restarts (future enhancement)
- Authentication/authorization for conversation access (handled at cloud API layer)
- Rate limiting beyond max concurrent conversations
- Conversation history storage (handled by cloud service)

---

*Generated by speckit*
