# Data Model: Doorbell answer replay scoping and consumed cursor

**Feature**: #1228 | **Branch**: `1228-symptom-every-generacy-cockpit`

## Entities

### AnswersCursor (persisted, new)

One JSON file per epic scope at `<answersDir>/cursors/<owner>__<repo>__<n>.json`
(owner/repo lowercased in the filename; `answersDir = dirname(answersFilePath)`).

```ts
const AnswersCursorSchema = z.object({
  version: z.literal(1),
  /** inode of the answers file the offset indexes. */
  ino: z.number().int().nonnegative(),
  /** Next unconsumed byte (end byte of the last processed line, incl. newline). */
  offset: z.number().int().nonnegative(),
  /** Diagnostic only — never used for staleness decisions. */
  updatedAt: z.string().datetime(),
});
type AnswersCursor = z.infer<typeof AnswersCursorSchema>;
```

**Validation / staleness rules** (evaluated against `stat(answersFile)`):

| Condition | Classification | Behaviour |
|---|---|---|
| File missing, unreadable, invalid JSON, schema-fail, wrong `version` | missing | fresh-cursor replay |
| `cursor.ino !== stat.ino` | stale (rotated while down) | fresh-cursor replay, cursor rewritten for new ino |
| `cursor.offset > stat.size` | stale (truncated while down) | fresh-cursor replay from byte 0 |
| `cursor.ino === stat.ino && cursor.offset <= stat.size` | valid | resume: tail `[offset, size)`, no replay |

**Write discipline**: atomic `tmp + rename`; debounced (~500 ms); explicit flush on
`stop()` and at replay drain. Advance is positional: every processed line (emitted,
window-dropped, foreign-dropped, malformed) moves `offset` to its `lineEndByte` after
processing completes — for emitted lines, "completes" means the awaited `onEvent`
resolved (Q2, at-most-once).

### EpicRefSetHolder (in-memory, new)

Shared scope oracle for the doorbell's sources.

```ts
interface EpicRefSetHolder {
  /** null until the first successful resolve (or always null in resolver-less mode). */
  readonly current: RefSetView | null;
  readonly resolved: ResolvedEpic | null;
  /** Unthrottled resolve — smee debounce/safety-net path. Failures logged, state kept. */
  refresh(): Promise<void>;
  /** Throttled (>=30s between resolves) — tailer unknown-ref path. */
  refreshOnMiss(): Promise<void>;
}
```

State: `{ current, resolved, lastMissRefreshAt }`. A failed refresh retains the previous
set (never degrades to null after first success).

### RefSetView (existing, unchanged — `doorbell/webhook-to-event.ts`)

```ts
interface RefSetView {
  epicRef: string;         // "owner/repo#N" (operator casing)
  epicNumber: number;
  epicRepo: string;
  issues: Set<string>;     // "owner/repo#n", repo lowercased — the scope-test key
  prs: Set<string>;
  watchedRepos: Set<string>;
}
```

The tailer's membership test uses `issues` only, keyed
`${owner.toLowerCase()}/${repo.toLowerCase()}#${number}` — same casing rule as
`buildRefSet` / `webhookToStreamEvent`.

### GateAnswerLine (existing, FROZEN — `watch/gate-answer.ts`)

Down-path Shape 3; not modified. Fields used by this feature:

- `gateKey: string` — `<owner>/<repo>#<issue>:<gateType>:<generation>`; issue-ref = up to
  first `:`; may be a non-issue target (bypasses scoping, emitted).
- `answeredAt: ISO datetime` — recency-window input; already zod-validated per line.
- `gateId`, `deliveryId` — logging / event identity, unchanged.

## Extended options (existing types)

```ts
interface AnswersFileSourceOptions {
  // ...existing (epicRef, filePath, onEvent, logger, replayLineCap,
  //              pollIntervalMs, useFsWatch, now, fs)...
  /** Shared scope oracle. Absent ⇒ legacy owner/repo compare (harness mode). */
  refSetHolder?: EpicRefSetHolder;
  /** Recency window for replay branches. Default 86_400_000. */
  replayWindowMs?: number;
  /** Cursor persistence. Absent ⇒ derived from filePath; injectable for tests. */
  cursorStore?: AnswersCursorStore;
}
```

`FsFacade` gains `mkdir(path, {recursive})`, `readFile(path)`, `writeFile(path, data)`,
`rename(from, to)` — optional members so existing fakes that only read stay valid for
read-only tests.

## Relationships

```
doorbell.ts (runDoorbell)
 ├── EpicRefSetHolder (1 per run, only when gh present)
 │     ├─ read/refreshed-by → SmeeDoorbellSource (debounce + safety-net triggers)
 │     └─ read/miss-refreshed-by → AnswersFileSource (processLine step c″)
 └── AnswersFileSource
       └── AnswersCursorStore (1 per run, keyed by epic scope + answers dir)
             └─ indexes → answers.ndjson (ino + byte offset)
```

## Per-line decision pipeline (processLine, revised)

```
(a) JSON.parse            fail → warn, advance cursor
(b) GateAnswerLineSchema  fail → warn, advance cursor
(c′) recency window       [replay branches only] answeredAt < now-window
                          → info "window drop" (gateId), advance cursor
(c″) scope test           issue-ref parsed?
                          no  → emit (non-issue target)
                          yes → in refSet.issues? → emit
                                miss → holder.refreshOnMiss(); re-check
                                     → in set → emit
                                     → still foreign → info "cross-epic drop"
                                       (gateId, scope, boundEpic), advance cursor
                          [no holder: legacy owner/repo compare]
(d) build GateAnswerEvent (unchanged)
(e) await onEvent         (unchanged)
(f) cursor ← lineEndByte; debounced persist
```
