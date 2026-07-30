# Contract: `AnswersFileSource`

**Feature**: #1023 | **File**: `packages/generacy/src/cli/commands/cockpit/doorbell/answers-file-source.ts`

## Purpose

A doorbell wake source that tails `/workspaces/.generacy/cockpit/answers.ndjson`, filters by the bound `epicRef`, validates each line, and delivers `GateAnswerEvent`s to a caller-supplied sink. Peer of `SmeeDoorbellSource` — same DI shape, same lifecycle, same log seam.

## Public Interface

```ts
export class AnswersFileSource {
  constructor(options: AnswersFileSourceOptions);

  /** Starts the tailer. Returns after startup replay drains OR startup is aborted.
   *  Idempotent: repeated calls after the first are a no-op. Never throws for
   *  missing dir / missing file — those trigger the wait states, not errors. */
  start(): Promise<void>;

  /** Stops the tailer. Cancels fs.watch, clears the poll timer, closes any
   *  open file handle. Idempotent. */
  stop(): Promise<void>;

  /** Introspection for tests / diagnostics. */
  getState(): 'waiting-for-dir' | 'waiting-for-file' | 'replaying' | 'tailing' | 'stopped';
}
```

## Lifecycle Contract

| State | Entry condition | Exit conditions |
|---|---|---|
| `waiting-for-dir` | Parent dir absent at `start()` | Dir appears → `waiting-for-file`; `stop()` → `stopped` |
| `waiting-for-file` | Dir present, file absent | File appears → `replaying`; dir removed → `waiting-for-dir`; `stop()` → `stopped` |
| `replaying` | File present, tailing not yet started | Replay drains (or cap hit) → `tailing`; file rotated mid-replay → re-enter `replaying`; `stop()` → `stopped` |
| `tailing` | Replay drained, live-tail active | Rotation/truncation → `replaying`; file/dir removed → `waiting-for-file` / `waiting-for-dir`; `stop()` → `stopped` |
| `stopped` | `stop()` called | Terminal |

## FR / Q Mapping

| Behaviour | Spec FR / Q |
|---|---|
| Wait for parent dir before file | Q2 → B |
| Wait for file before tailing | Spec §Scope "handle file-not-yet-existing" |
| Startup replay of pre-existing content | Spec §Scope "replay of lines not yet acked on doorbell start" |
| Cap startup replay at last 10 000 lines + `warn` naming skipped range | Q5 → C |
| Filter by bound `epicRef` before emit | Q1 → C |
| Log cross-epic drops at `info` with `gateId` | Q1 → C |
| Skip malformed lines + `warn` via injected logger | Q4 → A |
| Interleave freely with smee events (no drain barrier) | Q3 → A |
| No `mkdir` of parent dir | Q2 → B |
| Handle rotation (inode change) + truncation (size shrink) | Spec §Scope "rotation/truncation" |

## Emit Contract

**Every emitted `GateAnswerEvent` satisfies**:

1. `event.type === 'gate-answer'`
2. `event.epic === options.epicRef` (verbatim string equality)
3. `event.line` passed `GateAnswerLineSchema.safeParse`
4. `event.gateId === event.line.gateId`
5. `event.deliveryId === event.line.deliveryId`
6. `event.ts` is an ISO 8601 datetime string set at emit time (not the operator's `answeredAt`)

**Order guarantee**: within the tailer, events are emitted in file-append order (byte offset). Cross-source ordering (vs. smee, vs. poll) carries no guarantee beyond the bus's per-emit monotonic cursor (Q3 → A).

**Backpressure**: `onEvent` is awaited before the next line's emit. A slow sink slows the tailer — this is desired: the bus's `emit()` is synchronous and the harness stdout is line-buffered, so the natural pipe is the throttle.

## Logging Contract

All log lines go through the injected `logger`. No direct `process.stderr.write` from the source. Stdout is never written from this source directly — the caller's `onEvent` bridges emissions to the shared stdout writer.

| Situation | Level | Fields |
|---|---|---|
| Malformed line skipped | `warn` | file path, byte offset at line start, extractable `gateId` (best-effort) |
| Cross-epic line dropped | `info` | file path, byte offset, `gateId`, source `scope`, bound `epicRef` |
| Replay-cap truncation on startup | `warn` | file path, `[skippedFromByte, skippedToByte]`, skipped line count |
| Rotation detected | `info` | file path, old ino, new ino |
| Truncation detected (ino same, size dropped) | `info` | file path, ino, old size, new size |
| Directory absent at start | `info` | parent dir path, "waiting" |
| File absent at start | `info` | file path, "waiting" |

## Test Seams

All non-deterministic surfaces are injectable:

- `now: () => number` — for deterministic `event.ts` and rotation timestamps.
- `fs` façade — allows unit tests to simulate rotation/truncation without touching the real filesystem.
- `useFsWatch: false` — disables `fs.watch`; tailer relies only on `pollIntervalMs`. Used by the deterministic replay test.
- `pollIntervalMs` — small values (e.g., 10 ms) in tests to keep suites fast.
- `replayLineCap` — small caps (e.g., 5) in tests to force the truncation branch without needing 10 000 lines.

## Non-Goals

- The source does NOT dedup by `deliveryId`. That is the session's job (spec §Out of scope).
- The source does NOT apply answers to gate records. That is `auto.md` P4 (spec §Out of scope).
- The source does NOT create the answers file or its parent dir (Q2 → B; sibling P1 issue owns the writer).
- The source does NOT emit `doorbell-warning` NDJSON on stdout (Q4 option C explicitly rejected).
