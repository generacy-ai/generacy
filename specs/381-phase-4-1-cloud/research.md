# Research: Interactive Conversation Proxy

## 1. Claude CLI Interactive Mode Capabilities

### Current Usage (Workflow Worker)

The existing `CliSpawner` invokes Claude CLI as:
```bash
claude -p --output-format stream-json --dangerously-skip-permissions --verbose [--resume SESSION_ID] "PROMPT"
```

- `-p` (print mode): Single prompt, runs to completion, no stdin interaction
- `--output-format stream-json`: Newline-delimited JSON on stdout (`init`, `tool_use`, `tool_result`, `text`, `complete`, `error` event types)
- `--resume SESSION_ID`: Resumes a previous session (keeps MCP servers warm)

### Spike: Interactive Mode with Structured Output

**Question**: Does `claude --output-format stream-json` (without `-p`) support multi-turn interactive use over stdin/stdout?

**Expected behavior to test**:
1. Launch `claude --output-format stream-json`
2. Write a message to stdin
3. Receive structured JSON events on stdout
4. Write another message to stdin (multi-turn)
5. Confirm session state persists between turns

**Fallback approach**: If interactive + structured output is not supported:
- Use `-p --output-format stream-json --resume SESSION_ID` for each message
- Each user message spawns a new process that resumes the previous session
- Slightly higher latency (process spawn per turn) but guaranteed structured output
- Session ID captured from `init` event's `session_id` field

**Implementation note**: The `ConversationSpawner` should support both modes via a strategy pattern or configuration flag, allowing seamless switch once the spike is complete.

### Output Event Format (from `output-capture.ts`)

Claude CLI JSON events follow this structure:
```jsonl
{"type":"init","session_id":"abc123","model":"claude-sonnet-4-6",...}
{"type":"text","text":"Hello! How can I help?"}
{"type":"tool_use","tool_name":"Read","call_id":"call_1","input":{...}}
{"type":"tool_result","tool_name":"Read","call_id":"call_1","output":"...","filePath":"/path"}
{"type":"complete","tokens_in":1234,"tokens_out":567}
{"type":"error","message":"Something went wrong"}
```

Known types: `init`, `tool_use`, `tool_result`, `text`, `complete`, `error`

## 2. Transport Architecture Analysis

### Option A: Hybrid (SELECTED)

```
Cloud UI ──REST──> Cloud Server ──api_request──> Relay ──api_request──> Orchestrator
                                                                          │
                   ┌──────────────────────────────────────────────────────┘
                   │  (Fastify inject → conversation routes)
                   │
                   ▼
            ConversationManager.start() / .end() / .list()

Cloud UI <──conversation msg──< Cloud Server <──conversation msg──< Relay <──< Orchestrator
                                                                                    │
                   ┌────────────────────────────────────────────────────────────────┘
                   │  (stdout parsed → relay client.send())
                   ▼
            Real-time I/O streaming
```

**Lifecycle operations** (start/end/list): REST-via-relay using `api_request`/`api_response`. The `RelayBridge` already routes these through Fastify `inject()` — adding new routes is zero-cost on the relay side.

**Real-time streaming** (stdin/stdout): Dedicated `conversation` relay message type. Already defined in `cluster-relay/src/messages.ts` as `ConversationMessage { type: 'conversation', conversationId: string, data: unknown }`.

### Why Hybrid Wins

| Concern | REST-only | Relay-only | Hybrid |
|---------|-----------|------------|--------|
| Lifecycle operations | Natural fit | Awkward (no request-response) | Natural fit |
| Streaming I/O | Requires SSE/polling | Natural fit | Natural fit |
| Cloud tooling | Standard HTTP clients | Custom relay client needed | Mix — HTTP for CRUD, relay for streaming |
| Implementation cost | Need SSE channel for output | Need request-response wrapper | Uses both existing patterns |

### Option B: All REST (rejected)

Would require a new SSE channel for conversation output. The existing SSE system is designed for broadcast events (workflow status, queue updates), not per-conversation bidirectional streaming. Would need:
- New `conversations` SSE channel
- Per-conversation filtering in SSE subscriptions
- Stdin would still need relay messages (SSE is server→client only)

### Option C: All relay messages (rejected)

Lifecycle operations are request-response — start returns conversation metadata, list returns an array. Implementing request-response over relay messages requires correlation IDs and timeout handling. The existing `api_request`/`api_response` pattern already does this.

## 3. Process Management Patterns

### Existing Pattern (CliSpawner)

- `ProcessFactory.spawn()` → `ChildProcessHandle`
- stdout captured via `OutputCapture` (buffer + parse)
- Timeout: SIGTERM → grace period (5s) → SIGKILL
- AbortSignal propagation for graceful shutdown
- Exit promise for process completion

### Conversation Process Differences

| Aspect | Workflow (CliSpawner) | Conversation (ConversationSpawner) |
|--------|----------------------|-----------------------------------|
| Lifetime | Runs to completion | Long-lived, user-controlled |
| stdin | Not used (prompt via args) | Active — user messages written here |
| stdout | Buffered → PhaseResult | Streamed → relay in real-time |
| Timeout | Per-phase (configurable) | No timeout (user-controlled lifetime) |
| Concurrency | 1 per worker | Multiple per orchestrator (up to maxConcurrent) |
| Session resume | Between phases (`--resume`) | Within process (multi-turn) or per-message (`--resume`) |

### Process Cleanup Strategy

```
Normal end (user calls DELETE /conversations/:id):
  1. ConversationManager.end(id)
  2. Write EOF to stdin (close writable stream)
  3. SIGTERM to process
  4. Wait grace period (5s)
  5. SIGKILL if still alive
  6. Remove from active map
  7. Emit 'complete' conversation event through relay

Unexpected exit (process crashes/OOM):
  1. exitPromise resolves with non-zero code
  2. ConversationManager detects via exit handler
  3. Remove from active map
  4. Emit 'error' conversation event through relay with exit details

Orchestrator shutdown:
  1. ConversationManager.stop() called during graceful shutdown
  2. SIGTERM all active conversation processes
  3. Wait grace period
  4. SIGKILL remaining
  5. Emit 'error' events for all active conversations
```

## 4. Repo Identifier Resolution

### Design

The orchestrator maps logical workspace names to filesystem paths:

```typescript
// In config
conversations: {
  workspaces: {
    primary: '/home/node/workspace',
    dev: '/home/node/workspace-dev',
  }
}
```

**Resolution flow**:
1. Cloud sends `workingDirectory: "primary"`
2. `ConversationManager` looks up in config map
3. Validates path exists on filesystem
4. Passes resolved path as `cwd` to `ConversationSpawner`

**Security**: Only configured identifiers are accepted. No path traversal possible since the identifier is a key lookup, not a path component.

## 5. Concurrency & Resource Model

### Memory

- Each Claude CLI process: ~100-200MB resident (varies by model/context)
- 3 concurrent conversations: ~300-600MB additional memory
- No output buffering in ConversationManager — events streamed directly to relay

### CPU

- Claude CLI processes are I/O bound (waiting for API responses)
- Minimal CPU impact for 3 concurrent conversations
- Parser overhead negligible (newline-delimited JSON, one-pass)

### Limits

- Default `maxConcurrentConversations: 3` — configurable
- Enforced at `ConversationManager.start()` — returns 429 if at capacity
- No queue — rejected requests must retry (conversations are interactive, queuing doesn't make sense)

## 6. Technology Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| CLI mode | Spike first, fallback to `-p` + `--resume` | Unknown interactive + stream-json compatibility |
| Transport | Hybrid (REST lifecycle + relay streaming) | Matches spec, uses existing patterns |
| Process model | Separate ConversationSpawner | Different lifecycle from CliSpawner |
| Directory resolution | Config-based identifier map | Security, abstraction |
| State management | In-memory Map (no Redis) | Per-instance, no cross-node needed |
| Concurrency | Max 3, reject at capacity | Resource protection, configurable |
| Output parsing | Reuse OutputChunk types, new streaming parser | Consistency with existing model |
