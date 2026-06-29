# Contract: `journal.ts` and downstream wiring

**Branch**: `793-epic-generacy-ai-tetrad`

## Module: `@generacy-ai/cockpit` — `journal.ts`

### `readJournalLiveness(options)`

```ts
async function readJournalLiveness(
  options: ReadJournalLivenessOptions,
): Promise<JournalLivenessResult>;
```

**Inputs**

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `issueNumber` | `number` | yes | — | Positive integer. |
| `thresholdMinutes` | `number` | yes | — | Positive integer; caller's responsibility (Zod-validated at config load). |
| `cwd` | `string` | no | `process.cwd()` | Used to compute `{cwd}/specs/{n}/conversation-log.jsonl`. |
| `now` | `() => Date` | no | `() => new Date()` | Test seam. |
| `logger` | `{ warn(msg) }` | no | stderr-backed default | Used only for `'no-journal'` diagnostic messages. |

**Output**

```ts
interface JournalLivenessResult {
  stuck: boolean;
  stuckReason: 'stale' | 'no-journal' | null;
  lastEntryAt: string | null;
}
```

**Behavior matrix**

| Filesystem / parse state | `stuck` | `stuckReason` | `lastEntryAt` | Logged? |
|---|---|---|---|---|
| File missing (`ENOENT`) | `false` | `null` | `null` | no |
| `fs.readFile` fails (EACCES, EBUSY, EIO, …) | `false` | `'no-journal'` | `null` | yes (warn) |
| File is empty | `false` | `'no-journal'` | `null` | yes (warn) |
| Last 32 lines all unparsable JSON | `false` | `'no-journal'` | `null` | yes (warn) |
| Parsable entry, `timestamp` missing or invalid | `false` | `'no-journal'` | `null` | yes (warn) |
| Parsable entry, `now - timestamp ≤ threshold` | `false` | `null` | timestamp | no |
| Parsable entry, `now - timestamp > threshold` | `true` | `'stale'` | timestamp | no |
| Negative age (future timestamp) | `false` | `null` | timestamp | no (defensive) |

**Throws**: never. Every error path returns a `JournalLivenessResult`.

**Side effects**: at most one `logger.warn(...)` call per invocation.
No filesystem writes. No background timers.

**Cost**: one `fs.stat` + at most one `fs.readFile`. The file is bounded
by the worker's flush cadence (`ConversationLogger.FLUSH_EVENT_THRESHOLD = 50`,
`FLUSH_INTERVAL_MS = 30_000`) — in practice <100 KB.

## Public exports (`packages/cockpit/src/index.ts`)

Add:

```ts
export {
  readJournalLiveness,
  type StuckReason,
  type JournalLivenessResult,
  type ReadJournalLivenessOptions,
} from './journal.js';
```

## CLI surface

### `cockpit status`

No new flags (clarif. Q5=A).

**TTY table** — add a `STUCK` column between `STATE` and `SOURCE`:

```
REPO                #NUM    STATE      STUCK   SOURCE                           PR ...
generacy-ai/foo     #793    active             agent:in-progress                PR ...
generacy-ai/foo     #794    active     STALE   agent:in-progress                PR ...
```

- `STUCK` value: empty string (`stuck=false`) or `STALE` (`stuck=true`).
- TTY coloring: when stuck, the `STUCK` cell is red (existing `chalkColorizer`
  pattern extended in `status/color.ts`).

**`--json` envelope** — additive fields on each row:

```json
{
  "scope": { ... },
  "rows": [
    {
      "repo": "generacy-ai/foo",
      "kind": "issue",
      "number": 794,
      "title": "...",
      "state": "active",
      "sourceLabel": "agent:in-progress",
      "prNumber": 812,
      "checks": "success",
      "url": "https://github.com/...",
      "stuck": true,
      "stuckReason": "stale"
    }
  ],
  "orchestrator": { ... }
}
```

### `cockpit watch`

No new flags (clarif. Q5=A).

**New NDJSON events**:

```json
{"ts":"2026-06-29T20:15:00Z","repo":"generacy-ai/foo","kind":"issue","number":794,"from":"active","to":"active","sourceLabel":"agent:in-progress","url":"https://...","event":"stuck","labels":["agent:in-progress","..."],"stuckReason":"stale"}
{"ts":"2026-06-29T20:21:30Z","repo":"generacy-ai/foo","kind":"issue","number":794,"from":"active","to":"active","sourceLabel":"agent:in-progress","url":"https://...","event":"recovered","labels":["agent:in-progress","..."]}
```

Event ordering within one poll for the same key follows the existing rule:
`label-change → lifecycle → pr-checks → stuck/recovered`. (Stuck/recovered
fire last because they depend only on `prev.stuck` vs `curr.stuck`, never
on the classifier state.)

**Dedupe rule** (clarif. Q2=A): if a single poll cycle observes both
"left `agent:in-progress`" and "stuck flipped to false", emit `label-change`
only — no `recovered`. Implementation: `diffIssue` checks the post-classify
state before emitting `recovered`; if the issue no longer classifies as
`active`+`agent:in-progress`, skip.

## Config surface

`.generacy/config.yaml`:

```yaml
cockpit:
  owner: generacy-ai
  repos:
    - generacy-ai/generacy
    - generacy-ai/tetrad-development
  stuckThresholdMinutes: 15   # NEW (default 15)
```

Validation: positive integer. Zod rejects strings, floats, zero, and
negative numbers at config-load time with a descriptive error.
