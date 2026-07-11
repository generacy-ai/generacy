# Contract: `LabelManager.provisioningFailures` lineage map

**Location**: `packages/orchestrator/src/worker/label-manager.ts` (class-level `static readonly` field)

## Shape

```ts
private static readonly provisioningFailures = new Map<string, Map<string, ProvisioningError>>();

interface ProvisioningError {
  readonly cause: string;         // human-readable substring extracted from Error.message
  readonly statusCode?: number;   // extracted via /HTTP\s+(\d{3})/ where present
  readonly classifiedAt: number;  // Date.now() at write time
}
```

Outer key: `${owner}/${repo}` (matches `ensuredRepos` / `ensureInFlight` layout).
Inner key: `labelName` — the specific `WORKFLOW_LABELS` entry that failed to provision.
Inner value: `ProvisioningError`.

## Write conditions

Written exclusively by the **error branch** (not the race branch) of `LabelManager.ensureRepoLabelsExist`'s classification. Concretely: whenever `classifyLabelProvisioningError(err).kind === 'error'` inside the per-label loop of the ensure-pass.

Write is unconditional per label — a subsequent write for the same `(owner, repo, labelName)` overwrites the earlier entry (the newest classification wins).

## Read conditions

Read by `LabelManager.addLabels` (or the underlying method that calls `github.addLabels`) when the underlying API call throws an error whose message contains `HTTP 404` or `Not Found` **and** at least one requested label name matches a `WORKFLOW_LABELS` entry.

For each such 404-implicated label with a lineage entry present, prepend a segment of the form:

```
label "<labelName>": <cause> (HTTP <statusCode>)
```

…to the thrown error's message. Multiple entries are separated by newlines. If `statusCode` is undefined, drop the parenthesized clause. If no lineage entry exists for any 404-implicated label (cross-process gap), throw the raw 404 error unchanged.

## Invalidation

Three invalidation paths:

1. **Per-label success or race in a subsequent pass** — at the end of each `ensureRepoLabelsExist` closure, for every label in the pass that either succeeded (`createLabel` returned) or classified as `already-exists`, delete the lineage entry `provisioningFailures.get(key)?.delete(labelName)`. This is the primary invalidation surface.
2. **Whole-repo cache reset via `resetEnsureCacheForTests`** — clears all three static maps (`ensuredRepos`, `ensureInFlight`, `provisioningFailures`) atomically. Test-only.
3. **Whole-repo reset on FR-005 subsequent-successful pass** — when a subsequent pass completes with `hadNonRaceFailure === false`, `ensuredRepos.add(key)` marks the repo as ensured. Rule 1 already covered clearing per-label entries; no additional whole-repo clear needed at this boundary (a healthy pass already emptied the inner map through rule 1).

## Bounded growth

Bounded by `WORKFLOW_LABELS.length × #repos_touched_this_process`. With ~60 workflow labels and dozens of repos per host, the map fits comfortably within single-digit KB per process. No TTL; entries evict only via rules 1-3 above.

## Concurrency

The map is a plain `Map` — Node's single-threaded event loop guarantees no interleaving of reads/writes. Concurrent ensure-passes on the same repo are prevented by `ensureInFlight` at a higher level (only one closure body runs at a time per key). Concurrent ensure-passes on different repos operate on different inner maps and do not interfere.

## Non-goals

- Not a general failure log. This map holds only classified provisioning failures for `addLabels` enrichment.
- Not a persistent store. Process-scoped; a worker restart drops the map. Cross-process gaps degrade to raw 404 + FR-003 error log (the always-there floor).
- Not exposed to callers. `LabelManager` reads it internally; no getter, no serialization, no metrics scrape.

## Test surface

`packages/orchestrator/src/worker/__tests__/label-manager.addlabels-enrichment.test.ts`:

- Prime the map with a 422 fixture on `blocked:stuck-feedback-loop`; call `addLabels(['blocked:stuck-feedback-loop', 'agent:paused'])` with a mocked 404; assert the thrown error message contains `label "blocked:stuck-feedback-loop": description is too long (HTTP 422)`.
- Reset the map; call `addLabels` with a mocked 404; assert the raw 404 message is thrown (no enrichment).
- Assert the map is cleared for a label after a subsequent successful ensure-pass on the same label.
