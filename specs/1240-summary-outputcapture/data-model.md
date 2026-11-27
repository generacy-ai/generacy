# Data Model: Detect SPECKIT_IMPLEMENT sentinels inside stream-json envelopes

**Issue**: #1240 | **Branch**: `1240-summary-outputcapture`

No new persisted entities. All types below already exist except the internal envelope
duck-types, which are structural guards (not exported types).

## Existing types (unchanged)

### `ImplementPartialResult` (`packages/orchestrator/src/worker/types.ts:178`)

```ts
export interface ImplementPartialResult {
  partial?: boolean;
  tasks_completed?: number;
  tasks_remaining?: number;
  tasks_total?: number;
  /** Raw refs from `SPECKIT_IMPLEMENT_BLOCKED` sentinel (#1211). */
  blocked_on?: string[];
}
```

### Sentinel payloads (wire format, unchanged)

| Sentinel | Prefix | Payload |
|----------|--------|---------|
| Partial | `SPECKIT_IMPLEMENT_PARTIAL: ` | `ImplementPartialResult` JSON |
| Blocked | `SPECKIT_IMPLEMENT_BLOCKED: ` | `{ "on": string[] }` — must be a non-empty array |

### `OutputChunk` (unchanged)

Envelope lines keep producing exactly one chunk each (type normalized via `KNOWN_TYPES`);
raw sentinel lines keep producing one `text` chunk. The envelope scan produces **no**
additional chunks.

## Envelope shapes recognized by the scan (duck-typed, internal)

These are *tolerant structural matches*, not validated schemas. Any non-matching shape
yields no embedded text and is otherwise processed exactly as today.

### Assistant message envelope (FR-001)

```jsonc
{
  "type": "assistant",            // not required by the guard
  "message": {
    "content": [
      { "type": "text", "text": "…possibly multi-line text\nSPECKIT_IMPLEMENT_PARTIAL: {…}" }
      // non-text blocks (tool_use, …) are skipped
    ]
  }
}
```

Guard: `parsed.message` is a non-null object, `parsed.message.content` is an array;
each element contributes `text` iff it is a non-null object with `type === 'text'` and
`typeof text === 'string'`.

### Result envelope (FR-002)

```jsonc
{
  "type": "result",               // not required by the guard
  "result": "…final text\nSPECKIT_IMPLEMENT_PARTIAL: {…}"
}
```

Guard: `typeof parsed.result === 'string'`.

## State transitions (`OutputCapture._implementResult`)

Identical for raw-line and envelope-embedded sentinels (FR-004):

| Event | Transition |
|-------|-----------|
| Valid PARTIAL | `_implementResult = { ...parsed, blocked_on: parsed.blocked_on ?? prior.blocked_on }` — last-wins for PARTIAL's own fields, preserves prior `blocked_on` (#1211 Q2=A) |
| Valid BLOCKED (non-empty `on`) | `_implementResult = { ...(prior ?? {}), blocked_on: parsed.on }` |
| Malformed JSON / invalid `on` | `logger.warn`, state unchanged |
| Identical payload seen twice (FR-006) | Idempotent — state deep-equal to single observation |

## Validation rules

- Sentinel prefix must open a (trimmed) line — of raw stdout, or of a `\n`-split segment
  of embedded text.
- PARTIAL payload: any JSON object accepted (fields optional, matching current raw-line
  behavior).
- BLOCKED payload: `on` must be a non-empty `string[]`; otherwise warn + ignore.
- Envelope extraction never throws on unexpected shapes (missing fields, nulls, wrong
  types ⇒ no-op).
