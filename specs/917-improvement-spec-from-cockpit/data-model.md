# Data Model: `generacy cockpit mcp` tool schemas & event bus

This document defines the tool input schemas, tool result shapes, event-bus internal state, and cursor semantics for the MCP server. All schemas are Zod-based; the SDK's `zodToJsonSchema` bridge produces the JSON Schema advertised to Claude via the MCP `tools/list` handshake.

## Core primitives

### `IssueRefInput` (input)

Every mutation tool that takes an `<issue>` accepts this discriminated shape. Bare-number string is normalized against `resolveIssueContext` (cwd-inference, #850).

```ts
// packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts
import { z } from 'zod';

const IssueRefObject = z.object({
  owner: z.string().min(1).regex(/^[^/\s]+$/),
  repo: z.string().min(1).regex(/^[^/\s#]+$/),
  number: z.number().int().positive(),
});

const IssueRefString = z.string().min(1);  // Passed through resolveIssueContext; validation there

export const IssueRefInputSchema = z.union([IssueRefObject, IssueRefString]);
export type IssueRefInput = z.infer<typeof IssueRefInputSchema>;
```

**Normalization** (`ref-input.ts` `normalizeIssueRef`):
- Object form: validated via `IssueRefObject`, converted to `{ref: {owner, repo, number, nwo}, gh: GhCliWrapper}`.
- String form: passed verbatim into `resolveIssueContext({ issue: str })` — inherits bare-number → cwd-inference (from #850), qualified `owner/repo#N`, and URL forms.
- PR-kind check: after normalization, `gh api /repos/{owner}/{repo}/issues/{number}` returns a `pull_request` field iff the number resolves to a PR. If present *and* the tool called requires an issue (not a PR), returns `{status: "error", class: "wrong-kind", detail: ...}`. Applies to: `cockpit_status`, `cockpit_context`, `cockpit_advance`, `cockpit_resume`, `cockpit_queue`.

### `EpicRefInput` (input)

Same shape as `IssueRefInput`. Used by `cockpit_status` (which takes an epic ref) and `cockpit_await_events` (`epic` field).

```ts
export const EpicRefInputSchema = IssueRefInputSchema;
export type EpicRefInput = IssueRefInput;
```

Epic-shape validation (must be an epic per body content) is delegated to the internal `resolveEpic()` function; failures surface as `class: "not-an-epic"`.

### `GateNameInput` (input)

`cockpit_advance` and `cockpit_resume` take a gate name. Validated at schema time against the gate vocabulary (`listGates()` from `gate-vocabulary.ts`).

```ts
import { listGates } from '../gate-vocabulary.js';
export const GateNameInputSchema = z.enum(listGates() as [string, ...string[]]);
export type GateNameInput = z.infer<typeof GateNameInputSchema>;
```

Rejects unknown gate names at the MCP boundary → typed error result `{status: "error", class: "unknown-gate", detail: "valid gates: ..."}`.

## Tool result envelope (shared shape)

Every tool returns one of two shapes:

```ts
// packages/generacy/src/cli/commands/cockpit/mcp/errors.ts
export type ToolOkResult<T> = { status: 'ok'; data: T };
export type ToolErrorResult = {
  status: 'error';
  class: ErrorClass;
  detail: string;
  hint?: string;
};
export type ToolResult<T> = ToolOkResult<T> | ToolErrorResult;

export type ErrorClass =
  | 'invalid-args'       // Schema validation failed on input
  | 'wrong-kind'         // PR number passed where issue required (subsumes generacy#906)
  | 'unknown-gate'       // Gate name not in gate vocabulary
  | 'not-an-epic'        // Ref does not resolve to an epic body shape
  | 'gate-refusal'       // Active waiting-for:* differs from requested gate (advance/resume)
  | 'idempotent-noop'    // Not actually an error — advance already done, etc. Returned as `ok` with a `noop: true` field
  | 'transport'          // Network / gh CLI / GitHub API failure
  | 'invalid-cursor'     // await_events malformed / never-issued cursor (Q3-D)
  | 'not-worker'         // (Reserved) Worker-role refusal — surfaces at process startup, not per-call
  | 'internal';          // Unexpected uncaught exception at tool boundary
```

**`CockpitExit` → `class` mapping** (`errors.ts` `mapCockpitExitToToolError`):

| `CockpitExit.code` | Meaning | Mapped `class` |
|--------------------|---------|----------------|
| 1 | Transport failure (gh CLI, network, GitHub API) | `transport` |
| 2 | Argument/parse error | `invalid-args` |
| 3 | Gate refusal | `gate-refusal` |

The `idempotent-noop` case (advance-already-done, e.g., `advance.ts:122-127`) is returned as `{status: "ok", data: {...}}` with a `noop: true` field on `data`, not as an error — the caller's action already holds.

## Per-tool schemas

### `cockpit_status` (input + output)

```ts
export const CockpitStatusInputSchema = z.object({
  epic: EpicRefInputSchema,
});

export type CockpitStatusResult = ToolResult<{
  owner: string;
  repo: string;
  issue: number;
  rows: Array<{
    repo: string;
    issue: { number: number; url: string; state: string; labels: string[] };
    kind: 'issue' | 'pr';
    prNumber: number | null;
    checks: 'pending' | 'success' | 'failure' | 'none' | 'error';
    phaseToken: string | null;
    classified: { /* from classifyIssue */ };
  }>;
}>;
```

Output shape mirrors `renderJsonEnvelope` in `packages/generacy/src/cli/commands/cockpit/status/render-table.ts`. Parity test: `runStatus(fixture, {json: true}, deps)` output === `cockpit_status({epic}, deps)` result data.

### `cockpit_context` (input + output)

```ts
export const CockpitContextInputSchema = z.object({
  issue: IssueRefInputSchema,
});

export type CockpitContextResult = ToolResult<{
  ref: { owner: string; repo: string; number: number; nwo: string };
  activeGate: string | null;
  labels: string[];
  bundle: {
    /* gate-specific structured data emitted by runContext today */
  };
}>;
```

Output shape: the JSON envelope `runContext` emits today under `--json`.

### `cockpit_advance` (input + output)

```ts
export const CockpitAdvanceInputSchema = z.object({
  issue: IssueRefInputSchema,
  gate: GateNameInputSchema,
});

export type CockpitAdvanceResult = ToolResult<{
  ref: { owner: string; repo: string; number: number; nwo: string };
  gate: string;
  action: 'advanced' | 'already-advanced';
  completedLabel: string;
  commentUrl?: string;
  noop?: true;  // set when action === 'already-advanced'
}>;
```

Refusal path (active waiting-for:* differs) → `{status: "error", class: "gate-refusal", detail}`.

### `cockpit_resume` (input + output)

```ts
export const CockpitResumeInputSchema = z.object({
  issue: IssueRefInputSchema,
});

export type CockpitResumeResult = ToolResult<{
  ref: { owner: string; repo: string; number: number; nwo: string };
  action: 'resumed' | 'no-op';
  targetPhase: string;
  precedingGate: string;
  labelsAdded: string[];
  labelsRemoved: string[];
}>;
```

Refusal path (multiple `failed:*`, no preceding gate, conflicting `waiting-for:*`) → `{status: "error", class: "gate-refusal", detail, hint}`.

### `cockpit_queue` (input + output)

```ts
export const CockpitQueueInputSchema = z.object({
  epic: EpicRefInputSchema,
  phase: z.string().min(1),
});

export type CockpitQueueResult = ToolResult<{
  epic: { owner: string; repo: string; number: number };
  phase: string;
  queued: Array<{ repo: string; number: number; url: string }>;
  skipped: Array<{ repo: string; number: number; reason: string }>;
}>;
```

### `cockpit_merge` (input + output)

```ts
export const CockpitMergeInputSchema = z.object({
  pr: z.union([
    z.object({ owner: z.string(), repo: z.string(), number: z.number().int().positive() }),
    z.string().min(1),
  ]),
});

export type CockpitMergeResult = ToolResult<{
  pr: { owner: string; repo: string; number: number; url: string };
  action: 'merged' | 'fixer-spawned' | 'blocked';
  checksState: 'success' | 'failure' | 'pending' | 'none';
  mergeCommitSha?: string;
  fixerAgentId?: string;  // when action === 'fixer-spawned'
  reason?: string;         // when action === 'blocked'
}>;
```

Note: `cockpit_merge` accepts a *PR ref* (unlike other tools). PR-number-as-issue guard is inverted here — an issue number passed to `cockpit_merge` → `{class: "wrong-kind"}`. Symmetric enforcement.

### `cockpit_await_events` (input + output)

```ts
export const AwaitEventsInputSchema = z.object({
  epic: EpicRefInputSchema,
  cursor: z.string().optional(),           // undefined => start from head
  maxWaitMs: z.number().int().min(0).max(300_000).default(55_000),
  coalesceWindowMs: z.number().int().min(0).max(60_000).default(3_000),
  maxBatchSize: z.number().int().positive().max(4_096).default(256),
});
export type AwaitEventsInput = z.infer<typeof AwaitEventsInputSchema>;

export const AWAIT_EVENTS_DEFAULTS = Object.freeze({
  maxWaitMs: 55_000,
  coalesceWindowMs: 3_000,
  maxBatchSize: 256,
});

export type AwaitEventsResult = ToolResult<{
  events: CockpitStreamEvent[];  // Discriminated union from watch/stream-event.ts
  cursor: string;                 // Opaque; caller must pass verbatim on next call
  resetFrom?: 'expired';          // Present when server silently reset the cursor (Q3-D)
}>;

// Invalid-cursor error path (Q3-D):
//   {status: "error", class: "invalid-cursor", detail: "cursor 'xyz' was never issued"}
//   or "cursor 'xyz' is malformed (expected base64-encoded position)"
```

**Event body**: `CockpitStreamEvent` is the discriminated union defined in `packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts` — `CockpitEventSchema | PhaseCompleteEventSchema | EpicCompleteEventSchema`. Byte-equality guarantee: `JSON.stringify(event)` matches (structurally) the NDJSON line `cockpit watch` would emit for the same underlying transition. Verified by parity test.

## Event bus internal state

### `EventBus` (in `event-bus.ts`)

Per-orchestrator-process singleton keyed by epic ref. One bus subscribes to `runOnePoll` for its epic and broadcasts to zero-or-more waiting `cockpit_await_events` callers.

```ts
interface EventBusEntry {
  cursor: number;                   // Monotonically increasing
  event: CockpitStreamEvent;
  emittedAt: number;                // Date.now() at emit time
}

class EpicEventBus {
  private buffer: EventBusEntry[] = [];       // LRU-trimmed by cursor
  private nextCursor = 1;                     // 0 reserved for "never issued"
  private waiters: Array<{
    since: number;
    resolve: (batch: EventBusEntry[]) => void;
  }> = [];

  private readonly retentionCount: number;    // COCKPIT_MCP_EVENT_RETENTION_COUNT | 10_000
  private readonly retentionMs: number;       // COCKPIT_MCP_EVENT_RETENTION_MS | 600_000

  emit(event: CockpitStreamEvent): void;      // Append + notify all waiters
  waitFor(input: WaitInput): Promise<Batch>;  // Long-poll with coalesce window
  parseCursor(str: string | undefined): CursorParseResult;
}
```

### Cursor semantics

**Encoding**: cursor is a base64-encoded `{epic, position}` JSON object. Base64 makes the string opaque to the caller (invariant test asserts callers never try to parse it).

**Cursor classes** (returned from `parseCursor`):

```ts
type CursorParseResult =
  | { kind: 'valid'; position: number }         // In buffer or > buffer high-watermark (returns empty batch, waits)
  | { kind: 'expired'; requestedPosition: number }  // Position < buffer low-watermark
  | { kind: 'malformed' }                       // Not valid base64 or JSON
  | { kind: 'never-issued' }                    // Valid shape but no such cursor was ever emitted
  | { kind: 'wrong-epic'; requestedEpic: string; boundEpic: string };  // Cursor for a different epic → also 'invalid-cursor' class
```

**Q3-D behavior**:
- `malformed`, `never-issued`, `wrong-epic` → `{status: "error", class: "invalid-cursor", detail}`
- `expired` → silent reset to head: return events from *current* buffer tail with `resetFrom: "expired"`
- `valid` → normal path

**Retention behavior**:
- Events older than `retentionMs` are trimmed from the buffer.
- When buffer size exceeds `retentionCount`, oldest entries are trimmed.
- `buffer[0].cursor` is the low-watermark; any cursor referring to a position < low-watermark is `expired`.

## Batching algorithm (`cockpit_await_events`)

```
1. parseCursor(input.cursor) → parseResult
2. if parseResult.kind ∈ {malformed, never-issued, wrong-epic}: return {status: "error", class: "invalid-cursor"}
3. if parseResult.kind === 'expired': set resetFrom="expired", position = current buffer high-watermark
4. else: position = parseResult.position
5. drain events at (position, position+maxBatchSize] from buffer → batch
6. if batch.length === 0:
     6a. wait up to maxWaitMs for the first new emit; on timeout return {events: [], cursor: <same as input>}
     6b. on first emit: batch = [event]
7. wait up to coalesceWindowMs OR until batch.length === maxBatchSize (whichever first)
     append every event emitted in that window to batch (up to maxBatchSize)
8. return {events: batch.map(e => e.event), cursor: encode(batch[last].cursor), resetFrom?}
```

**Soft-cap semantics (Q5-D)**: `maxBatchSize` triggers early close of step 7. Caller re-arms with the returned cursor; next call drains from `position+maxBatchSize`.

**Ordering guarantee**: cursor is monotonic; events are appended to the buffer in `runOnePoll` order (which is watch NDJSON emit order). Batching preserves ordering trivially.

## Compose scaffolder env additions

```ts
// packages/generacy/src/cli/commands/cluster/scaffolder.ts (delta)
environment: [
  // ... existing entries ...
  'GENERACY_CLUSTER_ROLE=orchestrator',  // NEW — orchestrator service
],
// ... worker service ...
environment: [
  // ... existing entries ...
  'GENERACY_CLUSTER_ROLE=worker',        // NEW — worker service
],
```

Consumed by `cockpit mcp` at process startup (`mcp/index.ts`):

```ts
if (process.env['GENERACY_CLUSTER_ROLE'] === 'worker') {
  process.stderr.write(
    'Error: cockpit mcp: refusing to start on a worker container ' +
    '(GENERACY_CLUSTER_ROLE=worker). Register this server user-scope in the ' +
    'orchestrator container only.\n',
  );
  process.exit(2);
}
```

## Relationship to existing types

| This module | Reuses from                                             |
|-------------|---------------------------------------------------------|
| `IssueRefInput` (object form) | Mirrors `IssueRef` in `cockpit/resolver.ts:23-32` |
| `IssueRefInput` (string form) | Parsed by `resolveIssueContext` (#850)            |
| `GateNameInputSchema` | Built from `listGates()` in `cockpit/gate-vocabulary.ts` |
| `CockpitStreamEvent` | Imported from `cockpit/watch/stream-event.ts:CockpitStreamEventSchema` |
| `CockpitStatusResult.data.rows` | Same shape as `renderJsonEnvelope` output |
| `CockpitAdvanceResult` | Mirrors `runAdvance` structured intent (today emits text) |
| `EventBusEntry.event` | Byte-equal to `emit()` NDJSON body |
| Ref-kind check (issue vs PR) | Same `gh api /issues/{n}.pull_request` inspection used by generacy#906 CLI-side guard |

## Validation ordering

For every tool call:

1. **Schema validation** — Zod parses input; failures → `{status: "error", class: "invalid-args"}`.
2. **Ref normalization** — string form → `resolveIssueContext`; failures → `{status: "error", class: "invalid-args"}` (parse-issue errors).
3. **Ref-kind check** — for issue-requiring tools, verify not a PR; failures → `{status: "error", class: "wrong-kind"}`.
4. **Internal function invocation** — wrap in try/catch; `CockpitExit` mapped per table above.
5. **Success shape assembly** — build `data` object from function return + captured stdout envelope.
6. **stdout drain assertion** (dev-mode only) — assert nothing was written directly to `process.stdout` during the call.

Every layer surfaces the error class the caller should reason about; layer 4 is the only one whose taxonomy is inherited from the CLI's exit codes.
