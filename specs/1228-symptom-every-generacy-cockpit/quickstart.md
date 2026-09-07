# Quickstart: Doorbell answer replay scoping and consumed cursor

**Feature**: #1228 | **Branch**: `1228-symptom-every-generacy-cockpit`

## Build & test

```bash
pnpm install
pnpm --filter @generacy-ai/cockpit build      # tailer imports resolveEpic types from dist/
pnpm --filter @generacy-ai/generacy build
pnpm --filter @generacy-ai/generacy test -- doorbell
```

## Behaviour after this feature

```bash
# Normal operation — nothing new to configure.
generacy cockpit doorbell owner/repo#123
```

- First start on an upgraded cluster with an existing backlog: replays only lines that
  are (a) newer than the recency window AND (b) in the bound epic's ref set. Everything
  else is logged at `info` and skipped.
- Subsequent starts: resume from the persisted cursor — zero re-emission of consumed
  lines (SC-001/002).
- Two doorbells for two epics in the same repo: independent cursors, disjoint emissions
  (SC-003).
- Cross-repo epic children: emitted (SC-004, closes #1111).

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `COCKPIT_ANSWERS_REPLAY_WINDOW_MS` | `86400000` (24 h) | Recency window on `answeredAt` for replay branches (fresh/stale cursor, rotation, truncation). Invalid values fall back to default with a `warn`. |
| `COCKPIT_ANSWERS_FILE` | `/workspaces/.generacy/cockpit/answers.ndjson` | Existing override; the cursor dir derives from its dirname. |

Cursor location: `<answersDir>/cursors/<owner>__<repo>__<n>.json` (lowercased). Safe to
delete — the next start takes the fresh-cursor path (window + scoping, not a full flood).

## Test matrix (FR-008)

| Case | Suite |
|---|---|
| Fresh cursor: window + scope bound the byte-0 replay; drops logged `info` | `answers-file-source.replay.test.ts` |
| Resumed cursor: only bytes past `offset` emitted; no window on resume | `answers-file-source.tail.test.ts` |
| Fully-consumed file: zero events on restart | `answers-file-source.tail.test.ts` |
| Rotation (ino change) / truncation (size shrink): window-bounded replay, cursor rewritten | `answers-file-source.tail.test.ts` |
| Same-repo foreign-epic answer: dropped + `info` with `gateId` | `answers-file-source.unit.test.ts` |
| Cross-repo in-scope child: emitted | `answers-file-source.unit.test.ts` |
| Unknown ref → `refreshOnMiss()` → late-created child emitted after refresh | `answers-file-source.unit.test.ts` |
| Unknown ref still foreign after refresh → dropped; throttle respected | `ref-set-holder.test.ts` |
| Cursor load/advance/flush, atomic rename, corrupt-file → null | `answers-cursor-store.test.ts` |
| No-holder (harness) mode keeps legacy repo compare | `answers-file-source.unit.test.ts` |

## Troubleshooting

- **Backlog replayed after upgrade?** Check the cursor file exists and its `ino` matches
  `stat -c %i` of the answers file; a volume change rotates the ino and legitimately
  takes the fresh-cursor (window-bounded) path.
- **In-scope answer not emitted?** If it was consumed by a previous run (cursor past it),
  that is at-most-once by design — the cloud gate record is still answered; the auto
  session's escape hatch re-derives/re-asks after 3 sweeps.
- **`cross-epic drop` for a just-added child?** The holder throttles miss refreshes to
  one per 30 s; a second answer after the throttle window will refresh and emit. Check
  `info` logs for the refresh attempt.
- **Verifying the finetooth reproduction (SC-005)**: point `COCKPIT_ANSWERS_FILE` at a
  copy of the 211-line file, start a doorbell for the bound epic, count emitted
  `gate-answer` lines vs `info` drops.
