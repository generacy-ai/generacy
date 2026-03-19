# Data Model: Add /sessions/:id REST Endpoint

## Core Entities

### SessionMessage

A single message in the conversation history. Three variants based on `role`:

```typescript
interface SessionMessage {
  /** Message role */
  role: 'user' | 'assistant' | 'tool_result';
  /** UUID from JSONL entry */
  uuid: string;
  /** Parent message UUID (for threading) */
  parentUuid?: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Content blocks (text, tool_use, tool_result) */
  content: ContentBlock[];
  /** Model used (assistant messages only) */
  model?: string;
  /** Token usage (assistant messages only) */
  usage?: TokenUsage;
}
```

### ContentBlock

Content within a message. Discriminated union on `type`:

```typescript
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}
```

### TokenUsage

Token counts from assistant message `message.usage`:

```typescript
interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
```

### SessionMetadata

Aggregated metadata for the session:

```typescript
interface SessionMetadata {
  /** Session identifier */
  sessionId: string;
  /** Session slug (from first assistant entry, null if none) */
  slug: string | null;
  /** Git branch (from first assistant entry, null if none) */
  branch: string | null;
  /** Model used (from first assistant entry) */
  model: string | null;
  /** Total input tokens across all assistant messages */
  totalInputTokens: number;
  /** Total output tokens across all assistant messages */
  totalOutputTokens: number;
  /** Number of messages in response (excluding queue-operation/last-prompt) */
  messageCount: number;
  /** Whether session is currently active */
  isActive: boolean;
}
```

### SessionResponse

Top-level API response:

```typescript
interface SessionResponse {
  metadata: SessionMetadata;
  messages: SessionMessage[];
}
```

## JSONL Entry Structure

Each line in the JSONL file has this shape (relevant fields):

```typescript
interface JsonlEntry {
  /** Entry type — only 'user' and 'assistant' are included */
  type: 'user' | 'assistant' | 'queue-operation' | 'last-prompt';
  /** Unique identifier */
  uuid: string;
  /** Parent message UUID */
  parentUuid?: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Session slug (on assistant and tool-result user entries) */
  slug?: string;
  /** Git branch */
  gitBranch?: string;
  /** The actual message content */
  message: {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
    model?: string;
    usage?: TokenUsage;
  };
}
```

## Transformation Rules

1. **Skip** entries with `type === 'queue-operation'` or `type === 'last-prompt'`
2. **User entries with text content**: Emit as `SessionMessage` with `role: 'user'`
3. **User entries with `tool_result` content blocks**: Extract each `tool_result` block → emit as separate `SessionMessage` with `role: 'tool_result'`
4. **Assistant entries**: Emit as `SessionMessage` with `role: 'assistant'`, include `model` and `usage`
5. **Metadata**: Extract `slug`, `gitBranch` from first assistant entry; accumulate `usage` totals

## Validation (Zod Schemas)

```typescript
// Query parameter validation
const SessionQuerySchema = z.object({
  workspace: z.string().optional(),
});

// Session ID parameter validation
const SessionParamsSchema = z.object({
  sessionId: z.string().min(1).max(128),
});
```

## Relationships

```
SessionResponse
├── metadata: SessionMetadata
│   └── isActive ← checked via ConversationManager.list()
└── messages: SessionMessage[]
    └── content: ContentBlock[]
        ├── TextBlock
        ├── ToolUseBlock
        └── ToolResultBlock (promoted from user entries)
```
