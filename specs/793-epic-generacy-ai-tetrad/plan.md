# Implementation Plan: Journal-based stuck detection (G5.2)

**Feature**: Epic: generacy-ai/tetrad-development#85 | Phase: P5 | Tier: v3-polish | Issue: G5.2
**Branch**: `793-epic-generacy-ai-tetrad`
**Status**: Complete

## Summary

Add a passive liveness sensor to `@generacy-ai/cockpit` that, for any issue
classified `active` via `agent:in-progress`, reads the worker's conversation
journal and reports whether the journal's most recent entry is stale beyond a
configured threshold. Wire the signal into both surfaces:

- **status** — annotate each row with `stuck` / `stuckReason`; renderer marks
  stale rows in the table column and in the `--json` envelope.
- **watch** — on transitions `(not-stuck → stuck)` emit a `stuck` event; on
  transitions `(stuck → not-stuck-but-still-agent:in-progress)` emit a
  `recovered` event. Label-driven exits from `agent:in-progress` continue to
  flow through the existing `label-change` event (no double-fire).

Cockpit is a sensor only — it never moves labels and never touches the journal
file. Threshold lives in `.generacy/config.yaml`. Missing or unreadable
journals are not stuck (logged to stderr).

## Technical Context

| Aspect | Decision |
|---|---|
| Language | TypeScript (ES2022, NodeNext) |
| Runtime | Node.js ≥ 22 |
| Package | `@generacy-ai/cockpit` (existing) |
| New module | `packages/cockpit/src/journal.ts` |
| Test framework | vitest (existing) |
| Deps added | none — uses `node:fs/promises`, `node:path` only |
| Config home | `.generacy/config.yaml` → `cockpit.stuckThresholdMinutes` |
| Journal path | `specs/{issue-number}/conversation-log.jsonl` (clarif. Q3=B) |
| Wiring shells | `packages/generacy/src/cli/commands/cockpit/status.ts` + `watch.ts` |

Constraints inherited from clarifications:

- **Q1=A**: Missing journal → `stuck=false`, `stuckReason=null`. No stateful
  label-acquisition tracking.
- **Q2=A**: `recovered` fires only on journal-advance. Label-driven exit
  reuses the existing `label-change` event; dedupe in the diff layer.
- **Q3=B**: Read `specs/{n}/conversation-log.jsonl` — actual writer path.
- **Q4=A**: Unreadable / corrupt → fold into `stuckReason='no-journal'`.
  Cause logged to stderr. Two reasons total: `'stale' | 'no-journal'`.
- **Q5=A**: Config-only threshold. No `--stuck-threshold` CLI flag.

## Project Structure

```
packages/cockpit/
├── src/
│   ├── journal.ts                       # NEW — pure liveness reader
│   ├── __tests__/
│   │   └── journal.test.ts              # NEW — unit tests
│   ├── config/
│   │   ├── schema.ts                    # MOD — add stuckThresholdMinutes
│   │   └── loader.ts                    # MOD — pass through new field
│   ├── types.ts                         # MOD — export StuckReason union
│   └── index.ts                         # MOD — re-export journal API
└── package.json                         # unchanged

packages/generacy/src/cli/commands/cockpit/
├── status.ts                            # MOD — call journal sensor, pass to row
├── status/
│   ├── row.ts                           # MOD — add stuck / stuckReason cols
│   └── render-table.ts                  # MOD — render stale marker
├── watch.ts                             # MOD — thread threshold to poll loop
└── watch/
    ├── snapshot.ts                      # MOD — IssueSnapshot.stuck/stuckReason
    ├── poll-loop.ts                     # MOD — call sensor, attach to snapshot
    └── diff.ts                          # MOD — emit stuck / recovered events
```

Owns (per issue): `packages/cockpit/src/journal.ts` + `status/watch` wiring.
No orchestrator changes — the journal is read where it is written today.

## Components

### 1. `packages/cockpit/src/journal.ts` (new)

Pure async function. Single responsibility: given an issue number, return
`{ stuck, stuckReason, lastEntryAt }`.

```ts
export type StuckReason = 'stale' | 'no-journal' | null;

export interface JournalLivenessResult {
  stuck: boolean;
  stuckReason: StuckReason;
  lastEntryAt: string | null;   // ISO of last journal entry, or null
}

export interface ReadJournalLivenessOptions {
  issueNumber: number;
  thresholdMinutes: number;
  cwd?: string;                                // for testability
  now?: () => Date;                            // for testability
  logger?: { warn: (msg: string) => void };    // stderr by default
}

export async function readJournalLiveness(
  options: ReadJournalLivenessOptions,
): Promise<JournalLivenessResult>;
```

Behavior:

1. Path: `{cwd ?? process.cwd()}/specs/{issueNumber}/conversation-log.jsonl`.
2. `fs.stat` — `ENOENT` → `{stuck:false, stuckReason:null, lastEntryAt:null}`.
3. `fs.readFile` — any I/O error → log to stderr, return
   `{stuck:false, stuckReason:'no-journal', lastEntryAt:null}`. **No throw.**
   (Per Q1=A *for missing*; per Q4=A unreadable folds into `no-journal`.)
4. Split on `\n`, drop empty trailing line, parse last non-empty line as JSON.
   - Parse failure → walk backward up to 32 lines to find the most recent
     parsable entry. None found → log to stderr, return
     `{stuck:false, stuckReason:'no-journal', lastEntryAt:null}`.
5. Read `timestamp` field (ISO 8601). Invalid → same `'no-journal'` fallback.
6. `ageMs = now() - parsed.timestamp`. `stuck = ageMs > thresholdMinutes*60_000`.
   - `stuckReason = stuck ? 'stale' : null`.

Cost ceiling: synchronous-on-call, one stat + one read per `agent:in-progress`
issue per poll. No background timers, no cache (the underlying file mtime is
already the cache key; recomputing is cheap).

### 2. `packages/cockpit/src/config/schema.ts` (mod)

Add one optional field:

```ts
stuckThresholdMinutes: z.number().int().positive().default(15),
```

Default 15 — long enough that quiescent phase boundaries don't trip; short
enough that a stuck worker is visible within one human work-block.

### 3. `packages/cockpit/src/config/loader.ts` (mod)

Pass the parsed value through into `LoadedCockpitConfig.config`. No env-var
override (Q5=A).

### 4. `packages/cockpit/src/types.ts` (mod)

Export `StuckReason` so consumers don't import from `journal.js`.

### 5. `packages/cockpit/src/index.ts` (mod)

Re-export:

```ts
export {
  readJournalLiveness,
  type StuckReason,
  type JournalLivenessResult,
  type ReadJournalLivenessOptions,
} from './journal.js';
```

### 6. status wiring

`packages/generacy/src/cli/commands/cockpit/status.ts`:

- Read `loaded.config.stuckThresholdMinutes`.
- After classifying an issue, **only when** `classified.state === 'active'`
  **and** `classified.sourceLabel === 'agent:in-progress'`, call
  `readJournalLiveness({ issueNumber: issue.number, thresholdMinutes, ... })`.
  Skip for all other states and for PRs (zero extra I/O on the common path).
- Thread `{ stuck, stuckReason }` into `buildStatusRow(...)`.

`packages/generacy/src/cli/commands/cockpit/status/row.ts` — add fields:

```ts
stuck: boolean;
stuckReason: StuckReason;
```

`packages/generacy/src/cli/commands/cockpit/status/render-table.ts`:

- TTY: postfix the `STATE` column with ` !` when `row.stuck === true`
  (or render a new `STUCK` column — see contracts/journal.md for the table).
- `--json` envelope: pass `stuck` and `stuckReason` through `StatusRow` as
  emitted today (no schema-version bump needed; the fields are additive).

### 7. watch wiring

`packages/generacy/src/cli/commands/cockpit/watch.ts`:

- Read `loaded.config.stuckThresholdMinutes` and thread it into `runOnePoll`
  via `PollDeps.stuckThresholdMinutes`.

`packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts` — add fields
to `IssueSnapshot`:

```ts
stuck: boolean;
stuckReason: StuckReason;
```

`packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts`:

- After `classifyIssue`, when the same gate (`active` + `agent:in-progress`)
  matches, call `readJournalLiveness` and attach to the snapshot.
  All other paths set `stuck:false, stuckReason:null` so the diff layer
  doesn't need to special-case missing fields.

`packages/generacy/src/cli/commands/cockpit/watch/diff.ts`:

- Extend `CockpitEventDiscriminator` with `'stuck' | 'recovered'`.
- In `diffIssue`:
  - `prev.stuck === false && curr.stuck === true` → emit `stuck` event.
    `from = curr.classified.state`, `to = curr.classified.state`,
    `sourceLabel = curr.classified.sourceLabel`, extra field
    `stuckReason: curr.stuckReason`.
  - `prev.stuck === true && curr.stuck === false`
    **and** the issue is still classified `active` via `agent:in-progress`
    → emit `recovered` event. If the issue left `agent:in-progress`, the
    existing `label-change` event already covers it — emit nothing here
    (Q2=A: no double-fire).

### 8. Tests

- `packages/cockpit/src/__tests__/journal.test.ts` (new): table-driven
  cases for missing file, malformed JSON, malformed timestamp, fresh entry,
  stale entry, threshold-boundary entry.
- `packages/cockpit/src/__tests__/config-loader.test.ts` (mod): assert
  default `stuckThresholdMinutes=15` and that an explicit `cockpit.stuckThresholdMinutes`
  in YAML is honored.
- `packages/generacy/.../cockpit/__tests__/watch/diff.test.ts` (mod): new
  cases for stuck-transition emission, recovered-transition emission, and
  the label-change-vs-recovered dedupe.

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. No constitutional
constraints to verify beyond the standing project conventions encoded in
`CLAUDE.md` (TypeScript-only, no comments unless WHY is non-obvious, vitest,
fail-closed at boundaries).

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Status command becomes I/O-heavy on large repos | Sensor only fires for `active`+`agent:in-progress` issues (a small fraction). One stat + one read per such issue per invocation. |
| Worker writes journal entries during a phase, not at fixed cadence — long quiescent phases (e.g., `validate` waiting on CI) trip false-positive `stuck` | Default threshold 15min absorbs typical quiescence. Operators tune via `cockpit.stuckThresholdMinutes`. Documented in quickstart.md. |
| The clarification corrected Q3 to `specs/{n}/conversation-log.jsonl`; a future writer migration to `.agency/conversations/{n}/journal.jsonl` would silently break this sensor | Path centralized in `journal.ts`. A follow-up PR can switch (or add candidate-list fallback per Q3 option C). Tracked separately. |
| Diff emits both `label-change` and `recovered` for a single user action | Q2=A handled in `diffIssue`: `recovered` only fires when the issue remains classified `active` via `agent:in-progress`. |

## Next Step

Run `/speckit:tasks` to generate the ordered task list (T001…) from this plan.
