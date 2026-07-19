# Data Model: Doorbell full-event wake line (#985)

## Entities

### `CockpitEvent` (extended)

**Location**: `packages/generacy/src/cli/commands/cockpit/watch/emit.ts` (`CockpitEventSchema`) + `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` (`CockpitEvent` interface).

**Existing fields** (unchanged):

| Field | Type | Notes |
|-------|------|-------|
| `type` | `'issue-transition'` (literal) | Discriminator. |
| `ts` | ISO-8601 datetime string | Event emission timestamp. |
| `repo` | `string` matching `/^[^/]+\/[^/]+$/` | Owner/repo. |
| `kind` | `'issue' \| 'pr'` | |
| `number` | positive integer | Issue/PR number. |
| `from` | `CockpitState \| null` | **Always `null` on smee events** (Q3=A). |
| `to` | `CockpitState \| null` | **Populated on smee events** by `classifyIssue(labels)` (FR-003). |
| `sourceLabel` | `string \| null` | Label that triggered the transition (or `classified.sourceLabel` on smee). |
| `url` | URL | GitHub issue/PR URL. |
| `event` | `'label-change' \| 'issue-closed' \| 'pr-merged' \| 'pr-closed' \| 'pr-checks'` | Discriminator for downstream dispatch. |
| `labels` | `string[]` | Current label set (from webhook `issue.labels` on smee). |
| `initial` | `true \| undefined` (optional) | Present only on initial-sweep events (poll path). |

**New field** (this issue):

| Field | Type | Notes |
|-------|------|-------|
| `checks` | `'green' \| 'red' \| 'pending'` (optional) | Present only when the cached `PrSnapshot.checksRollup` maps to `'green'` or `'red'` (per Q1=A). **Omitted** when the mapping would be `'pending'`, or when no PR snapshot is cached, or when the event is not a `pr-checks` / `completed:validate` event. Skill treats absent === `'pending'` (Q4=A). |

### `CockpitStreamEvent` (unchanged discriminated union)

**Location**: `packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts`

```
CockpitStreamEvent =
  | CockpitEvent                  // extended above (adds optional `checks`)
  | PhaseCompleteEvent            // unchanged
  | EpicCompleteEvent             // unchanged
```

## Type definitions

### Zod schema extension (source of truth)

**File**: `packages/generacy/src/cli/commands/cockpit/watch/emit.ts`

```ts
export const CockpitEventSchema = z.object({
  type: z.literal('issue-transition'),
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
  initial: z.literal(true).optional(),
  checks: z.enum(['green', 'red', 'pending']).optional(), // NEW
});
```

`z.infer<typeof CockpitEventSchema>` propagates automatically. The interface at `diff.ts:18-31` gains `checks?: 'green' | 'red' | 'pending'` to match.

## Validation rules

1. **`type` is invariant** — must be `'issue-transition'` on `CockpitEvent`. Doorbell aggregate events use their own schemas.
2. **`checks` field integrity** — MUST be one of `'green'` / `'red'` / `'pending'` when present. Absence is meaningful (skill dispatches as if `'pending'`).
3. **`checks` presence rule (FR-004)** — MAY appear on `event: 'pr-checks'` or `event: 'label-change' && sourceLabel === 'completed:validate'` events. On any other event kind, MUST be absent. (Producers enforce; consumers should not rely on absence being schema-enforced by kind.)
4. **`from` on smee events (Q3=A)** — MUST be `null`. Consumers MUST NOT rely on `from` for smee-originated lines.
5. **`to` on smee events (FR-003)** — MUST equal `classifyIssue(labels).state`. Zero GitHub calls (FR-005).

## Relationships

```
CockpitStreamEvent (line-level unit)
  ├── serialized by: subscribe.ts::lineForEvent → JSON.stringify + '\n'
  ├── produced by:
  │     ├── poll path:  watch/diff.ts::computeTransitions  (from/to both populated)
  │     └── smee path:  doorbell/webhook-to-event.ts::buildEvent  (from=null; to via classifyIssue)
  └── enriched by (smee only):
        └── doorbell/smee-source.ts::processEventBlock
              └── read-through this.prev.get(snapshotKey(repo,'pr',number)).checksRollup
                    └── if 'success' → checks='green'
                    └── if 'failure' | 'error' → checks='red'
                    └── if 'pending' | 'none' → omit
```

## Q1=A `checks` mapping table

Applied only when `snap != null && snap.kind === 'pr'` AND (`event === 'pr-checks'` OR `sourceLabel === 'completed:validate'`).

| Input: `PrSnapshot.checksRollup` | Output: `checks` field |
|----------------------------------|------------------------|
| `'success'`                      | `'green'` |
| `'failure'`                      | `'red'` |
| `'error'`                        | `'red'` |
| `'pending'`                      | *(omitted)* |
| `'none'`                         | *(omitted)* |
| *(cache miss — snap is `undefined`)* | *(omitted)* |

## Data flow

**Smee wake path**:
```
smee.io SSE payload
  → sse-parser::parseSseEventBlock
  → doorbell/smee-source.ts::processEventBlock
     ├── webhookToStreamEvent(...)  # returns CockpitEventValidated with to filled
     │     └── buildEvent(labels, …)
     │           └── classified = classifyIssue(labels)
     │           └── to = classified.state, sourceLabel = classified.sourceLabel ?? passthrough
     └── FOR each event:
           ├── IF (event.event === 'pr-checks' OR event.sourceLabel === 'completed:validate'):
           │     snap = this.prev.get(snapshotKey(event.repo, 'pr', event.number))
           │     IF (snap?.kind === 'pr'):
           │       checks = mapChecks(snap.checksRollup)   # per Q1=A
           │       IF (checks === 'green' | 'red'): event = { ...event, checks }
           └── await this.onEvent(event)
                 └── stdout.write(JSON.stringify(event) + '\n')  # NDJSON (FR-001)
```

**Poll fallback path** (already correct for `to`; still needs NDJSON):
```
event bus entry
  → subscribeAndEmit
  → lineForEvent(event.event)
  → stdout.write(JSON.stringify(event) + '\n')  # NDJSON (FR-001)
```

## Invariants (test-enforceable)

1. **INV-1** — On the smee event path, no `gh` / `graphql` invocation occurs between webhook receipt and `this.onEvent(...)` dispatch. Verified by mocking `gh` in the smee-source integration test and asserting zero calls after receiving a webhook (FR-008c).
2. **INV-2** — For every smee-emitted event, `to === classifyIssue(event.labels).state` (FR-008b).
3. **INV-3** — Every emitted line is valid JSON and parses back to a schema-conforming `CockpitStreamEvent` (FR-008a).
4. **INV-4** — `checks` is present on the emitted event **iff** the cached `PrSnapshot.checksRollup` for that repo/PR was `'success'` (→ `'green'`) or `'failure' | 'error'` (→ `'red'`) at the moment of dispatch (FR-008d).
