# Data Model: Journal-based stuck detection (G5.2)

**Branch**: `793-epic-generacy-ai-tetrad`

## New types (cockpit package)

### `StuckReason`

```ts
export type StuckReason = 'stale' | 'no-journal' | null;
```

| Value | Meaning |
|---|---|
| `'stale'` | Journal file exists and is parseable; most recent entry is older than `stuckThresholdMinutes`. |
| `'no-journal'` | Journal file exists but cannot be read, parsed, or has no valid timestamp. Cause logged to stderr. |
| `null` | Not stuck. Either the journal advanced inside the threshold, or the issue is missing-journal (Q1=A), or the issue is not classified `active`+`agent:in-progress`. |

### `JournalLivenessResult`

```ts
export interface JournalLivenessResult {
  stuck: boolean;
  stuckReason: StuckReason;
  lastEntryAt: string | null;   // ISO 8601, or null if unknown
}
```

Invariants:

- `stuck === true` ⟺ `stuckReason === 'stale'`.
- `stuck === false` ⟹ `stuckReason ∈ {null, 'no-journal'}`.
- `lastEntryAt !== null` only when a parseable entry with a valid timestamp
  was found; in all other cases `lastEntryAt === null`.

### `ReadJournalLivenessOptions`

```ts
export interface ReadJournalLivenessOptions {
  issueNumber: number;
  thresholdMinutes: number;
  cwd?: string;                                  // default: process.cwd()
  now?: () => Date;                              // default: () => new Date()
  logger?: { warn: (msg: string) => void };      // default: stderr
}
```

Validation:

- `issueNumber` must be a positive integer (caller's job).
- `thresholdMinutes` must be a positive integer (enforced by Zod in the
  config schema; sensor itself does not re-validate).

## Modified types

### `CockpitConfig` (cockpit/config/schema.ts)

```ts
export const CockpitConfigSchema = z.object({
  owner: z.string().min(1).optional(),
  repos: z.array(z.string().regex(OWNER_REPO_REGEX, 'must be owner/repo')).default([]),
  orchestrator: z
    .object({
      baseUrl: z.string().url().optional(),
      token: z.string().min(1).optional(),
    })
    .optional()
    .default({}),
  // NEW
  stuckThresholdMinutes: z.number().int().positive().default(15),
});
```

### `StatusRow` (generacy/.../cockpit/status/row.ts)

```ts
export interface StatusRow {
  repo: string;
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  state: CockpitState;
  sourceLabel: string;
  prNumber: number | null;
  checks: 'pending' | 'success' | 'failure' | 'none';
  url: string;
  // NEW
  stuck: boolean;
  stuckReason: StuckReason;
}
```

Default for non-gated rows: `stuck: false, stuckReason: null`.

### `IssueSnapshot` (generacy/.../cockpit/watch/snapshot.ts)

```ts
export interface IssueSnapshot {
  kind: 'issue';
  repo: string;
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  classified: ClassifiedIssue;
  // NEW
  stuck: boolean;
  stuckReason: StuckReason;
}
```

`PrSnapshot` is **unchanged** — PRs do not have an `agent:in-progress`
journal and the sensor never fires for them.

### `CockpitEventDiscriminator` (generacy/.../cockpit/watch/diff.ts)

```ts
export type CockpitEventDiscriminator =
  | 'label-change'
  | 'issue-closed'
  | 'pr-merged'
  | 'pr-closed'
  | 'pr-checks'
  // NEW
  | 'stuck'
  | 'recovered';
```

### `CockpitEvent` (generacy/.../cockpit/watch/diff.ts)

Extended with one optional field, populated only on `stuck` events:

```ts
export interface CockpitEvent {
  ts: string;
  repo: string;
  kind: CockpitEventKind;
  number: number;
  from: CockpitState | null;
  to: CockpitState | null;
  sourceLabel: string | null;
  url: string;
  event: CockpitEventDiscriminator;
  labels: string[];
  // NEW (optional; set only when event === 'stuck')
  stuckReason?: StuckReason;
}
```

`recovered` events do not carry `stuckReason` — the consumer already knows
the reason from the prior `stuck` event for the same key.

## Event semantics

### `stuck` event

| Field | Value |
|---|---|
| `event` | `'stuck'` |
| `kind` | `'issue'` |
| `from` | `curr.classified.state` (always `'active'`) |
| `to` | `curr.classified.state` (always `'active'`) |
| `sourceLabel` | `curr.classified.sourceLabel` (always `'agent:in-progress'`) |
| `stuckReason` | `'stale'` (never `'no-journal'` — see invariants) |

Trigger: `prev.stuck === false && curr.stuck === true`.

### `recovered` event

| Field | Value |
|---|---|
| `event` | `'recovered'` |
| `kind` | `'issue'` |
| `from` | `curr.classified.state` (always `'active'`) |
| `to` | `curr.classified.state` (always `'active'`) |
| `sourceLabel` | `curr.classified.sourceLabel` (always `'agent:in-progress'`) |

Trigger: `prev.stuck === true && curr.stuck === false`
**and** the issue still classifies as `active` via `agent:in-progress`.

If the issue left `agent:in-progress` (label change), no `recovered` event
is emitted — the existing `label-change` event covers the transition
(clarif. Q2=A).

## Relationships

```
.generacy/config.yaml
        │
        ▼
loadCockpitConfig() ──► CockpitConfig.stuckThresholdMinutes
        │
        ├──► status.ts ──► readJournalLiveness() ──► StatusRow.stuck
        │                                            └─► render-table.ts (table + JSON)
        │
        └──► watch.ts ───► poll-loop.runOnePoll
                            │
                            ├──► readJournalLiveness() ──► IssueSnapshot.stuck
                            │
                            └──► diff.computeTransitions
                                 │
                                 ├──► 'stuck'  event
                                 └──► 'recovered' event
```

`readJournalLiveness` has one external dependency: the filesystem.
Everything else (now, logger, cwd) is injected for testability.

## Validation rules

- `cockpit.stuckThresholdMinutes` rejected by Zod when ≤ 0, non-integer, or
  not a number → loader throws.
- Negative or future timestamps in the journal: treat as zero age
  (`stuck=false`, `stuckReason=null`). Defensive — should not happen, but
  clock skew on the worker is plausible.
- `lastEntryAt` is whatever the journal entry's `timestamp` field
  serialized as — cockpit does not re-format. Consumers should treat it as
  an opaque ISO 8601 string.
