# Data Model: Delete Cockpit Dark Subsystems (S1)

This is a **deletion-only** change. There are no new entities. The model below shows the *before* and *after* shape of every user-visible type touched.

---

## 1. `CockpitConfig` (`packages/cockpit/src/config/schema.ts`)

### Before

```ts
export const CockpitConfigSchema = z.object({
  owner: z.string().min(1).optional(),
  repos: z.array(z.string().regex(OWNER_REPO_REGEX)).default([]),
  orchestrator: z.object({
    baseUrl: z.string().url().optional(),
    token: z.string().min(1).optional(),
  }).optional().default({}),
  stuckThresholdMinutes: z.number().int().positive().default(15),
});
```

### After

```ts
export const CockpitConfigSchema = z.object({
  owner: z.string().min(1).optional(),
  repos: z.array(z.string().regex(OWNER_REPO_REGEX)).default([]),
});
```

**Impact**: `orchestrator.*` and `stuckThresholdMinutes` become unknown-and-stripped at parse. Existing `.cockpit.yaml` files carrying these keys parse cleanly (Zod strip mode default; verified in research.md R4).

---

## 2. Cockpit type exports (`packages/cockpit/src/types.ts` + `index.ts`)

### Deleted types

- `StuckReason = 'stale' | 'no-journal' | null`
- `JournalLivenessResult = { stuck: boolean; stuckReason: StuckReason; lastEntryAt: string | null }`
- `ReadJournalLivenessOptions = { issueNumber; thresholdMinutes; cwd?; now?; logger? }`

### Deleted exports (from `index.ts`)

- `readJournalLiveness` function
- `createOrchestratorClient`, `OrchestratorClient`, `CreateOrchestratorClientConfig`, `HealthResult`, `JobsResult`, `WorkersResult`, `JobSummary`, `UnavailableReason`
- `appendChildIssue` function

### Preserved (unchanged)

- `COCKPIT_STATES`, `CockpitState`, `ClassifyResult` in `types.ts`
- All `state/`, `manifest/schema`, `gh/wrapper`, `gh/command-runner` exports

---

## 3. `StatusRow` (`packages/generacy/src/cli/commands/cockpit/status/row.ts`)

### Before

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
  stuck: boolean;
  stuckReason: StuckReason;
}
```

### After

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
}
```

**Validation rules**: `state` still constrained to `CockpitState`; `checks` still union of four literals.

**Consumer impact**: `status --json` rows lose `stuck` and `stuckReason` fields. `render-table.ts` drops the `STALE` column.

---

## 4. `IssueSnapshot` (`packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts`)

### Before

```ts
export interface IssueSnapshot {
  kind: 'issue';
  repo: string;
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  classified: ClassifiedIssue;
  stuck: boolean;
  stuckReason: StuckReason;
}
```

### After

```ts
export interface IssueSnapshot {
  kind: 'issue';
  repo: string;
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  classified: ClassifiedIssue;
}
```

`PrSnapshot` and `Snapshot` union: unchanged.

---

## 5. `CockpitEvent` / `CockpitEventDiscriminator` (`packages/generacy/src/cli/commands/cockpit/watch/diff.ts`)

### Before

```ts
export type CockpitEventDiscriminator =
  | 'label-change' | 'issue-closed' | 'pr-merged' | 'pr-closed' | 'pr-checks'
  | 'stuck' | 'recovered';

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
  stuckReason?: StuckReason;
}
```

### After

```ts
export type CockpitEventDiscriminator =
  | 'label-change' | 'issue-closed' | 'pr-merged' | 'pr-closed' | 'pr-checks';

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
}
```

**Zod schema** (`emit.ts:5`): already aligned — the `.enum()` there already excludes `stuck`/`recovered`. This closes the producer/schema drift called out in the spec.

---

## 6. `Colorizer` (`packages/generacy/src/cli/commands/cockpit/status/color.ts`)

### Before

```ts
export interface Colorizer {
  state(s: string, state: CockpitState): string;
  stuck(s: string, stuck: boolean): string;
}
```

### After

```ts
export interface Colorizer {
  state(s: string, state: CockpitState): string;
}
```

Both `chalkColorizer` and `identityColorizer` lose their `stuck()` method.

---

## 7. `PollDeps` (`packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts`)

### Before

```ts
export interface PollDeps {
  gh: GhWrapper;
  scope: Scope;
  safetyCap?: number;
  pageSize?: number;
  stuckThresholdMinutes?: number;
  readLiveness?: (issueNumber, thresholdMinutes) => Promise<{ stuck; stuckReason }>;
  logger?: { warn: (msg: string) => void };
  now?: () => string;
}
```

### After

```ts
export interface PollDeps {
  gh: GhWrapper;
  scope: Scope;
  safetyCap?: number;
  pageSize?: number;
  logger?: { warn: (msg: string) => void };
  now?: () => string;
}
```

---

## 8. `StatusEnvelope` (`packages/generacy/src/cli/commands/cockpit/status/render-table.ts`)

### Before

```ts
export interface StatusEnvelope {
  scope: { kind: 'epic'; owner; repo; issue } | { kind: 'repos'; repos };
  rows: StatusRow[];
  orchestrator:
    | { available: true; jobs: number; workers: number }
    | { available: false; reason: string };
}
```

### After

```ts
export interface StatusEnvelope {
  scope: { kind: 'epic'; owner; repo; issue } | { kind: 'repos'; repos };
  rows: StatusRow[];
}
```

`renderJsonEnvelope()` signature loses its `footer` param.

---

## Relationships

- `StatusRow ⇐ buildStatusRow(...)` — helper edits cascade to `status.ts`.
- `IssueSnapshot ⇐ buildIssueSnapshot(...)` — helper edits cascade to `watch/poll-loop.ts`.
- `CockpitEvent ⇐ makeEvent(...)`, `computeTransitions(...)` — internal to `diff.ts`; consumed by `emit.ts` (already aligned).
- `Colorizer` — consumed only by `render-table.ts`.
- `PollDeps` — consumed only by `watch.ts` (and tests).
- `StatusEnvelope` — consumed only by `status.ts` (and `status.render.test.ts`).

All relationship-scope changes stay within the two owned packages.
