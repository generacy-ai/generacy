# Contract: `AnswersFileSource`

**Feature**: #1023 | **File**: `packages/generacy/src/cli/commands/cockpit/doorbell/answers-file-source.ts`

## Purpose

A doorbell wake source that tails `/workspaces/.generacy/cockpit/answers.ndjson`, scopes each
line to the bound epic's resolved **ref set** (epic + children, cross-repo included), validates
each line, and delivers `GateAnswerEvent`s to a caller-supplied sink. Peer of
`SmeeDoorbellSource` — same DI shape, same lifecycle, same log seam.

The consumed byte position is **persisted** per epic scope (`AnswersCursorStore`), so a doorbell
restart resumes from the last consumed byte instead of replaying from byte 0. When no valid
cursor exists (fresh/stale cursor, rotation, truncation), the tailer replays from byte 0 bounded
by an `answeredAt` recency window **and** the ref-set scope.

Updated for #1228 — see the FR-004..006 (persisted cursor) and FR-001..003 (ref-set scoping)
sections below. Harness mode (constructed without a ref-set holder) retains the legacy
owner/repo string compare.

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
| `replaying` | File present, no valid cursor (fresh/stale/rotation/truncation) — replay from byte 0, window + scope applied | Replay drains (or cap hit) → `tailing`; file rotated mid-replay → re-enter `replaying`; `stop()` → `stopped` |
| `tailing` | Replay drained OR resumed from persisted cursor (`[offset, size)`, no window, no replay) — live-tail active | Rotation/truncation → `replaying`; file/dir removed → `waiting-for-file` / `waiting-for-dir`; `stop()` → `stopped` |
| `stopped` | `stop()` called (flushes cursor) | Terminal |

### First-discovery / cursor state table

Evaluated once when the file is first discovered (`lastKnownIno == null`):

| Cursor state | Condition | Action |
|---|---|---|
| Valid resume | `cursor.ino === stat.ino && cursor.offset <= stat.size` | Resume tail from `[offset, size)` — **no replay, no window**, ref-set scope still applies |
| Fresh (no cursor) | `load()` → null (missing/unreadable/invalid/wrong-version) | Replay from byte 0, window + ref-set scope |
| Stale ino | `cursor.ino !== stat.ino` | Replay from byte 0, window + ref-set scope; rewrite cursor for the new ino |
| Stale offset | `cursor.offset > stat.size` (truncation since last run) | Replay from byte 0, window + ref-set scope; rewrite cursor |

The cursor is advanced positionally to `lineEndByte` after every **consumed** line — a line
that reached a terminal decision, which includes window/foreign/malformed drops — and is
flushed at replay drain and in `stop()`. Every replay branch first calls
`cursorStore.reset(ino, 0)`: an in-place truncation keeps the same ino, so the store's
monotonic-within-ino guard would otherwise swallow the lowered offset and persist a stale
one over a smaller file (see `1228…/contracts/answers-cursor-store.md` Guarantee 5).

A line is **not** consumed — the cursor stays short of it and the reader stops the pass so
the next tick re-reads it — when:

| Deferral | Why |
|---|---|
| The awaited `onEvent` sink rejected | FR-004 defines the cursor as advancing *on emit*; advancing past a rejected emit is a silent, permanent single-answer loss |
| `stop()` raced the emit (`running` went false mid-line) | Same — the line was never emitted |
| The ref-set miss could not be re-resolved (`refreshOnMiss()` → `throttled-stale`) | FR-002 requires a re-resolve *before* dropping; a throttle window armed by a **failed** resolve has not provided one |

Deferral is self-limiting: sink rejections retry every poll interval and the stale-throttle
window expires within `missRefreshMinIntervalMs` (~30 s), after which the miss resolves or
fails for real and a terminal decision is made. A `throttled` outcome whose window was armed
by a *successful* resolve is authoritative and drops immediately, so a foreign backlog cannot
stall the tailer.

When the ref-set oracle has **never** resolved successfully (`holder.current === null` —
a startup GitHub 403 / rate limit), the scope test **fails open** to the legacy
case-insensitive owner/repo compare with a `warn`, because a null set rejects every answer
including the bound epic's own.

## FR / Q Mapping

| Behaviour | Spec FR / Q |
|---|---|
| Wait for parent dir before file | Q2 → B |
| Wait for file before tailing | Spec §Scope "handle file-not-yet-existing" |
| Startup replay of pre-existing content | Spec §Scope "replay of lines not yet acked on doorbell start" |
| Cap startup replay at last 10 000 lines + `warn` naming skipped range | Q5 → C |
| Scope by bound epic's resolved **ref set** (epic + children, cross-repo) before emit | #1228 FR-001..003 |
| On unknown ref, throttled re-resolve (`refreshOnMiss`, ≤1/30s) before dropping | #1228 FR-002 |
| Cross-repo epic children now emitted (previously dropped by owner/repo compare) | #1228 FR-003 (closes #1111) |
| Harness mode (no ref-set holder) keeps legacy case-insensitive owner/repo compare | #1228 FR-003 |
| Non-issue gateKey target bypasses scoping and emits | #1228 FR-001 |
| Log cross-epic drops at `info` with `gateId`, `scope`, bound `epicRef` | Q1 → C / #1228 |
| Persist consumed `{ino, offset}` per epic scope; resume from cursor on restart | #1228 FR-004..006 |
| Recency-window pre-filter on **replay branches only** (default 24 h) | #1228 FR-005 |
| Skip malformed lines + `warn` via injected logger | Q4 → A |
| Interleave freely with smee events (no drain barrier) | Q3 → A |
| No `mkdir` of parent dir (cursor store lazily `mkdir`s only its `cursors/` subdir) | Q2 → B |
| Handle rotation (inode change) + truncation (size shrink), now window-bounded | Spec §Scope "rotation/truncation" |

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
| Cross-epic line dropped (out of ref set after `refreshOnMiss`) | `info` | file path, byte offset, `gateId`, source `scope`, bound `epicRef` |
| Out-of-window line dropped on replay | `info` | file path, byte offset, `gateId`, `answeredAt` |
| Replay-cap truncation on startup | `warn` | file path, `[skippedFromByte, skippedToByte]`, skipped line count |
| Cursor persist failure | `warn` | cursor path, error (never throws) |
| Scope miss deferred (`throttled-stale`) | `info` | file path, byte offset, `gateId`, source `scope`, bound `epicRef` |
| Scope oracle never resolved — fail-open to owner/repo | `warn` | file path, byte offset, `gateId`, bound `epicRef` |
| `onEvent` sink rejected (line deferred, not consumed) | `warn` | file path, byte offset, `gateId`, error |
| Invalid `COCKPIT_ANSWERS_REPLAY_WINDOW_MS` (in caller) | `warn` | raw value, default applied |
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
- `refSetHolder` — an `EpicRefSetHolder` supplying `current.issues` (the resolved ref set) and
  `refreshOnMiss()`. Omit it to exercise legacy harness-mode owner/repo scoping.
- `cursorStore` — an `AnswersCursorStore` for `load`/`advance`/`flush`. The default store uses the
  injected `fs`; a read-only `fs` façade (no write methods) makes `load()` return null and
  `advance`/`flush` no-op, preserving the byte-0 replay behavior in existing unit tests.
- `cursorDir` — overrides the cursor directory (default `<dirname(answersFilePath)>/cursors`) so
  tests can point the store at a scratch path.
- `replayWindowMs` — the recency window for replay branches (default 86 400 000 ms). Small values
  in tests force the window-drop branch deterministically alongside injected `now`.

## Non-Goals

- The source does NOT dedup by `deliveryId`. That is the session's job (spec §Out of scope).
- The source does NOT apply answers to gate records. That is `auto.md` P4 (spec §Out of scope).
- The source does NOT create the answers file or its parent dir (Q2 → B; sibling P1 issue owns the writer).
- The source does NOT emit `doorbell-warning` NDJSON on stdout (Q4 option C explicitly rejected).
