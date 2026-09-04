# Contract: `AnswersCursorStore`

**Feature**: #1228 | **File**: `packages/generacy/src/cli/commands/cockpit/doorbell/answers-cursor-store.ts`

## Purpose

Persist the answers-file consumed position (`ino` + byte `offset`) per epic scope so a
doorbell restart resumes from the last consumed byte instead of replaying from byte 0
(FR-004). Durability matches the answers file itself: the cursor lives in a `cursors/`
subdirectory of the answers dir on the same volume (clarify Q4).

## Public Interface

```ts
export class AnswersCursorStore {
  constructor(opts: {
    answersFilePath: string;   // cursor dir derives from dirname()
    epicRef: string;           // owner/repo#N → filename <owner>__<repo>__<n>.json
    logger: { warn(m: string): void };
    fs?: FsFacade;             // test seam (shared with AnswersFileSource)
    flushDebounceMs?: number;  // default 500
    now?: () => number;
  });

  /** Read + validate the persisted cursor. Missing/corrupt/wrong-version ⇒ null.
   *  Never throws. */
  load(): Promise<{ ino: number; offset: number } | null>;

  /** Update the in-memory cursor; schedules a debounced persist. Synchronous.
   *  Monotonic within an ino — see Guarantee 5. */
  advance(ino: number, offset: number): void;

  /** Unconditionally rewrite the in-memory cursor (bypassing the monotonic
   *  guard) and schedule a persist. Called at the head of EVERY replay branch
   *  with `(ino, 0)` — see Guarantee 5. */
  reset(ino: number, offset: number): void;

  /** Force-persist the in-memory cursor now (atomic tmp+rename). Used at replay
   *  drain and stop(). Failures are logged at warn, never thrown. */
  flush(): Promise<void>;
}
```

## Guarantees

1. **Atomicity**: persisted state is written to a temp file in the same directory and
   `rename`d over the target — a reader never observes a partial cursor.
2. **Filename scoping**: `cursors/<owner>__<repo>__<n>.json`, owner/repo lowercased. Two
   epics in the same repo have distinct cursors; the same epic across restarts maps to
   the same file.
3. **No directory creation before first write**: `mkdir -p <answersDir>/cursors` happens
   lazily at first `flush()`. The store never creates the answers dir's *parent* chain
   beyond that subdir; the #1023 "no mkdir of parent dir" clause is preserved for the
   answers file itself.
4. **Fail-open reads, fail-quiet writes**: an unreadable/invalid cursor is `null` (fresh
   cursor path); a failed write warns and leaves the in-memory cursor authoritative for
   the process lifetime. Persistence failure must never stop the tailer.
5. **Monotonic within an ino, resettable at replay**: `advance()` with the same `ino`
   never persists a smaller `offset` than already recorded in memory, and a new `ino`
   resets the offset. That guard alone is NOT sufficient for **in-place truncation**,
   which keeps the same `ino`: without an explicit rewrite the guard swallows every
   advance below the pre-truncation high-water mark, `flush()` writes the stale (larger)
   offset back over a now-smaller file, and the next start takes the resume branch and
   skips every answer under that byte permanently. `AnswersFileSource` therefore calls
   `reset(ino, 0)` at the head of every replay branch (fresh/stale cursor, rotation,
   truncation), which is what makes the first-discovery `cursor.offset > stat.size` row
   below actually *rewrite* the cursor.
6. **Loss window**: at most `flushDebounceMs` of advances (plus an unflushed stop on
   crash) may be lost — acceptable per clarify Q2: re-emission is handled by the
   session's `superseded` acks; genuinely lost emits are recoverable via the cloud
   record + escape hatch.

## Cursor file shape

See `data-model.md` § AnswersCursor. `version: 1`; unknown versions read as `null`.
