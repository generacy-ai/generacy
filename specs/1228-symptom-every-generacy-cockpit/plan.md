# Implementation Plan: Scope cockpit doorbell gate-answer replay by epic ref set and persist consumed position

**Feature**: Scope `AnswersFileSource` replay by the bound epic's resolved ref set and persist the consumed byte position per epic scope
**Branch**: `1228-symptom-every-generacy-cockpit`
**Status**: Complete
**Issue**: [generacy#1228](https://github.com/generacy-ai/generacy/issues/1228) | **Subsumes**: generacy#1111

## Summary

`generacy cockpit doorbell`'s answers-file tailer
(`packages/generacy/src/cli/commands/cockpit/doorbell/answers-file-source.ts`) currently
(a) replays the whole file from byte 0 on every process start and (b) scopes answers by an
owner/repo string compare against the bound epic. Two independent fixes, both cluster-side:

1. **Epic-ref-set scoping** (FR-001..003): replace the `processLine()` step (c) repo
   compare with a membership test against the bound epic's resolved ref set (epic +
   children), the same `buildRefSet` construction `SmeeDoorbellSource` uses. Before
   dropping an *unknown* ref, re-resolve the ref set (throttled, ≥30 s between
   miss-triggered refreshes) and drop only if still foreign. Cross-repo children are now
   emitted (closes #1111).
2. **Persisted consumed cursor** (FR-004..006): persist `{ ino, offset }` per epic scope
   at `<answersDir>/cursors/<owner>__<repo>__<n>.json` (atomic rename, debounced flush),
   advance on emit (at-most-once, emit = awaited `onEvent` resolved). A restart resumes
   from the cursor; a missing/stale cursor replays from byte 0 bounded by the ref-set test
   **plus** an `answeredAt` recency window (default 24 h,
   `COCKPIT_ANSWERS_REPLAY_WINDOW_MS`), which also bounds the rotation and truncation
   replay branches.

All clarifications are settled (see `clarifications.md`): Q1 → fresh-cursor replay with
recency window; Q2 → advance-on-emit; Q3 → re-resolve before dropping an unknown ref;
Q4 → cursor lives beside the answers file with the same durability.

## Technical Context

- **Language/runtime**: TypeScript (ESM), Node >= 22.
- **Package**: `packages/generacy` (`@generacy-ai/generacy`) only. Uses existing
  `resolveEpic` / `GhWrapper` / `ResolvedEpic` from `@generacy-ai/cockpit` (no changes
  there).
- **No new dependencies.** `zod` (already present) validates the cursor file shape.
- **Test framework**: existing vitest suites under
  `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/` with the established
  `FsFacade` fake-fs seam.
- Full stack notes: `specs/1228-symptom-every-generacy-cockpit/stack.md`.

## Design

### New module: `doorbell/ref-set-holder.ts` — `EpicRefSetHolder`

A single shared holder for the epic's resolved ref set, wired into both the primary source
and the answers tailer so one refresh feeds everyone (FR-002).

```ts
class EpicRefSetHolder {
  constructor(opts: {
    epicRef: string;                       // owner/repo#N
    gh?: GhWrapper;                        // absent ⇒ resolver-less (harness mode)
    logger; now?; resolve?;                // test seams (resolve defaults to resolveEpic)
    missRefreshMinIntervalMs?;             // default 30_000
  });
  get current(): RefSetView | null;        // null until first successful resolve
  get resolved(): ResolvedEpic | null;
  refresh(): Promise<void>;                // unthrottled; used by smee debounce/safety-net
  refreshOnMiss(): Promise<boolean>;       // throttled ≥30s; returns whether it resolved
}
```

- Production wiring (`doorbell.ts` `runDoorbell`): one holder created per run when
  `deps.gh` is present; the tailer takes it via a new `refSetHolder` option, and
  `SmeeDoorbellSource` takes the same holder — its existing `refreshRefSet()` delegates
  the `resolveEpic` call + storage to the holder (webhook-debounce and safety-net timers
  stay in the smee source; only the resolve/store moves). Poll-fallback mode has no smee
  source, so the holder alone serves the tailer, satisfying the Q3 requirement that a
  poll-mode doorbell is not blind to late-created children.
- Resolver-less mode (`COCKPIT_DOORBELL_HARNESS=1` — no `gh`): no holder is constructed;
  the tailer falls back to the current owner/repo compare (legacy behaviour) so the #1024
  hermetic harness is untouched. Recorded in `research.md` § D3.

### `AnswersFileSource` scope test (replaces `processLine()` step (c))

Order per line: (a) JSON.parse → (b) schema → **(c′) recency window (replay branches
only)** → **(c″) ref-set scope** → (d) build event → (e) emit → (f) cursor advance.

- (c″) with a holder: parse the issue-ref from `gateKey` (existing
  `parseIssueRefFromGateKey`); a non-issue target still bypasses scoping and is emitted.
  Membership key is `owner/repo#number` lowercased against `refSet.issues` (same casing
  rule as `webhook-to-event.ts`). On a miss: `await holder.refreshOnMiss()`, re-check,
  then drop + `info` log with `gateId` if still foreign. The Q1 window runs *before* the
  ref-set test so a fresh-cursor replay cannot fan out into per-line `resolveEpic` calls.
- (c″) without a holder: legacy case-insensitive owner/repo compare (unchanged).
- The `KNOWN LIMITATION` comment on `epicRef` is deleted; #1111 is closed by this work.

### New module: `doorbell/answers-cursor-store.ts` — `AnswersCursorStore`

- **Path**: `<dirname(filePath)>/cursors/<owner>__<repo>__<n>.json`, derived from the
  bound epic ref — per-epic-scope, so two epics in the same repo keep independent cursors.
  Same volume/lifetime as the answers file (Q4). `mkdir -p` of the `cursors/` subdir
  happens only at first persist — by then the answers dir exists (the tailer never
  creates the answers dir itself; that contract clause stands).
- **Shape** (zod-validated): `{ version: 1, ino: number, offset: number, updatedAt: ISO }`.
  Unreadable/invalid/mismatched-version ⇒ treated as missing (fresh-cursor path).
- **Write**: atomic `write tmp + rename`; flushes are debounced (~500 ms) with a final
  flush in `stop()` and after each replay drain. A lost tail-of-debounce write only
  re-emits a few lines after a crash — the session already acks those `superseded`.
- **Advance on emit** (Q2): the in-memory cursor moves to `lineEndByte` after the awaited
  `onEvent` resolves (stdout write callback + bus emit — the existing `answersOnEvent`
  already awaits exactly this). Lines *dropped* by scoping/window/malformed also advance
  the cursor once processed — consumption is positional, not per-emit.

### `AnswersFileSource` lifecycle changes

`lastKnownIno`/`lastKnownSize` become cursor-backed. On first file discovery:

| Cursor state vs `stat` | Behaviour |
|---|---|
| `cursor.ino === stat.ino && cursor.offset <= stat.size` | **Resume**: no replay; enter `tailing` and read `[offset, size)` as a normal tail (no recency window — these are unconsumed live lines). |
| Missing / invalid / `ino` mismatch / `offset > size` (stale) | **Fresh-cursor replay** from byte 0: recency window + ref-set scoping (FR-005), replay-line-cap kept as backstop. |
| Rotation (ino change) / truncation (size shrink) mid-run | Existing state table preserved (FR-006), but the replay is window-bounded like fresh-cursor, and the cursor is rewritten for the new ino. |

New options on `AnswersFileSourceOptions`: `refSetHolder?`, `replayWindowMs?` (default
24 h; `doorbell.ts` parses `COCKPIT_ANSWERS_REPLAY_WINDOW_MS`), `cursorStore?` /
`cursorDir?` (test seam). The `FsFacade` gains the minimal write surface the store needs
(`mkdir`, `writeFile`, `rename`, `readFile`) — kept on the façade so the existing fake-fs
unit-test pattern extends to cursor persistence.

### Wiring (`doorbell.ts`)

- Construct the holder (when `deps.gh` present) before the tailer; pass it to the tailer
  options and to `SmeeDoorbellSource`.
- Parse `COCKPIT_ANSWERS_REPLAY_WINDOW_MS` (positive integer; invalid ⇒ default + warn).
- Harness mode: unchanged except the tailer keeps legacy scoping (no holder).

## Project Structure (files touched)

```
packages/generacy/src/cli/commands/cockpit/
├── doorbell.ts                                  # wiring: holder, window env, cursor dir
└── doorbell/
    ├── answers-file-source.ts                   # scope test, cursor-driven replay/resume
    ├── ref-set-holder.ts                        # NEW — EpicRefSetHolder
    ├── answers-cursor-store.ts                  # NEW — AnswersCursorStore
    ├── smee-source.ts                           # delegate resolve/store to holder
    └── __tests__/
        ├── answers-file-source.replay.test.ts   # fresh-cursor, window, cap
        ├── answers-file-source.unit.test.ts     # scope membership, miss-refresh
        ├── answers-file-source.tail.test.ts     # resume, rotation, truncation
        ├── answers-cursor-store.test.ts         # NEW
        └── ref-set-holder.test.ts               # NEW
specs/1023-part-cockpit-remote-gates/contracts/answers-file-source.md   # FR-007 update
specs/1228-symptom-every-generacy-cockpit/contracts/                    # new contracts
.changeset/1228-doorbell-answer-replay-scope.md                         # patch, @generacy-ai/generacy
```

## Requirement → design mapping

| FR | Where |
|---|---|
| FR-001 | `processLine` (c″) membership test via `EpicRefSetHolder` + `buildRefSet` |
| FR-002 | `refreshOnMiss()` throttle; holder shared with smee source (webhook + safety-net feed it) |
| FR-003 | membership is full `owner/repo#number` — cross-repo children pass; closes #1111 |
| FR-004 | `AnswersCursorStore`, advance-on-emit, debounced atomic persist |
| FR-005 | fresh/stale-cursor replay: window (before ref-set test) + scoping; window drops at `info` |
| FR-006 | rotation/truncation branches keep the state table, now cursor-backed + window-bounded |
| FR-007 | update `specs/1023-.../contracts/answers-file-source.md`; new contracts in this spec dir |
| FR-008 | test matrix in `quickstart.md` § Tests |

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo — standing CLAUDE.md invariants
apply instead:

- **Changeset gate**: non-test `packages/generacy/src/` changes ⇒ a new
  `.changeset/*.md` (patch bump — defect fix) must be added during implement.
- Out of scope respected: no cloud changes, no `auto.md` invariant #7 change, no rotation
  threshold tuning.
- `resolveIssueContext` rule: not applicable (no new cockpit CLI verbs).

## Risks

- **Smee-source refactor blast radius**: moving resolve/store into the holder touches a
  working source. Mitigated by keeping debounce/timer logic in place and only delegating
  the resolve call; existing smee integration tests must stay green.
- **Cursor written for dropped lines**: positional consumption means a *wrongly* dropped
  line is unrecoverable — this is why FR-002's refresh-before-drop exists; the escape
  hatch (cloud record + re-derive/re-ask after 3 sweeps) is the documented backstop.
- **Harness mode divergence**: legacy scoping is retained there deliberately; documented
  in research.md so it is not "fixed" accidentally.

## Next step

Run `/speckit:tasks` to generate the dependency-ordered task list.
