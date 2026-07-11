# Data Model: #916

## New Types

### `ProvisioningErrorClassification` (`packages/workflow-engine/src/actions/github/classify-label-provisioning-error.ts`)

Discriminated union returned by `classifyLabelProvisioningError`.

```ts
export type ProvisioningErrorClassification =
  | { readonly kind: 'already-exists' }
  | {
      readonly kind: 'error';
      readonly cause: string;
      readonly statusCode?: number;
    };
```

**Validation rules**:

- `kind` is the discriminant. `'already-exists'` means the `createLabel` call raced with a sibling process/worker on the same repo, and the label now exists — safe to continue.
- `cause` (present only on `kind === 'error'`) is a human-readable substring extracted from the underlying `Error.message`. Not machine-parsed; used for the FR-003 error log's `cause` field and the FR-008 lineage-map entry.
- `statusCode` (optional on `kind === 'error'`) is extracted via `/HTTP\s+(\d{3})/` on the error message. Absent when the error was not HTTP-shaped (e.g., a network-level failure surfaced by the `gh` CLI).

**Relationships**:

- Returned by `classifyLabelProvisioningError(err: unknown): ProvisioningErrorClassification`.
- Consumed by:
  - `LabelManager.ensureRepoLabelsExist` — race branch → `logger.debug` + continue; error branch → `logger.error` + write to lineage map + set `hadNonRaceFailure = true`.
  - `LabelSyncService.syncRepo` — race branch → `logger.info` + push `unchanged` result + continue; error branch → `logger.error` + set `hadError = true` + capture `firstError` + continue.
- Not a wire format; pure in-process TypeScript.

### `ProvisioningError` (`packages/orchestrator/src/worker/provisioning-failure.ts`)

Lineage-map value type.

```ts
export interface ProvisioningError {
  readonly cause: string;
  readonly statusCode?: number;
  readonly classifiedAt: number;   // Date.now() at write time
}
```

**Validation rules**:

- `cause` is the same string carried on `ProvisioningErrorClassification.cause`.
- `statusCode` is optional and mirrors the classification's field.
- `classifiedAt` is a millisecond timestamp; used for debugging + eventual TTL if one is added later. Not currently consulted for eviction.

**Relationships**:

- Value type of `LabelManager.provisioningFailures.get(key).get(labelName)`.
- Written in FR-003's error branch; read in `addLabels`' 404-enrichment path.
- Not exposed to callers or wire; internal to `LabelManager`.

## Modified State

### `LabelManager` static fields (`packages/orchestrator/src/worker/label-manager.ts`)

**Existing**:

```ts
private static readonly ensuredRepos = new Set<string>();
private static readonly ensureInFlight = new Map<string, Promise<void>>();
```

**Added**:

```ts
private static readonly provisioningFailures = new Map<string, Map<string, ProvisioningError>>();
```

Key: `${owner}/${repo}` (matches `ensuredRepos` / `ensureInFlight`).
Inner-map key: `labelName` (the specific `WORKFLOW_LABELS` entry that failed to provision).
Inner-map value: `ProvisioningError`.

**Modified helper**:

```ts
static resetEnsureCacheForTests(): void {
  LabelManager.ensuredRepos.clear();
  LabelManager.ensureInFlight.clear();
  LabelManager.provisioningFailures.clear();  // NEW
}
```

### `ensureRepoLabelsExist` closure signature

**Before** (`packages/orchestrator/src/worker/label-manager.ts:315-347`):

```ts
const promise = (async () => {
  const existing = await this.github.listLabels(...);
  const missing = WORKFLOW_LABELS.filter(...);
  for (const label of missing) {
    try {
      await this.github.createLabel(...);
    } catch (err) {
      this.logger.warn(..., 'Failed to create workflow label (non-fatal, may already exist)');
    }
  }
})();  // Promise<void>
```

**After**:

```ts
const promise = (async (): Promise<{ hadNonRaceFailure: boolean }> => {
  let hadNonRaceFailure = false;
  const succeededOrRaced = new Set<string>();
  const existing = await this.github.listLabels(...);
  const missing = WORKFLOW_LABELS.filter(...);
  for (const label of missing) {
    try {
      await this.github.createLabel(...);
      succeededOrRaced.add(label.name);
    } catch (err) {
      const classification = classifyLabelProvisioningError(err);
      if (classification.kind === 'already-exists') {
        this.logger.debug(..., 'Workflow label already exists (race)');
        succeededOrRaced.add(label.name);
      } else {
        this.logger.error(
          {
            label: label.name,
            owner: this.owner,
            repo: this.repo,
            err: String(err),
            statusCode: classification.statusCode,
            cause: classification.cause,
          },
          'Failed to create workflow label (provisioning error)',
        );
        writeLineage(this.owner, this.repo, label.name, classification);
        hadNonRaceFailure = true;
      }
    }
  }
  clearLineageForLabels(this.owner, this.repo, succeededOrRaced);
  return { hadNonRaceFailure };
})();
```

Storage in `ensureInFlight` uses `.then(() => undefined)` so awaiters see `void` (Q3→A — the shared Promise resolves normally regardless of `hadNonRaceFailure`).

`ensuredRepos.add(key)` is gated on `!hadNonRaceFailure` (FR-005).

### `LabelSyncService.syncRepo` shape (`packages/orchestrator/src/services/label-sync-service.ts:69-107`)

**Return type unchanged**: `Promise<RepoSyncResult>` where `RepoSyncResult = { owner, repo, success, created, updated, unchanged, error?, results }`.

**Behavioral change**:

- Race on a per-label `createLabel` → `results.push({ name, action: 'unchanged' })`, `unchanged++`, continue. Does NOT flip `success`.
- Non-race error on a per-label `createLabel` or `updateLabel` → log error, set local `hadError = true`, capture `firstError` (only the first cause; subsequent errors are logged but not surfaced in the return field). Does NOT abort the loop.
- Existing `listLabels` failure at the top of the method retains its `try/catch` — it genuinely blocks the whole repo — and returns `success: false, error: <cause>`.

**Result field wiring**:

- `success = !hadError` (true when every classified branch was race or success).
- `error = firstError` (present only when `hadError === true`).

## Modified Data

### `WORKFLOW_LABELS` (`packages/workflow-engine/src/actions/github/label-definitions.ts:100-118`)

Three `description` strings shortened. All three currently exceed the 100-char limit and cause the observed 422 responses.

**Before**:

```ts
{
  name: 'blocked:stuck-feedback-loop',
  color: 'D73A4A',
  description:
    'PR-feedback loop paused itself: last cycle could not advance the trigger. Remove this label to permit another attempt.',
},
{
  name: 'blocked:stuck-validate-fix',
  color: 'D73A4A',
  description:
    'Validate-fix cycle paused itself (#892): duplicate evidence hash, no-diff after spawn, or sibling-file overlap. Remove this label after investigation to allow another attempt.',
},
{
  name: 'blocked:stuck-merge-conflicts',
  color: 'D73A4A',
  description:
    'Merge-conflict resolver (#898) exhausted its one autonomous attempt without producing a conflict-free merge. Remove this label after manual resolution to allow another attempt.',
},
```

**After** (Q4→A):

```ts
{
  name: 'blocked:stuck-feedback-loop',
  color: 'D73A4A',
  description: 'PR-feedback loop paused: last cycle could not advance the trigger. Remove to retry.',
},
{
  name: 'blocked:stuck-validate-fix',
  color: 'D73A4A',
  description: 'Validate-fix paused (#892): duplicate evidence, no-diff, or sibling overlap. Remove to retry.',
},
{
  name: 'blocked:stuck-merge-conflicts',
  color: 'D73A4A',
  description: 'Merge-conflict resolver (#898) exhausted its one autonomous attempt. Remove to retry.',
},
```

Description lengths: 85 / 94 / 86 chars — all ≤100.

Color and name unchanged. No other `WORKFLOW_LABELS` entries touched.

## Relationships Summary

```
classifyLabelProvisioningError (workflow-engine)
    │
    ├── consumed by → LabelManager.ensureRepoLabelsExist
    │                    │
    │                    ├── race branch → logger.debug + continue
    │                    │                                  │
    │                    │                                  └── succeededOrRaced.add(name) — clears lineage on subsequent pass
    │                    │
    │                    └── error branch → logger.error + write to provisioningFailures[repo][name]
    │                                                      + hadNonRaceFailure = true
    │                                                      + subsequent pass re-runs (FR-005)
    │
    └── consumed by → LabelSyncService.syncRepo (per-label loop)
                         │
                         ├── race branch → logger.info + unchanged++ + continue
                         └── error branch → logger.error + hadError=true + firstError capture + continue

LabelManager.provisioningFailures (class-level Map)
    │
    ├── written by → ensureRepoLabelsExist error branch
    ├── read by → addLabels 404 enrichment
    └── cleared by → subsequent successful/raced ensure of the same label
                   & resetEnsureCacheForTests
```

No wire formats. No schema changes at any process boundary. No breaking public-API changes.
