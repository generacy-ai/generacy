# Data Model — #839

Additive-only extension to `CockpitEvent`. One new engine-side predicate module. No new persisted state, no new IPC channel, no schema break for existing consumers.

## Extended Type: `CockpitEvent`

Located at `packages/generacy/src/cli/commands/cockpit/watch/diff.ts`.

```ts
export type CockpitEventKind = 'issue' | 'pr';

export type CockpitEventDiscriminator =
  | 'label-change'
  | 'issue-closed'
  | 'pr-merged'
  | 'pr-closed'
  | 'pr-checks';

export interface CockpitEvent {
  ts: string;
  repo: string;                                // e.g. "owner/repo"
  kind: CockpitEventKind;
  number: number;                              // GitHub issue/PR number, positive int
  from: CockpitState | null;                   // null on first-poll sweep lines
  to: CockpitState | null;
  sourceLabel: string | null;
  url: string;
  event: CockpitEventDiscriminator;
  labels: string[];
  initial?: true;                              // NEW — present iff first-poll sweep line (Q3, FR-003, FR-004)
}
```

### Field: `initial`

| Attribute | Value |
|-----------|-------|
| Type | `true` (literal) |
| Optional | Yes (schema: `z.literal(true).optional()`) |
| Presence rule | Present ONLY on first-poll sweep lines (`prev.size === 0` branch of `computeTransitions`). ABSENT on polls 2..N. Never emitted as `false`. |
| Consumer contract | Key on truthiness: `if (event.initial) { ... }`. Do NOT branch on `event.initial === false`. |
| Rationale | Q3 answer — cleanest wire contract, smallest footprint. |

### Field: `event` on first-poll sweep lines

Per Q1: MUST be `'label-change'`. Not a new discriminator (which would force plugin fallback code = plugin change, violating FR-007).

### Field: `from` on first-poll sweep lines

Per Q1: MUST be `null`. Renders naturally as "(none) → <state>". Not a self-loop.

### Field: `to` on first-poll sweep lines

MUST be `curr.classified.state`. Even when the sweep's decision was made by a *raw label* (FR-011 / Q2), the emitted `to` state is the classifier's answer. Consumers rendering `to` see a coherent, familiar `CockpitState` value.

### Field: `sourceLabel` on first-poll sweep lines

MUST be `curr.classified.sourceLabel` (may be `null`). Per FR-011: the sweep's *decision* uses raw labels, but the emitted `sourceLabel` remains classifier-derived. This preserves rendering consistency with polls 2..N.

## Zod Schema Update

Located at `packages/generacy/src/cli/commands/cockpit/watch/emit.ts`.

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
  initial: z.literal(true).optional(),          // NEW
});
```

### Validation Rules

| Rule | Enforcement |
|------|-------------|
| `initial: false` is REJECTED at parse time | `z.literal(true).optional()` — not `z.boolean().optional()`. Test guards SC-005. |
| `initial` absent is ACCEPTED | `.optional()` on the field. |
| `initial: true` is ACCEPTED | `z.literal(true)` matches. |
| `emit()` runs `.parse()` by default | Existing behavior in `emit.ts:34`. Dev-time defense-in-depth. |

## New Module: `actionable.ts`

Located at `packages/generacy/src/cli/commands/cockpit/watch/actionable.ts`.

### `ACTIONABLE_EXACT_LABELS: Set<string>`

Exact-match label names that qualify as actionable. Per FR-002:

```ts
export const ACTIONABLE_EXACT_LABELS = new Set<string>([
  'completed:validate',
  'needs:intervention',
  'agent:error',
]);
```

Note: `completed:validate` is the ONLY `completed:*` label in the actionable set. Other `completed:*` labels (e.g., `completed:specify`, `completed:plan`) are NOT actionable.

### `ACTIONABLE_PREFIXES: readonly string[]`

Label-name prefixes that qualify as actionable regardless of subkey. Per FR-002:

```ts
const ACTIONABLE_PREFIXES = ['waiting-for:', 'failed:'] as const;
```

### `isActionableLabel(label: string): boolean`

Pure. Returns `true` iff the label is in `ACTIONABLE_EXACT_LABELS` or starts with an `ACTIONABLE_PREFIXES` entry.

### `isActionableSnapshot(snap: Snapshot): boolean`

Pure. The full first-poll predicate:

- Returns `true` if any label in `snap.labels` is actionable.
- Returns `true` if `snap.kind === 'pr' && snap.checksRollup === 'failure'` (Q5 / FR-002).
- Returns `false` otherwise.

Operates on raw `Snapshot.labels[]`, NOT `snap.classified.state` (FR-011 / Q2 counterexample).

## Unchanged Types

- `Snapshot`, `IssueSnapshot`, `PrSnapshot`, `SnapshotMap`, `SnapshotKey` — no shape change.
- `snapshotKey(repo, kind, number)` — no change; already `` `${repo}#${kind}#${number}` `` and directly usable as a lexicographic sort key.
- `ClassifiedIssue` — no change.
- `CockpitState` / `COCKPIT_STATES` — no change.
- `WORKFLOW_LABELS`, `mapLabelToState`, `classify` — no change.

## Persistence

None. The sensor is stateless per run (Assumptions §1 / FR-008). No file, no map, no `seen-set` written to disk.

## Backwards Compatibility

- **Consumers reading `initial`**: today's plugin (`/cockpit:watch`) does not read `initial` — adding it is a no-op. No plugin change required (FR-007).
- **Consumers reading unknown fields**: existing plugin markdown treats each NDJSON line as an opaque JSON object with known-only fields it consumes; unknown fields pass through unread.
- **Producers emitting `initial: false`**: schema rejects at `.parse()`. This is the desired defense — any drift toward the ambiguous `boolean` shape fails loud, not silent.

## Wire Examples

### First-poll sweep line (`initial: true`)

```json
{
  "ts": "2026-07-07T15:00:00.000Z",
  "repo": "christrudelpw/sniplink",
  "kind": "issue",
  "number": 2,
  "from": null,
  "to": "waiting",
  "sourceLabel": "waiting-for:clarification",
  "url": "https://github.com/christrudelpw/sniplink/issues/2",
  "event": "label-change",
  "labels": ["workflow:speckit-feature", "completed:specify", "waiting-for:clarification"],
  "initial": true
}
```

Note that `to: 'waiting'` and `sourceLabel: 'waiting-for:clarification'` come from the classifier despite the presence of `completed:specify` — this depends on the tier fix being applied separately, or the tier fix landing before this feature is dogfooded. Absent that fix, the emitted `to` will be `'terminal'` and `sourceLabel: 'completed:specify'`; the fact that the *line was emitted at all* is the fix scoped to this spec (SC-007).

### Polls 2..N line (`initial` absent)

```json
{
  "ts": "2026-07-07T15:00:30.000Z",
  "repo": "christrudelpw/sniplink",
  "kind": "issue",
  "number": 2,
  "from": "waiting",
  "to": "active",
  "sourceLabel": "phase:plan",
  "url": "https://github.com/christrudelpw/sniplink/issues/2",
  "event": "label-change",
  "labels": ["workflow:speckit-feature", "phase:plan"]
}
```

Byte-identical to today's wire output — no `initial` field present.

### First-poll sweep line for a red-CI PR (`checksRollup === 'failure'`, no `failed:*` label — SC-009)

```json
{
  "ts": "2026-07-07T15:00:00.000Z",
  "repo": "christrudelpw/sniplink",
  "kind": "pr",
  "number": 47,
  "from": null,
  "to": "active",
  "sourceLabel": "phase:implement",
  "url": "https://github.com/christrudelpw/sniplink/pull/47",
  "event": "label-change",
  "labels": ["workflow:speckit-feature", "phase:implement"],
  "initial": true
}
```

The predicate's PR branch (`snap.checksRollup === 'failure'`) fires; the emitted `to`/`sourceLabel` still reflect the classifier's read of the labels — the sweep just decided to emit at all. Consumers can inspect `labels` and the historical `pr-checks` transition path (which fires on rollup change) to detect the red state; downstream tooling that wants a first-class `checksRollup` field on the wire is a follow-up.
