# Research: #916 — `blocked:stuck-*` provisioning 422 + swallowed-as-race + latent 404

## Decision Log

### D1: Where does the race-vs-error classification live? (Q1→A)

**Decision**: Shared helper `classifyLabelProvisioningError(err)` in `packages/workflow-engine/src/actions/github/classify-label-provisioning-error.ts`. Consumed by both `LabelManager.ensureRepoLabelsExist` (`packages/orchestrator/src/worker/label-manager.ts`) and `LabelSyncService.syncRepo` (`packages/orchestrator/src/services/label-sync-service.ts`). Both provisioning surfaces share one classification.

**Rationale**: This very bug is what provisioning-surface divergence looks like — one path already had a swallow-as-race catch that wasn't checking whether the failure was actually a race, and the other path had a coarser top-level catch that turned every failure into `success: false`. Two surfaces inline-checking the `already exists` substring independently (Q1→C) is a drift factory. `LabelSyncService`-as-is (Q1→B) leaves the boot-time sync calling a healthy startup race `success: false`, which was the noise-tier surface the operator was already ignoring. One helper, one home, both consumers.

**Alternatives considered**:

- **Q1→B (`LabelSyncService` unchanged)** — accepts that boot-time races count as failures. Rejected because the sync path was itself part of the noise this bug hides in.
- **Q1→C (per-surface inline checks)** — trivial to write, guaranteed to drift. Rejected on the drift-factory principle.

**Implementation pattern**: pure regex against `Error.message` — no structured error object needed. `gh-cli.ts:938-943` (the `syncRepo`-side path) and `gh-cli.ts:1345-1358` (the `LabelManager`-side path) both wrap stderr into the thrown `Error.message`, so the classifier only reads `err instanceof Error ? err.message : String(err)`. Race regex: `/already[ _]exists/i` (matches both `gh` CLI stderr and REST 422 `errors[0].code`). HTTP-status extraction: `/HTTP\s+(\d{3})/`.

### D2: Apply-time 404 lineage — in-memory map with A as floor (Q2→B)

**Decision**: `LabelManager` maintains an in-memory `Map<string, Map<string, ProvisioningError>>` keyed `${owner}/${repo}` → `labelName` → the classified error recorded by FR-003's non-race branch. `addLabels`, on a 404 that names a label in `WORKFLOW_LABELS`, splices the map entry (if present) into the thrown error's message so the operator (or auto session) reading the apply-time failure sees the provisioning cause inline. FR-003's classified error log is the always-there floor for cross-process gaps.

**Rationale**: The consumer of an apply-time 404 is an operator (or an auto session) staring at a `waiting-for:*` / `blocked:stuck-*` label that failed to apply. Option A (log-only floor) requires them to grep worker logs and correlate timestamps — feasible, but not where they're looking. Option B puts the provisioning cause in the error message right where they're looking, at the cost of one map field on `LabelManager` and one lookup in `addLabels`. Option C mints a `ProvisioningFailedError` class no caller pattern-matches on today — speculative typing.

Same-process gaps are the common case (the ensure-pass ran in the same worker process that hits the 404 later). Cross-process gaps (the ensure-pass ran in a different process — e.g., `LabelSyncService.syncNewRepo` at boot, then a fresh worker process on the same host does the `addLabels` later) degrade gracefully to the raw 404 plus the log line.

**Alternatives considered**:

- **Q2→A (log-only floor)** — always-there but wrong reader surface. Kept as implicit floor for cross-process gaps.
- **Q2→C (`ProvisioningFailedError` class)** — no caller uses it today; adds a class the audit test also has to enumerate.

**Implementation pattern**: `static readonly provisioningFailures = new Map<string, Map<string, ProvisioningError>>()`. Write condition: FR-003's error branch. Read condition: `addLabels` catch when the message contains `HTTP 404` or `Not Found` and the requested labels array includes a `WORKFLOW_LABELS`-known name. Invalidation: per-label success or race in a subsequent pass clears the entry; whole-repo clear via `resetEnsureCacheForTests` (mirroring the existing `ensuredRepos` reset).

### D3: In-flight Promise semantics on non-race failure (Q3→A)

**Decision**: On non-race classified failure inside the ensure-pass, the shared in-flight Promise (`LabelManager.ensureInFlight.get(key)`) **resolves normally** (not rejects). `ensuredRepos` stays unmarked; the next non-concurrent caller re-attempts the pass. Concurrent callers get no direct signal — they pick up the retry on their next phase completion.

**Rationale**: Rejecting the shared Promise would convert one optional label's 422 into failures for every concurrent phase run — phases that likely never touch `blocked:stuck-*` — an outage worse than the bug. The observed incident ran a whole epic to completion with these three labels missing; the fix should make the failure loud in logs and traceable at apply-time (D2's lineage map), not turn one bad description into a fleet-wide phase-loop failure. Loudness belongs in the FR-003 error log and D2's lineage map, not in control flow.

Changing the ensure-pass return type to `Promise<{ ok: boolean; failedLabels: string[] }>` (Q3→C) is another option, but no caller consumes the return value today — the change is speculative shape. If future work needs a per-call signal (e.g., a status-line UI reporting label-provisioning health), extending the type is straightforward and can land then.

**Alternatives considered**: See spec Q3 for the full set.

**Implementation pattern**: closure signature widens from `Promise<void>` to `Promise<{ hadNonRaceFailure: boolean }>` internally, but the value stored in `ensureInFlight` is `.then(() => undefined)` — awaiters see `void`. The outer `ensuredRepos.add` is gated on `!hadNonRaceFailure`.

### D4: Race-path log level tightening — debug (Q5→B)

**Decision**: Race-path (`already exists`) log level drops from `warn` to `debug`.

**Rationale**: A healthy multi-worker startup races by design — every fresh worker calls `ensureRepoLabelsExist` on first touch, and the first N-1 workers to reach `createLabel` on a given label win, so the remaining workers see the race. A signal that fires on every healthy boot is noise-tier by definition and trains operators to ignore warns. Post-classification-rewrite, the only warn+ emission from this catch is a real classified failure — that is the visibility improvement.

Once-per-repo sampling (Q5→C) builds machinery for an event with no operator action attached. Preserving `warn` (Q5→A) keeps the noise. Debug matches the actual operational reality: races are healthy, non-race failures are actionable.

**LabelSyncService symmetry**: `LabelSyncService`'s `Logger` interface only has `info/warn/error` — no `debug`. Use `logger.info` for races at the sync-service layer (analogous decision to `debug` at the label-manager layer — both are "below the operator dashboard's default filter"). Keep `logger.error` for classified errors at both layers.

**Alternatives considered**:

- **Q5→A (preserve warn)** — no visibility change. Rejected on noise-tier grounds.
- **Q5→C (once-per-repo sampling)** — sampling machinery for a no-action event.

### D5: `LabelSyncService.syncRepo` shape after classification (D1 companion)

**Decision**: Per-label `try/catch` inside the `for (const label of WORKFLOW_LABELS)` loop, consuming the shared classifier. Replaces the top-level `try/catch` at lines 76 and 103. Race → skip counting (push `results: { name, action: 'unchanged' }` — a race means the label exists after our attempt regardless of who wrote it), continue. Error → log at error with `{ label, owner, repo, err, statusCode?, cause }`, accumulate `hadError = true` and `firstError ??= classification.cause`, continue to the next label. Return `{ success: !hadError, error: firstError, ... }`.

**Rationale**: The current `LabelSyncService` return contract is `RepoSyncResult { success: boolean; error?: string; created, updated, unchanged; results }`. Existing callers (`syncAll` at lines 113-141) use `success` to increment a counter and `error` for a log line. Preserving this shape avoids ripples. The behavioral change is: races no longer flip `success` to `false`, but classified errors still do. `error` field now names the actual cause (was: the raw stringified error from any code path, race or otherwise).

Continuing past a classified error (instead of aborting the loop) mirrors `LabelManager.ensureRepoLabelsExist`'s continuation behavior — one bad label description shouldn't strand the other 60 labels. A `listLabels` failure (network / auth) genuinely is fatal for the whole repo and keeps its narrow `try/catch` at the top; propagation to `success: false` with a `error: 'listLabels failed: ...'` shape.

**Alternatives considered**:

- **Abort the loop on first classified error** — matches current behavior more closely but strands the other 60 labels. Rejected.
- **Return an array of per-label errors** — richer surface but breaks the `RepoSyncResult` shape.

## Implementation Patterns Referenced

- **Class-level memoization with static `Set` / `Map`** — pattern used by `LabelManager` today for `ensuredRepos` and `ensureInFlight`. FR-008's `provisioningFailures` map extends the same pattern; `resetEnsureCacheForTests` clears all three static fields.
- **Regex-based error classification** — pattern used by `packages/workflow-engine/src/actions/github/client/gh-cli.ts` `parseGhStatusCode` (extracts `HTTP <status>` from stderr). The FR-004 classifier is a small, orthogonal helper — it does not import `parseGhStatusCode` because that function is `gh`-client-internal; the classifier's own regex is simpler and stable to both CLI and REST paths.
- **Parameterized never-regress test** — `describe.each(array)` pattern. Nothing exotic; matches Vitest's built-in `describe.each` / `it.each` idiom.
- **Per-label continuation in a bulk sync** — pattern used by `packages/orchestrator/src/services/label-sync-service.ts` `syncAll` (per-repo continuation despite per-repo failures). FR-004 extends the same continuation shape one level deeper (per-label within a repo).

## Sources

- `packages/workflow-engine/src/actions/github/label-definitions.ts:100-118` — `WORKFLOW_LABELS` `blocked:stuck-*` entries with the three descriptions currently >100 chars.
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:938-943` — first `createLabel` code path (sync-labels-action shape). Wraps stderr into `Error.message` prefixed with `"Failed to create label ${label.name}: "`.
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:1345-1358` — second `createLabel` code path (LabelManager / LabelSyncService shape). Same prefix pattern.
- `packages/orchestrator/src/worker/label-manager.ts:333-345` — the swallowing catch this fix rewrites. Current warn message: `'Failed to create workflow label (non-fatal, may already exist)'`.
- `packages/orchestrator/src/worker/label-manager.ts:41-54` — existing class-level `ensuredRepos` / `ensureInFlight` static fields + `resetEnsureCacheForTests`. FR-008's `provisioningFailures` map is added alongside.
- `packages/orchestrator/src/worker/label-manager.ts:305-356` — `ensureRepoLabelsExist` full implementation. The closure widens from `Promise<void>` to `Promise<{ hadNonRaceFailure: boolean }>` internally (Q3→A).
- `packages/orchestrator/src/services/label-sync-service.ts:69-107` — current `syncRepo` shape with top-level `try/catch`. Rewrite is per-label.
- `packages/orchestrator/src/worker/__tests__/label-manager.ensure.test.ts:104-124` — existing race-behavior test. Updated for FR-007 (debug level + new message).
- `specs/889-found-during-cockpit-v1/` — sibling spec that established the memoized ensure-pass pattern this fix's classifier rewrites the catch inside of.
- `specs/916-found-during-cockpit-v1/spec.md` — spec.
- `specs/916-found-during-cockpit-v1/clarifications.md` — Q1-Q5 answers.
