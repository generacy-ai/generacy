# Implementation Plan: `blocked:stuck-*` label provisioning 422s + swallowed-as-race + latent 404 at apply time

**Feature**: Fix a #889-class defect where three `blocked:stuck-*` labels never provision (descriptions >100 chars → GitHub 422) but the provisioning catch mislabels the failure as `"(non-fatal, may already exist)"`. Ship (1) shortened descriptions with a static never-regress test, (2) a shared `classifyLabelProvisioningError` helper consumed by both `LabelManager.ensureRepoLabelsExist` and `LabelSyncService.syncRepo`, (3) an error-level log on classified failure + debug-level log on race, (4) `ensuredRepos` cache-invalidation on non-race failure with the shared in-flight Promise resolving normally, and (5) an in-memory lineage map on `LabelManager` that enriches `addLabels`-time 404s with the earlier provisioning cause.
**Branch**: `916-found-during-cockpit-v1`
**Status**: Complete

## Summary

Same defect class as #889 (unprovisioned label → 404 at apply time), reintroduced through the provisioning path that was supposed to close it. Three `blocked:stuck-*` entries in `WORKFLOW_LABELS` carry descriptions of 118 / 172 / 174 chars — over GitHub's 100-char `createLabel` description limit. Every worker's phase-loop startup emits three `HTTP 422: Validation Failed / description is too long (maximum is 100 characters)` errors on the ensure-pass, and the surrounding catch in `label-manager.ts:333-345` announces `"Failed to create workflow label (non-fatal, may already exist)"` — a lying signature. The label doesn't already exist; creation genuinely failed; the labels stay missing; the first `blocked:stuck-*` apply attempt 404s the run.

The fix has five parts that ship in a single atomic PR (FR-009):

- **FR-001** — shorten the three offending descriptions to ≤100 chars using the Q4→A wording (terse cause + `Remove to retry` directive + `#892`/`#898` refs).
- **FR-002** — parameterized static unit test in `packages/workflow-engine/src/actions/github/__tests__/label-definitions.test.ts` asserting `label.description.length <= 100` for every entry. Adding a >100-char description in a future PR breaks CI.
- **FR-003 + FR-004** — extract race-vs-error classification into a shared helper `classifyLabelProvisioningError(err)` in `packages/workflow-engine/src/actions/github/classify-label-provisioning-error.ts` (returns `{ kind: 'already-exists' } | { kind: 'error', cause: string, statusCode?: number }`). Rewrite `LabelManager.ensureRepoLabelsExist`'s catch (`label-manager.ts:333-345`) to call the helper: race → `logger.debug` (Q5→B) + continue; error → `logger.error` naming the actual cause + continue (no throw). Rewrite `LabelSyncService.syncRepo` to per-label try/catch consuming the same helper: race → silently continue; error → log error + set `success: false` on the returned result. Replaces the current top-level `try/catch` that returns `success: false` on the first race.
- **FR-005** — populate `ensuredRepos` **only** when every `createLabel` in the pass either succeeded or classified as `already-exists`. Any error-classified failure leaves the repo unmarked, so a subsequent non-concurrent caller re-attempts. The shared in-flight Promise in `ensureInFlight` **resolves normally** (Q3→A) — concurrent callers do not get a rejected Promise; the retry is driven by the next non-concurrent call finding the repo still unmarked.
- **FR-008** — `LabelManager` gains an in-memory lineage map `LabelManager.provisioningFailures: Map<string, Map<string, ProvisioningError>>` keyed `${owner}/${repo}` → `labelName` → the classified error. Populated in the error branch of FR-003. `addLabels`, on a 404 that names a label in `WORKFLOW_LABELS`, looks up the map and enriches the thrown error message with the provisioning cause. Cleared on the same lifecycle as `ensuredRepos` (Q2→B). FR-003's error log is the always-there floor for cross-process gaps.

## Technical Context

- **Language / runtime**: TypeScript, Node.js >=22, ESM. Packages `@generacy-ai/orchestrator` (`packages/orchestrator`) and `@generacy-ai/workflow-engine` (`packages/workflow-engine`).
- **Test runner**: Vitest (`packages/orchestrator/vitest.config.ts`, `packages/workflow-engine/vitest.config.ts`).
- **New dependencies**: none. The classification helper is pure regex against `Error.message` (`gh-cli.ts:938-943` and `gh-cli.ts:1345-1358` both wrap stderr into the thrown `Error.message`); the lineage map is a plain `Map<string, Map<string, ProvisioningError>>`.
- **Behavioral invariants preserved**:
  - Healthy race path (already-exists) — no observable change beyond log-level narrowing (warn → debug, Q5→B). `ensuredRepos` still populates; `addLabels` still runs.
  - Non-race provisioning failure — new: `ensuredRepos` stays unmarked (was populated); shared in-flight Promise still resolves (unchanged); error-level log replaces the misleading warn.
  - `LabelSyncService.syncRepo` — return type unchanged (`RepoSyncResult`), but a healthy startup race no longer returns `success: false` mid-loop; only classified errors do.
  - `WorkerHandler` return type and terminal-failure signaling from #889 — untouched. This fix is orthogonal to the terminal-error protocol.

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo — no project-level constitutional constraints to verify. The change respects standing generacy conventions:

- **Additive-only public API**: `classifyLabelProvisioningError` is a new export from `@generacy-ai/workflow-engine`. No signatures change on `GitHubClient`, `LabelManager`, or `LabelSyncService`. Lineage map is a class-level `static` field on `LabelManager` — no constructor change.
- **`WORKFLOW_LABELS` remains the single source of truth**: FR-001 only edits three `description` strings; no add or remove. FR-002's parameterized test asserts a class invariant on the source-of-truth array.
- **One classification home** (Q1→A): `packages/workflow-engine/src/actions/github/classify-label-provisioning-error.ts` is the single home for the race/error dispatch. Both provisioning surfaces (`LabelManager`, `LabelSyncService`) consume it. Prevents drift — this very bug's shape.
- **Log levels preserved on healthy paths, tightened on noise-tier**: race path drops from warn → debug (Q5→B) — healthy multi-worker boot races on every startup by design; keeping warn trains operators to ignore warns.
- **Tests colocated**: `packages/workflow-engine/src/actions/github/__tests__/` for the definitions test, the classifier test, and the label-sync-service race-vs-error test; `packages/orchestrator/src/worker/__tests__/` for the ensure-pass classification, cache-invalidation, lineage-map, and addLabels-enrichment tests.

## Project Structure

```
packages/
├── workflow-engine/
│   └── src/actions/github/
│       ├── label-definitions.ts                                # MODIFIED — FR-001 shortened descriptions (three entries only)
│       ├── classify-label-provisioning-error.ts                # NEW — FR-004 shared classifier
│       └── __tests__/
│           ├── label-definitions.test.ts                       # NEW — FR-002 parameterized description-length invariant
│           └── classify-label-provisioning-error.test.ts       # NEW — FR-004 unit tests for the classifier (race, 422 validation, 401, 403, 5xx)
├── orchestrator/
│   └── src/
│       ├── worker/
│       │   ├── label-manager.ts                                # MODIFIED — FR-003 classify catch; FR-005 cache-invalidation on error; FR-008 lineage map + addLabels enrichment
│       │   ├── provisioning-failure.ts                         # NEW — FR-008 `ProvisioningError` type + lineage-map key helpers
│       │   └── __tests__/
│       │       ├── label-manager.ensure.test.ts                # MODIFIED — FR-006 fixtures: 422 injected → error-log + ensuredRepos NOT populated + subsequent retry; race → debug-log (FR-007); FR-008 lineage-map entries written on error
│       │       └── label-manager.addlabels-enrichment.test.ts  # NEW — FR-008 same-process 404 surfaces provisioning cause; cross-process 404 (map miss) surfaces raw 404
│       └── services/
│           ├── label-sync-service.ts                           # MODIFIED — FR-004 per-label try/catch consuming shared classifier; success flag flips only on classified error
│           └── __tests__/
│               └── label-sync-service.classify.test.ts         # NEW — FR-004 fixtures: race across N labels → success:true; 422 on one label → success:false + error names actual cause
└── (no other packages touched)

specs/916-found-during-cockpit-v1/
├── spec.md                                                     # unchanged (read-only)
├── clarifications.md                                           # unchanged
├── plan.md                                                     # this file
├── research.md                                                 # decisions, rationale, sources
├── data-model.md                                               # new types + modified state
├── contracts/
│   ├── classify-label-provisioning-error.md                    # classifier contract
│   ├── provisioning-lineage-map.md                             # lineage map key/value + lifecycle
│   └── label-description-invariant.md                          # FR-002 static test contract
├── quickstart.md                                               # verification steps
└── checklists/
    └── (empty — no additional gates)
```

## Implementation Sequence

1. **FR-001 — shorten descriptions.** Edit `packages/workflow-engine/src/actions/github/label-definitions.ts`:
   - `blocked:stuck-feedback-loop` description → `'PR-feedback loop paused: last cycle could not advance the trigger. Remove to retry.'` (85 chars).
   - `blocked:stuck-validate-fix` description → `'Validate-fix paused (#892): duplicate evidence, no-diff, or sibling overlap. Remove to retry.'` (94 chars).
   - `blocked:stuck-merge-conflicts` description → `'Merge-conflict resolver (#898) exhausted its one autonomous attempt. Remove to retry.'` (86 chars).
   No other entries change.

2. **FR-002 — static description-length test.** Create `packages/workflow-engine/src/actions/github/__tests__/label-definitions.test.ts`:
   - `describe.each(WORKFLOW_LABELS)` → `it('${name} has description ≤100 chars', () => expect(description.length).toBeLessThanOrEqual(100))`.
   - Also a bulk assertion for symmetry: `expect(WORKFLOW_LABELS.every(l => l.description.length <= 100)).toBe(true)`.

3. **FR-004 — shared classifier.** Create `packages/workflow-engine/src/actions/github/classify-label-provisioning-error.ts`:
   - Export type `ProvisioningErrorClassification = { kind: 'already-exists' } | { kind: 'error'; cause: string; statusCode?: number }`.
   - Export `classifyLabelProvisioningError(err: unknown): ProvisioningErrorClassification`:
     - Extract message: `err instanceof Error ? err.message : String(err)`.
     - Race detection: `/already[ _]exists/i.test(message)` → `{ kind: 'already-exists' }`. Canonical signal in both `gh label create` CLI stderr and REST `errors[0].code`.
     - HTTP status extraction: `message.match(/HTTP\s+(\d{3})/)` → optional `statusCode`.
     - Cause extraction: strip the leading `"Failed to create label <name>: "` prefix if present (added by `gh-cli.ts:941` and `gh-cli.ts:1357`), leaving the raw stderr / body substring.
     - Return `{ kind: 'error', cause, statusCode }`.
   - Add to `packages/workflow-engine/src/index.ts` public exports: `export { classifyLabelProvisioningError } from './actions/github/classify-label-provisioning-error.js';` and its type.

4. **FR-004 — classifier unit tests.** `packages/workflow-engine/src/actions/github/__tests__/classify-label-provisioning-error.test.ts` covers:
   - `Error("label already exists")` → `already-exists`.
   - `Error("HTTP 422: Validation Failed\ndescription is too long (maximum is 100 characters)")` → `error`, statusCode `422`, cause contains `description is too long`.
   - `Error("HTTP 401: Bad credentials")` → `error`, statusCode `401`.
   - `Error("HTTP 403: Resource not accessible by integration")` → `error`, statusCode `403`.
   - `Error("HTTP 500: Internal Server Error")` → `error`, statusCode `500`.
   - `Error("Failed to create label foo: HTTP 422: ...")` → `error`, cause has the `Failed to create label foo: ` prefix stripped.
   - Non-Error input (`String("gone")`) → `error`, cause `gone`.

5. **FR-003 — rewrite the ensure-pass catch in `LabelManager`.** In `packages/orchestrator/src/worker/label-manager.ts:333-345`:
   - Import `classifyLabelProvisioningError` from `@generacy-ai/workflow-engine`.
   - Add local mutable `let anyError = false` in the outer async closure (line ~315).
   - In the catch block, call `const classification = classifyLabelProvisioningError(err)`.
   - Race branch (`classification.kind === 'already-exists'`) → `this.logger.debug({ label: label.name, owner, repo, err: String(err) }, 'Workflow label already exists (race)')` (Q5→B). Continue.
   - Error branch (`classification.kind === 'error'`) → `this.logger.error({ label: label.name, owner: this.owner, repo: this.repo, err: String(err), statusCode: classification.statusCode, cause: classification.cause }, 'Failed to create workflow label (provisioning error)')`. Set `anyError = true`. Record in lineage map (see step 7). Continue.
   - After the loop, capture `anyError` in the closure's return value (via a small refactor — see step 6 for `ensuredRepos` gating).

6. **FR-005 — cache-invalidation on non-race failure.** Extend the closure signature from `Promise<void>` to `Promise<{ hadNonRaceFailure: boolean }>`. Line 350-355 becomes:
   ```ts
   LabelManager.ensureInFlight.set(key, promise.then(() => undefined));  // shared awaiters see void resolution (Q3→A)
   try {
     const { hadNonRaceFailure } = await promise;
     if (!hadNonRaceFailure) {
       LabelManager.ensuredRepos.add(key);
     }
   } finally {
     LabelManager.ensureInFlight.delete(key);
   }
   ```
   Concurrent callers awaiting `ensureInFlight.get(key)` receive `void` — they cannot distinguish success from partial failure. The next non-concurrent caller finds `ensuredRepos.has(key) === false` and re-runs the pass.

7. **FR-008 — lineage map + `addLabels` enrichment.** In `LabelManager`:
   - Add `private static readonly provisioningFailures = new Map<string, Map<string, ProvisioningError>>()`. Key: `${owner}/${repo}`. Value: `Map<labelName, ProvisioningError>` where `ProvisioningError = { cause: string; statusCode?: number; classifiedAt: number }`.
   - Add `LabelManager.resetEnsureCacheForTests()` (existing at line 51) also calls `LabelManager.provisioningFailures.clear()`.
   - In step 5's error branch: build the inner map lazily; write `innerMap.set(label.name, { cause: classification.cause, statusCode: classification.statusCode, classifiedAt: Date.now() })`.
   - When step 6 clears `ensuredRepos` invalidation branch on repeat pass (i.e., when the pass re-runs and this time succeeds), delete the corresponding lineage entries. Concrete rule: at the *end* of the closure (before returning `{ hadNonRaceFailure }`), for every label in the pass that succeeded or classified as `already-exists`, delete its lineage entry. This matches Q2's "cleared alongside FR-005's cache invalidation" — the lifecycle is: an error write survives across pass retries until the next pass either succeeds or classifies as race on that specific label.
   - `addLabels` (`label-manager.ts:` — locate the method): after the underlying API call, on error whose message contains `HTTP 404` or `Not Found` and where the requested `labels` array contains at least one name present in `WORKFLOW_LABELS.map(l => l.name)`, look up `provisioningFailures.get(key)`. For each 404-implicated label with a lineage entry, prepend `label "<name>": <cause> (HTTP <statusCode>)` to the thrown error's message. If no lineage present (cross-process gap), throw the raw 404 unchanged — FR-003's error log is the trace surface.

8. **FR-004 — rewrite `LabelSyncService.syncRepo`.** In `packages/orchestrator/src/services/label-sync-service.ts:69-107`:
   - Import `classifyLabelProvisioningError` from `@generacy-ai/workflow-engine`.
   - Remove the outer `try/catch` at lines 76 and 103.
   - Introduce a `let hadError = false; let firstError: string | undefined;` accumulator.
   - Move the `existingLabels` fetch outside a broader try (still needs to be reachable) — a `listLabels` failure is genuinely fatal for this repo and *should* propagate to the outer `success: false` return; keep a narrow `try/catch` around just that line.
   - For each `label of WORKFLOW_LABELS`: wrap `createLabel` / `updateLabel` in per-label `try/catch`. On catch, call `classifyLabelProvisioningError`. Race → log at debug (matching FR-003's Q5→B) and continue (do NOT increment counters — a create-race means the label was created by another process, which for `syncRepo` counts as `created` conceptually; simplest is to skip counting and push `{ name, action: 'unchanged' }`). Error → log at error with `{ label, owner, repo, err, statusCode?, cause }`, set `hadError = true` and `firstError ??= classification.cause`, continue to the next label (do NOT abort — parallel to FR-003's "continue past races and errors alike").
   - Return `{ owner, repo, success: !hadError, created, updated, unchanged, error: firstError, results }`. Preserves the caller contract (`success: false` still surfaces a real failure; `error` names the actual cause instead of "the whole repo failed for some unspecified reason").

9. **FR-006 — regression fixtures.** Update `packages/orchestrator/src/worker/__tests__/label-manager.ensure.test.ts`:
   - **422 three-label injected fixture** (`describe('classifies provisioning failures')`):
     - `github.createLabel.mockImplementation(async (_, __, name) => { if (name.startsWith('blocked:stuck-')) throw new Error('Failed to create label ' + name + ': HTTP 422: Validation Failed\ndescription is too long (maximum is 100 characters)'); })`.
     - Call `lm.onPhaseComplete('plan')`.
     - Assert (a) three `mockLogger.error` calls with `{ label, statusCode: 422, cause: expect.stringContaining('description is too long') }` and message `'Failed to create workflow label (provisioning error)'`.
     - Assert (b) `mockLogger.warn` NOT called with `'may already exist'`.
     - Assert (c) `github.addLabels` still called (outer op runs).
     - Assert (d) `LabelManager.ensuredRepos.has('test-owner/test-repo')` is `false` after the pass.
     - Assert (e) `LabelManager.provisioningFailures.get('test-owner/test-repo')?.size === 3`.
     - Assert (f) `github.listLabels.mockClear(); github.createLabel.mockClear(); await lm.onPhaseComplete('specify')` → `listLabels` called again (re-attempt).
   - **Same-process 404 lineage** (in `label-manager.addlabels-enrichment.test.ts`):
     - Prime lineage via a failed pass, then mock `github.addLabels` to throw `new Error('HTTP 404: Not Found')` on `[blocked:stuck-feedback-loop, agent:paused]`.
     - Assert the thrown error from the `LabelManager` method includes `label "blocked:stuck-feedback-loop": description is too long (HTTP 422)`.
   - **Cross-process 404 lineage** (map miss):
     - Reset caches (`LabelManager.resetEnsureCacheForTests()`), then `addLabels` returns 404 without a prior lineage entry.
     - Assert the thrown error is the raw 404.

10. **FR-007 — race-path fixture update.** Update `label-manager.ensure.test.ts:104-124`:
    - Change the assertion from `mockLogger.warn` → `mockLogger.debug`.
    - Change the message-substring assertion from `'Failed to create workflow label'` → `'Workflow label already exists (race)'`.
    - Assert `ensuredRepos.has(key) === true` (race still populates cache).
    - Assert `LabelManager.provisioningFailures.get(key)` is undefined or empty (race does NOT write to lineage).

11. **FR-004 — `label-sync-service.classify.test.ts`.** New file. Two fixtures:
    - All-races: every `createLabel` throws `'already exists'` — assert `success: true`, `logger.debug` called (or the service's `logger.info` if a lower-level logger is preferred; keep aligned with `Logger` interface at line 39-43 — since the interface has only `info/warn/error`, use `info` at the sync-service layer for races and keep `logger.error` for classified errors; document this choice in `research.md` D5).
    - One 422: one `createLabel` throws `HTTP 422`, others succeed — assert `success: false`, `error` contains `description is too long`, `logger.error` called once with the classified fields.

12. **FR-009 — atomic PR checklist.** All of the above land together: (i) label-definitions.ts edits + description-length test, (ii) shared classifier + its unit test, (iii) LabelManager classify-rewrite + cache-invalidation + lineage map + addLabels enrichment + tests, (iv) LabelSyncService per-label loop + tests. No feature-flagging.

## Contracts

- `contracts/classify-label-provisioning-error.md` — classifier signature, race regex, HTTP-status extraction, non-Error input handling. Consumers: `LabelManager.ensureRepoLabelsExist`, `LabelSyncService.syncRepo`. Not a wire format; pure in-process TypeScript.
- `contracts/provisioning-lineage-map.md` — lineage map key layout (`${owner}/${repo}` → `Map<labelName, ProvisioningError>`), write conditions (error branch only, never race), read conditions (`addLabels` 404 with a `WORKFLOW_LABELS`-matching label name), invalidation rules (per-label success or race in a subsequent pass; whole-repo clear via `resetEnsureCacheForTests`).
- `contracts/label-description-invariant.md` — the FR-002 test's discovery rule (`describe.each(WORKFLOW_LABELS)`), the assertion (`description.length <= 100`), the failure surface (blocks merge).

## Data Model

See `data-model.md`. Summary:

- **New export** from `@generacy-ai/workflow-engine`: `classifyLabelProvisioningError` + `ProvisioningErrorClassification` type.
- **New class-level state** on `LabelManager`: `static readonly provisioningFailures: Map<string, Map<string, ProvisioningError>>`.
- **New helper type** in `packages/orchestrator/src/worker/provisioning-failure.ts`: `ProvisioningError = { cause: string; statusCode?: number; classifiedAt: number }`.
- **Modified data** in `label-definitions.ts`: three shortened `description` strings.

No breaking public-API changes. No new dependencies.

## Risks & Non-Risks

- **Non-risk — classifier drift**. The classifier is regex-based against `Error.message` shape that has been stable across both `gh` CLI and REST paths for years. If GitHub CLI ever changes the `already exists` substring, the classifier misclassifies races as errors, which is *loud-fail* (an error log + a temporary cache-miss on the affected repo) — a debuggable regression, not a crash. Spec §Assumptions notes this.
- **Non-risk — cache-invalidation hot-loop**. `ensureRepoLabelsExist` is only invoked from `onPhaseComplete`, `onPhaseStart`, `onGateHit`, `onError`, `onResumeStart`, `onWorkflowComplete` — each bounded by workflow progression, not wall-clock ticks. Worst case: one wasted `listLabels + createLabel` per phase completion until the operator shortens the offending description. Spec §Assumptions confirms.
- **Non-risk — concurrent-caller starvation on non-race failure**. Q3→A: shared in-flight Promise resolves normally (not rejects) even when the pass records a non-race failure. Concurrent callers get the same "success" they would have gotten before this PR; the retry is driven by the next non-concurrent call. Rejecting the shared Promise would convert one optional label's 422 into failures for every concurrent phase run — an outage worse than the observed bug.
- **Non-risk — lineage-map memory bloat**. Bounded by `WORKFLOW_LABELS.length × #repos_touched_this_process`, i.e., single-digit KB per repo. Cleared on `resetEnsureCacheForTests` and on subsequent successful passes per-label (step 7 rule).
- **Risk (mitigated) — `LabelSyncService.syncRepo` behavior change**. Before this PR: any `createLabel` failure returns `success: false` on the whole repo, including on a healthy first-boot race (which was already noise). After this PR: race → `success: true` (correctly ignored), non-race → `success: false` with `error` field naming the actual cause (strictly more informative). The one caller of `syncRepo` (`syncAll` at line 113-141) uses `success` to increment a counter and log; behavior on the healthy race path shifts from `failedRepos++` to `successfulRepos++`, which is what the operator wanted anyway. The one caller of `syncNewRepo` in the codebase reads `success` similarly — no downstream breakage.
- **Risk (mitigated) — `addLabels` message enrichment regexp brittleness**. Enrichment triggers on `HTTP 404` or `Not Found` in the thrown error's message *and* the presence of a `WORKFLOW_LABELS` name in the requested labels array. If `gh` ever emits a different 404 shape (e.g., `Response 404`), enrichment silently misses. FR-003's error log is the always-there floor for this case (spec Q2 rationale).

## Next Step

Run `/speckit:tasks` to generate the task list.
