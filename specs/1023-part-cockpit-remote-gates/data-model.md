# Data Model: Cockpit doorbell — tail answers file → gate-answer events

**Feature**: #1023 | **Branch**: `1023-part-cockpit-remote-gates`

## Overview

Four data entities are introduced or extended by this feature. All live in `packages/generacy/src/cli/commands/cockpit/`.

| Entity | File | Kind | Owner |
|---|---|---|---|
| `GateAnswerLine` | `watch/gate-answer.ts` | Wire schema (Zod) | Orchestrator writer (sibling) — this feature consumes only |
| `GateAnswerEvent` | `watch/gate-answer.ts` | Stream event variant (Zod) | This feature — new member of `CockpitStreamEvent` union |
| `AnswersFileSourceOptions` | `doorbell/answers-file-source.ts` | Constructor input (TS interface) | This feature |
| `TailerState` (private) | `doorbell/answers-file-source.ts` | Internal state machine | This feature (not exported) |

## E-1 — `GateAnswerLine` (wire schema)

Zod schema for a single line of `/workspaces/.generacy/cockpit/answers.ndjson`. Field shape is **authoritative in the epic-plan doc** ([`cockpit-remote-gates-plan.md`](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md) §"Answer NDJSON line"). This schema is the minimum a tailer needs to (a) filter by scope, (b) log cross-epic drops with `gateId`, (c) pass the rest through to the event variant unchanged.

**Minimum required fields** (this feature parses; expand as the epic-plan doc iterates — treat unknown fields as pass-through with `.passthrough()` / `z.record()`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `gateId` | `string` | yes | Opaque handle assigned by the orchestrator gate-record writer. Uniquely identifies the (scope, gate) pair. Used in cross-epic drop info logs. |
| `deliveryId` | `string` | yes | Idempotency token — the session dedups by this. Opaque to the tailer. |
| `scope` | `{ owner: string; repo: string; number: number }` OR equivalent scope-identifying shape from the epic-plan doc | yes | Used by Q1 filter. Compared against the bound `epicRef` (which the doorbell parses into `owner/repo#number` at `doorbell.ts:98-101`). |
| `answer` | `unknown` (pass-through) | yes | Operator payload (yes/no/free-text/multi-choice — shape defined by the gate record, not the tailer). Opaque to the tailer. |
| `answeredAt` | `string` (ISO 8601 datetime) | yes | Emitted upstream when the operator submitted. Used downstream for gate-currency validation; opaque to the tailer. |
| `answeredBy` | `string` | optional | Operator identity (populated by orchestrator writer). Opaque to the tailer. |
| `generation` | `number` (int, ≥ 0) | conditional | Required when the epic-plan doc's generation rules apply. Opaque to the tailer. |

**Zod definition** (illustrative; final shape must round-trip with the epic-plan doc):

```ts
export const GateAnswerLineSchema = z.object({
  gateId: z.string().min(1),
  deliveryId: z.string().min(1),
  scope: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
  }),
  answer: z.unknown(),
  answeredAt: z.string().datetime(),
  answeredBy: z.string().optional(),
  generation: z.number().int().nonnegative().optional(),
}).passthrough();

export type GateAnswerLine = z.infer<typeof GateAnswerLineSchema>;
```

**Validation rules**:
- Lines that fail `safeParse` are **skipped** with one `logger.warn` line including: file path, byte offset within the file at the start of the line, extractable `gateId` (best-effort — try `JSON.parse` and read `.gateId` if the shape is otherwise close; else omit).
- Duplicate `deliveryId` within the tailer's own emit stream is NOT deduped here — deduplication belongs to the session consuming the events (spec §Out of scope: "Applying answers").
- **Unknown fields are preserved** via `.passthrough()` — the event variant carries them through to the D.12 dispatch step opaquely.

## E-2 — `GateAnswerEvent` (`CockpitStreamEvent` variant)

New member of the `CockpitStreamEventSchema` discriminated union at `packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts`.

**Zod definition**:

```ts
export const GateAnswerEventSchema = z.object({
  type: z.literal('gate-answer'),
  ts: z.string().datetime(),          // emit time (set by the tailer, ISO 8601)
  gateId: z.string().min(1),          // copied from GateAnswerLine
  deliveryId: z.string().min(1),      // copied from GateAnswerLine
  epic: z.string().regex(/^[^/]+\/[^/]+#\d+$/), // "owner/repo#number" — the bound epicRef
  line: GateAnswerLineSchema,         // full validated line payload (pass-through preserved)
});

export type GateAnswerEvent = z.infer<typeof GateAnswerEventSchema>;
```

**Field derivation** (during emit):

| Field | Source |
|---|---|
| `type` | Literal `'gate-answer'` (discriminator). |
| `ts` | `new Date().toISOString()` at emit time. (Not the operator's `answeredAt` — that stays inside `line`.) |
| `gateId` | `line.gateId`. Hoisted so consumers can filter without `.line.gateId` re-parses. |
| `deliveryId` | `line.deliveryId`. Same hoist rationale. |
| `epic` | `${boundEpicRef}` — the tailer's constructor arg, verbatim. |
| `line` | The full parsed `GateAnswerLine` (with `.passthrough()` fields intact). |

**Relationship to existing variants**:

```text
CockpitStreamEvent (discriminatedUnion on 'type')
├── issue-transition        (existing, watch/emit.ts)
├── phase-complete          (existing, watch/aggregate-emit.ts)
├── epic-complete           (existing, watch/aggregate-emit.ts)
└── gate-answer             (NEW — this feature, watch/gate-answer.ts)
```

Consumers (`subscribeAndEmit`, `lineForEvent`, `EpicEventBus.emit`, `cockpit_await_events`) operate on the union type and require no signature changes to accept the new variant. Callers that dispatch on `type` (`doorbell.ts:187` `exitOnEpicComplete` check) simply add a new arm as needed; existing arms are unchanged.

## E-3 — `AnswersFileSourceOptions`

Constructor input for the new tailer. Mirrors `SmeeDoorbellSourceOptions` (`doorbell/smee-source.ts:35`) in shape and DI seams.

```ts
export interface AnswersFileSourceOptions {
  /** Bound epic ref in "owner/repo#number" form. Used to filter GateAnswerLine.scope. */
  epicRef: string;

  /** Absolute path to the answers NDJSON file. Default: '/workspaces/.generacy/cockpit/answers.ndjson'. */
  filePath?: string;

  /** Sink for validated, in-scope gate-answer events. Bridged to bus.emit + stdout writer by doorbell.ts. */
  onEvent: (event: GateAnswerEvent) => Promise<void>;

  /** Log seam. Same shape as SmeeDoorbellSourceOptions.logger. */
  logger: { warn: (msg: string) => void; info?: (msg: string) => void };

  /** Startup replay cap (line count). Default 10 000 to align with EpicEventBus.retentionCount. Infinity disables (test-only). */
  replayLineCap?: number;

  /** Fallback poll cadence when fs.watch misses events. Default 2 000 ms. */
  pollIntervalMs?: number;

  /** Whether to use fs.watch as the primary notification path. Default true. Tests set false for deterministic timing. */
  useFsWatch?: boolean;

  /** Test seam: clock injection. Default () => Date.now(). Also used for GateAnswerEvent.ts. */
  now?: () => number;

  /** Test seam: fs promises façade. Default node:fs/promises. */
  fs?: {
    stat: (path: string) => Promise<{ ino: number; size: number }>;
    open: (path: string, flags: string) => Promise<{
      read: (buf: Buffer, off: number, len: number, pos: number) => Promise<{ bytesRead: number }>;
      close: () => Promise<void>;
    }>;
    watch?: (path: string, opts?: { recursive?: boolean }) => AsyncIterable<{ eventType: string; filename: string | null }>;
  };
}
```

**Validation rules** (constructor):
- `epicRef` must match `/^[^/]+\/[^/]+#\d+$/`; otherwise throw.
- `replayLineCap` must be `> 0` or `Infinity`; otherwise throw.
- `pollIntervalMs` must be `≥ 100`; otherwise throw (defensive lower bound to prevent runaway wake-ups).

## E-4 — `TailerState` (private, internal)

Not exported. Tracked inside `AnswersFileSource` to survive fs.watch/poll interleaving, rotation, truncation, and dir-then-file appearance.

```ts
interface TailerState {
  mode: 'waiting-for-dir' | 'waiting-for-file' | 'replaying' | 'tailing' | 'stopped';
  lastKnownIno: number | null;
  lastKnownSize: number;   // bytes; the tailer's "have read up to here" offset
  replayLinesEmitted: number;
  replayLinesSkipped: number;  // count truncated by the 10 000-line cap
  running: boolean;
  fsWatchAbort: AbortController | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  fileHandle: /* opened Fd or null */ null;
}
```

**State transitions** (allowed):

```text
                                       (dir appears)
waiting-for-dir  ────────────────────►  waiting-for-file
                                                  │
                                                  │ (file appears)
                                                  ▼
                                              replaying
                                                  │
                                                  │ (replay drained; live-tail begins)
                                                  ▼
                                              tailing
                                                  │
                                                  │ (stop() called)
                                                  ▼
                                              stopped

  Any state ─── (rotation: ino change or size shrink) ─► reopen at offset 0
                                                          (subject to replayLineCap
                                                           if new file > cap)
```

**Rotation / truncation handling**:

- **Rotation** (ino changes): tailer treats the new file as fresh — enters `replaying` again with the cap, then `tailing`. Emits one `info` log naming the old + new ino.
- **Truncation** (ino same, size shrank): same as rotation — reopen at offset 0, replay from head (subject to cap).
- **Missing after appearance** (rare — file deleted mid-tail): return to `waiting-for-file`; next appearance re-enters `replaying`.

## Cross-Entity Invariants

1. **Every emitted `GateAnswerEvent.epic` equals the tailer's bound `epicRef`.** Enforced by the source filter (Q1). Cross-epic lines never produce an event.
2. **Every emitted event has a validated `line`.** Enforced by the `GateAnswerLineSchema.safeParse` at emit time (Q4).
3. **Bus `emit` cursor is monotonic across sources.** Existing `EpicEventBus.emit` guarantee (`mcp/event-bus.ts:145-150`) — the tailer just adds another producer.
4. **Startup replay never emits more than `replayLineCap` lines.** Enforced by the two-pass counter in the tailer (D-2 in plan.md). When truncated, exactly one `warn` reports the `[skippedFromByte, skippedToByte]` range.
5. **No emit fires after `stop()`.** Enforced by the `running` guard + `fsWatchAbort.abort()` before returning from `stop()`.
