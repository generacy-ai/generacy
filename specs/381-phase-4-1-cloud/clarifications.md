# Clarifications: Interactive Conversation Proxy in Orchestrator

## Batch 1 — 2026-03-14

### Q1: Relay Transport Architecture for Conversations
**Context**: The spec defines both REST endpoints (`POST /conversations`, etc.) and a new `conversation` relay message type with distinct cloud→cluster and cluster→cloud formats. The existing relay infrastructure routes `api_request` messages to Fastify via `inject()` and forwards SSE events on channels. Adding a new top-level relay message type is a significant architectural addition.
**Question**: Should conversation lifecycle operations (start/end/list) use REST-via-relay (existing `api_request`/`api_response` pattern routed to Fastify) while real-time I/O (stdin/stdout streaming) uses the new `conversation` relay message type? Or should all conversation communication use one pattern exclusively?
**Options**:
- A: Hybrid — REST-via-relay for lifecycle, new `conversation` message type for streaming I/O
- B: All REST — lifecycle and streaming both go through Fastify routes (streaming via SSE)
- C: All `conversation` message type — bypass Fastify entirely for conversations

**Answer**: *Pending*

### Q2: Claude CLI Interactive Mode with Structured Output
**Context**: The existing `CliSpawner` uses `-p --output-format stream-json` which is headless/print mode. The spec requires "interactive mode (not `--print` mode)" but also needs structured JSON output for parsing. It's unclear whether Claude CLI supports `--output-format stream-json` without the `-p` flag in true interactive mode.
**Question**: What is the expected CLI invocation for interactive conversations? Should we use true interactive mode (no `-p`) and parse unstructured output, or use `-p` with streaming JSON and simulate interactivity by writing to stdin between responses?
**Options**:
- A: True interactive mode — find a way to get structured output without `-p`
- B: Use `-p --output-format stream-json` and write messages to stdin (simulated interactive via piped stdin)
- C: Research Claude CLI capabilities first and decide based on what's supported

**Answer**: *Pending*

### Q3: Permission Handling in Interactive Conversations
**Context**: The existing workflow spawner uses `--dangerously-skip-permissions` for automation since no human is in the loop. For interactive conversations, a user IS actively present in the cloud UI. Tool permission requests (file edits, command execution, etc.) could either be auto-approved or forwarded to the user for explicit approval.
**Question**: Should interactive conversations auto-approve all tool permissions (using `--dangerously-skip-permissions`), or should permission prompts be forwarded through the relay for the user to approve/deny in the cloud UI?
**Options**:
- A: Auto-approve all permissions (`--dangerously-skip-permissions`) — simpler, matches workflow behavior
- B: Forward permission prompts to UI for user approval — safer, better UX, but requires bidirectional permission flow
- C: Configurable per-conversation — let the caller decide on start

**Answer**: *Pending*

### Q4: Working Directory Resolution
**Context**: The spec says `workingDirectory` specifies "which repo to run in" and technical notes say "Conversations run in the primary or dev repos, not in isolated worker directories." The orchestrator likely has configured repo paths. It's unclear whether `workingDirectory` is an absolute filesystem path from the caller or a logical repo identifier resolved by the orchestrator.
**Question**: How should the `workingDirectory` parameter be resolved? Is it a raw filesystem path provided by the cloud UI, or a repo identifier (e.g., "primary", "dev") that the orchestrator maps to a configured path? What validation should occur if the path doesn't exist?
**Options**:
- A: Absolute filesystem path — cloud UI sends the full path, orchestrator validates it exists
- B: Repo identifier — orchestrator maps names like "primary"/"dev" to configured paths
- C: Either — accept both, with repo identifiers resolved first, then fall back to absolute paths

**Answer**: *Pending*

### Q5: Output Streaming Channel
**Context**: The existing relay forwards SSE events on named channels (`workflows`, `queue`, `agents`). The spec defines cluster→cloud `conversation` messages with events like `output`, `tool_use`, `tool_result`. It's unclear whether conversation output should use the existing SSE event forwarding mechanism (adding a new `conversations` channel) or the new `conversation` relay message type, which would be a different transport path than existing event streaming.
**Question**: Should conversation output events be delivered via a new SSE channel (e.g., `conversations`) using the existing event forwarding infrastructure, or via the `conversation` relay message type as a separate streaming mechanism?
**Options**:
- A: New SSE channel — consistent with existing patterns, reuses event forwarding
- B: New `conversation` relay message type — dedicated path, better separation of concerns
- C: Both — SSE for local/direct access, relay message type for cloud access

**Answer**: *Pending*
