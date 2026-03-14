# Data Model: Conversation Metadata JSONL Logging

## Core Types

### JournalEventType

```typescript
type JournalEventType =
  | 'phase_start'
  | 'phase_complete'
  | 'tool_use'
  | 'tool_result'
  | 'error';
```

### JournalEntry

The JSONL line format. All fields except the base fields are optional — included when available, omitted when not.

```typescript
interface JournalEntry {
  // Required fields (always present)
  timestamp: string;          // ISO 8601 format, e.g., "2026-03-14T10:30:00.000Z"
  phase: WorkflowPhase;       // "specify" | "clarify" | "plan" | "tasks" | "implement" | "validate"
  event_type: JournalEventType;
  session_id: string;         // From OutputCapture init event

  // Optional fields (included when available)
  model?: string;             // e.g., "claude-sonnet-4-6", from init event
  tokens_in?: number;         // Input token count from complete event
  tokens_out?: number;        // Output token count from complete event
  tool_name?: string;         // Tool name for tool_use/tool_result events
  tool_call_id?: string;      // Tool call ID for pairing tool_use → tool_result
  file_paths?: string[];      // File paths touched by tool
  duration_ms?: number;       // Tool execution duration (on tool_result only)
  error_message?: string;     // Error description (on error events only)
}
```

### Field Population by Event Type

| Field | phase_start | phase_complete | tool_use | tool_result | error |
|-------|:-----------:|:--------------:|:--------:|:-----------:|:-----:|
| timestamp | ✓ | ✓ | ✓ | ✓ | ✓ |
| phase | ✓ | ✓ | ✓ | ✓ | ✓ |
| event_type | ✓ | ✓ | ✓ | ✓ | ✓ |
| session_id | ✓ | ✓ | ✓ | ✓ | ✓ |
| model | ✓ | | | | |
| tokens_in | | ✓* | | | |
| tokens_out | | ✓* | | | |
| tool_name | | | ✓ | ✓ | |
| tool_call_id | | | ✓ | ✓ | |
| file_paths | | | ✓* | ✓* | |
| duration_ms | | | | ✓* | |
| error_message | | | | | ✓ |

*\* = best-effort, may be omitted*

## Internal State

### ConversationLogger Internal State

```typescript
class ConversationLogger {
  // Configuration
  private specDir: string;                    // Path to specs/{issue-number}/
  private filePath: string;                   // specDir + '/conversation-log.jsonl'

  // Phase state (reset per phase via setPhase/close)
  private currentPhase: WorkflowPhase | null;
  private sessionId: string;
  private model: string | undefined;

  // Buffer state
  private buffer: JournalEntry[];             // Pending entries to write
  private flushTimer: NodeJS.Timeout | null;  // 30s periodic flush timer

  // Tool duration tracking
  private toolStartTimes: Map<string, number>; // toolCallId → Date.now()

  // Flush thresholds
  static readonly FLUSH_EVENT_THRESHOLD = 50;
  static readonly FLUSH_INTERVAL_MS = 30_000;
}
```

## File Path Extraction Rules

### From tool_result Events
Uses existing `filePath` metadata extraction already in OutputCapture:
```typescript
chunk.metadata?.filePath → [filePath]
```

### From tool_use Events (Best-Effort)
Parse the tool input data for known tools:

| Tool | Input Field | Example |
|------|-------------|---------|
| Read | `file_path` | `"/workspaces/foo/src/index.ts"` |
| Write | `file_path` | `"/workspaces/foo/src/new-file.ts"` |
| Edit | `file_path` | `"/workspaces/foo/src/index.ts"` |
| Glob | `path` | `"/workspaces/foo/src/"` |
| Grep | `path` | `"/workspaces/foo/src/"` |
| Bash | — | Not extracted (too complex to parse) |
| Agent | — | Not extracted |

## JSONL File Structure

**Path**: `specs/{issue-number}/conversation-log.jsonl`

**Example content** (one JSON object per line):
```jsonl
{"timestamp":"2026-03-14T10:30:00.000Z","phase":"specify","event_type":"phase_start","session_id":"ses-abc-123","model":"claude-sonnet-4-6"}
{"timestamp":"2026-03-14T10:30:05.123Z","phase":"specify","event_type":"tool_use","session_id":"ses-abc-123","tool_name":"Read","tool_call_id":"tc-001","file_paths":["/workspaces/foo/src/index.ts"]}
{"timestamp":"2026-03-14T10:30:05.456Z","phase":"specify","event_type":"tool_result","session_id":"ses-abc-123","tool_name":"Read","tool_call_id":"tc-001","file_paths":["/workspaces/foo/src/index.ts"],"duration_ms":333}
{"timestamp":"2026-03-14T10:30:10.789Z","phase":"specify","event_type":"tool_use","session_id":"ses-abc-123","tool_name":"Write","tool_call_id":"tc-002","file_paths":["/workspaces/foo/specs/123/spec.md"]}
{"timestamp":"2026-03-14T10:30:11.234Z","phase":"specify","event_type":"tool_result","session_id":"ses-abc-123","tool_name":"Write","tool_call_id":"tc-002","file_paths":["/workspaces/foo/specs/123/spec.md"],"duration_ms":445}
{"timestamp":"2026-03-14T10:30:15.000Z","phase":"specify","event_type":"phase_complete","session_id":"ses-abc-123","tokens_in":15000,"tokens_out":8000}
{"timestamp":"2026-03-14T10:31:00.000Z","phase":"clarify","event_type":"phase_start","session_id":"ses-def-456","model":"claude-sonnet-4-6"}
```

## Validation Rules

- `timestamp` must be valid ISO 8601
- `phase` must be a valid `WorkflowPhase` value
- `event_type` must be a valid `JournalEventType` value
- `session_id` must be a non-empty string
- `tokens_in` and `tokens_out` must be non-negative integers when present
- `duration_ms` must be a non-negative integer when present
- `file_paths` must be an array of strings when present (may be empty)
- Each line must be valid JSON (parseable independently)

## Relationships

```
WorkflowPhase (existing) ──── JournalEntry.phase
     │
     ├── OutputChunk (existing) ──→ JournalEntry (new)
     │     │                           │
     │     │  type: 'tool_use'    ──→  event_type: 'tool_use'
     │     │  type: 'tool_result' ──→  event_type: 'tool_result'
     │     │  type: 'error'       ──→  event_type: 'error'
     │     │  type: 'init'        ──→  (extracts session_id, model)
     │     │  type: 'complete'    ──→  (extracts tokens for phase_complete)
     │     │  type: 'text'        ──→  (ignored — not logged)
     │     │
     │     └── metadata.filePath  ──→  JournalEntry.file_paths
     │
     └── PhaseResult (existing)
           │  sessionId           ──→  ConversationLogger.sessionId
           └── (not directly related to JournalEntry)
```
