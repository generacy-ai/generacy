# Data Model: `generacy cockpit watch` + `status`

This file defines the public consumer-facing types (CLI flags, NDJSON event shape, `status` snapshot rows) plus the internal snapshot/diff types used by the watch poll loop. Every type listed here is testable in isolation; none owns I/O.

## CLI surface

### `generacy cockpit watch` flags

```ts
interface WatchOptions {
  /** Optional epic scoping. Format: 'owner/repo#NNN'. */
  epic?: string;

  /** Override config-derived repo list (comma-separated 'owner/name'). */
  repos?: string;

  /** Poll interval in ms. Default 5000. Minimum 1000. */
  interval?: number;

  /** Maximum items per repo per poll before stderr warn. Default 1000. */
  safetyCap?: number;
}
```

Validated by Commander.js coercion + a post-parse `zod` schema. `--epic` matches `/^[^/]+\/[^/]+#\d+$/`; `--interval` must be `>= 1000` (sub-second polling is a `gh` rate-limit risk).

### `generacy cockpit status` flags

```ts
interface StatusOptions {
  /** Optional epic scoping. Format: 'owner/repo#NNN'. */
  epic?: string;

  /** Override config-derived repo list (comma-separated 'owner/name'). */
  repos?: string;

  /** Emit JSON envelope to stdout. Disables color. */
  json?: boolean;
}
```

## NDJSON event shape (the `watch` wire contract)

### `CockpitEvent`

```ts
export type CockpitEventKind = 'issue' | 'pr';
export type CockpitEventDiscriminator =
  | 'label-change'
  | 'issue-closed'
  | 'pr-merged'
  | 'pr-closed'
  | 'pr-checks';

export interface CockpitEvent {
  /** ISO 8601 timestamp at which the watcher detected the transition. */
  ts: string;

  /** `'owner/name'` of the repo where the issue/PR lives. */
  repo: string;

  /** `'issue'` for a GitHub issue, `'pr'` for a pull request. */
  kind: CockpitEventKind;

  /** Issue or PR number. */
  number: number;

  /** Curated state at the start of this transition (null if previously unknown). */
  from: CockpitState | null;

  /** Curated state after this transition (null if the issue was closed/removed). */
  to: CockpitState | null;

  /** Label that drove the transition. Null for non-label events (lifecycle, checks). */
  sourceLabel: string | null;

  /** Full HTML URL of the issue/PR on GitHub. */
  url: string;

  /** Discriminator for consumers that want to branch on event type. */
  event: CockpitEventDiscriminator;

  /** Full label set at transition time (Q2's context-without-followup guarantee). */
  labels: string[];
}
```

`CockpitState` is the union exported from `@generacy-ai/cockpit` (the foundation owns the type).

### Event-discriminator semantics

| `event`            | When emitted                                                                 | `from` / `to` semantics                                       | `sourceLabel`       |
|--------------------|------------------------------------------------------------------------------|---------------------------------------------------------------|----------------------|
| `label-change`     | Classified state changed because of a label add/remove.                      | Previous and new `CockpitState`.                              | The winning label.   |
| `issue-closed`     | Issue's `state` flipped to `CLOSED`.                                         | `to = 'terminal'`.                                            | `null`.              |
| `pr-merged`        | PR's lifecycle flipped to `merged`.                                          | `to = 'terminal'`.                                            | `null`.              |
| `pr-closed`        | PR's lifecycle flipped to `closed` without being merged.                     | `to = 'terminal'`.                                            | `null`.              |
| `pr-checks`        | PR's check-run roll-up flipped (PENDING ↔ SUCCESS ↔ FAILURE).                | `from`/`to` carry the classified state at flip time (often unchanged for `label-change` precedence — see below). | `null`.              |

**Precedence rule for simultaneous transitions in a single poll cycle**: emit each as a distinct event, in this order: `label-change` first, then lifecycle (`issue-closed`/`pr-merged`/`pr-closed`), then `pr-checks`. Two events with the same `(repo, kind, number, ts)` are allowed; consumers must not collapse them.

### `CockpitEventSchema` (zod)

```ts
export const CockpitEventSchema = z.object({
  ts: z.string().datetime(),
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  kind: z.enum(['issue', 'pr']),
  number: z.number().int().positive(),
  from: z.union([z.enum(COCKPIT_STATES), z.null()]),
  to: z.union([z.enum(COCKPIT_STATES), z.null()]),
  sourceLabel: z.string().nullable(),
  url: z.string().url(),
  event: z.enum(['label-change', 'issue-closed', 'pr-merged', 'pr-closed', 'pr-checks']),
  labels: z.array(z.string()),
});
```

Used by `watch/emit.ts` for dev-time validation. Production emit path can skip the parse step under an env var if profile data ever shows a hot spot (not measured at v1 scale).

## Internal snapshot types (watch poll loop)

### `IssueSnapshot` and `PrSnapshot`

```ts
type SnapshotKey = string; // `${repo}#${kind}#${number}`

interface IssueSnapshot {
  kind: 'issue';
  repo: string;
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  classified: ClassifyResult;       // from @generacy-ai/cockpit
}

interface PrSnapshot {
  kind: 'pr';
  repo: string;
  number: number;
  url: string;
  lifecycle: 'open' | 'closed' | 'merged';
  labels: string[];
  classified: ClassifyResult;
  checksRollup: 'pending' | 'success' | 'failure';
}

type SnapshotMap = Map<SnapshotKey, IssueSnapshot | PrSnapshot>;
```

**Invariants**:
- `lifecycle === 'merged'` ⇔ the gh wrapper's `getPullRequest()` returned `state === 'MERGED'` (or `mergedAt != null`).
- `lifecycle === 'closed'` ⇔ `state === 'CLOSED' && mergedAt == null`.
- `checksRollup === 'pending'` when `checks.length === 0` (no checks reported yet).
- `classified` always reflects the current `labels[]` per `classify(labels)`.

### `computeTransitions(prev, curr)`

```ts
function computeTransitions(prev: SnapshotMap, curr: SnapshotMap): CockpitEvent[];
```

Pure function. For each key present in `curr`:
1. Look up `prev`. If absent — no emit (baseline establishment).
2. Compare `classified.state` and `classified.sourceLabel`. If different, emit `event: 'label-change'`.
3. For `kind: 'issue'`: if `state` flipped OPEN → CLOSED, emit `event: 'issue-closed'`.
4. For `kind: 'pr'`:
   - If `lifecycle` flipped to `'merged'`, emit `event: 'pr-merged'`.
   - If `lifecycle` flipped to `'closed'`, emit `event: 'pr-closed'`.
   - If `checksRollup` changed (any → any), emit `event: 'pr-checks'`.

Order within the returned array is the precedence rule above. Test fixtures cover all branch combinations.

## `status` snapshot rows

### `StatusRow`

```ts
export interface StatusRow {
  repo: string;
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  state: CockpitState;
  sourceLabel: string;
  /** PR number associated with this issue, if any. PR rows carry their own number here. */
  prNumber: number | null;
  /** `'pending' | 'success' | 'failure' | 'none'` — 'none' when no PR is linked. */
  checks: 'pending' | 'success' | 'failure' | 'none';
  url: string;
}
```

### Status JSON envelope (with `--json`)

```ts
export interface StatusEnvelope {
  scope: { kind: 'epic'; owner: string; repo: string; issue: number } | { kind: 'repos'; repos: string[] };
  rows: StatusRow[];
  orchestrator: {
    available: boolean;
    reason?: string;          // when available=false
    jobs?: number;            // when available=true
    workers?: number;         // when available=true
  };
}
```

`status.ts` always emits the envelope (`--json` mode) or renders the table + footer (default mode). The envelope is stable; future fields go on the end.

### Table-render contract (non-TTY plain path)

A row in non-TTY plain mode renders as:

```text
{repo:padEnd(20)}  #{number:padStart(5)}  {state:padEnd(8)}  {sourceLabel:padEnd(30)}  PR {prNumber|'-':padStart(5)}  {checks:padEnd(8)}  {title:truncate(60)}
```

(Three spaces between columns; column widths per the row above.) Strings exceeding the width are truncated with `…` for `title`, kept whole for everything else (numbers and short labels never exceed). Test asserts string equality against the rendered string.

### Color map (TTY-on)

```ts
const STATE_COLOR: Record<CockpitState, ChalkFn> = {
  terminal: chalk.green,
  error: chalk.red,
  waiting: chalk.yellow,
  active: chalk.cyan,
  pending: chalk.dim,
  unknown: chalk.dim,
};
```

Applied to the `state` column only (not `sourceLabel`, not `title`). Matches Q4's "state tiers" guidance. `pending` and `unknown` both render dim because operators want to visually skip them in a busy dashboard.

## Cross-issue type additions (foundation)

Added to `packages/cockpit/src/gh/wrapper.ts` and re-exported from `packages/cockpit/src/index.ts`:

```ts
export interface PullRequestSummary {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt?: string;     // ISO 8601 when state==='MERGED'
  closedAt?: string;     // ISO 8601 when state==='CLOSED' || state==='MERGED'
  url: string;
  isDraft: boolean;
  labels: string[];
}

export interface GhWrapper {
  // ... existing methods
  resolveIssueToPR(repo: string, issueNumber: number): Promise<number | null>;
  getPullRequest(repo: string, prNumber: number): Promise<PullRequestSummary>;
}
```

Also added: `Issue.createdAt: string` (ISO 8601). Required for the pagination cursoring decision in R4. Backward compatible — existing consumers ignore the new field.

## Configuration (consumed, not owned)

`watch` and `status` consume `CockpitConfig` (defined in the foundation):

```ts
{
  owner: string | undefined,
  repos: string[],                   // 'owner/name'[]
  orchestrator: {
    baseUrl: string | undefined,
    token: string | undefined,
  },
}
```

Resolution order is the foundation's responsibility (`cockpit.repos` → `MONITORED_REPOS` env → `[]`). The CLI commands only see the resolved `LoadedCockpitConfig`.

## Relationships

```text
@generacy-ai/cockpit (foundation #786)
    │  classify, CockpitState, ClassifyResult
    │  loadCockpitConfig, resolveEpicIssues
    │  GhWrapper (+ resolveIssueToPR, getPullRequest, Issue.createdAt — added here)
    │  createOrchestratorClient, OrchestratorClient
    ▼
@generacy-ai/generacy / src/cli/commands/cockpit/
    ├── shared/            (scoping, pagination, footer)
    ├── watch/             (poll loop, diff, snapshot, emit)
    └── status/            (row builder, render-table, color, group)
            │
            ▼
       NDJSON stdout (watch) / table + footer stdout (status)
            │
            ▼
       Claude Code Monitor tool / human operator / jq / CI dashboard
```

No new package. No reverse dependency from `@generacy-ai/cockpit` back to `@generacy-ai/generacy`.

## Invariants (for review + tests)

- **No mutations in `watch`**: `watch.ts` never calls `gh.addLabels` or `gh.removeLabels`. Enforced by `watch.no-mutations.test.ts`.
- **One stdout line per transition**: `watch/emit.ts` is the only writer to `process.stdout`. Stderr is reserved for startup banners and safety-cap warnings.
- **NDJSON stability**: every change to `CockpitEvent` or `CockpitEventSchema` is a breaking change to the Monitor consumer contract. Document in CHANGELOG.
- **Status footer never throws**: orchestrator unavailability is rendered, not raised.
- **Color is TTY-gated and `--json`-suppressed**: tests assert plain output in both cases.
