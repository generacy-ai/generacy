# Quickstart: #916 verification

## What this fix does

Three `blocked:stuck-*` label descriptions in `WORKFLOW_LABELS` exceeded GitHub's 100-char `createLabel` description limit (118 / 172 / 174 chars). The provisioning path caught the resulting 422 and logged it as `"Failed to create workflow label (non-fatal, may already exist)"` — but the labels did not exist. The next apply attempt on any `blocked:stuck-*` label 404'd, silently ending the workflow. Same defect class as #889, reintroduced through the very provisioning path that closed #889.

The fix ships:

- **Shortened descriptions** — three `blocked:stuck-*` entries now ≤100 chars.
- **Never-regress test** — parameterized Vitest assertion over `WORKFLOW_LABELS` prevents future entries from exceeding 100 chars.
- **Shared classifier** — `classifyLabelProvisioningError` in `@generacy-ai/workflow-engine`, consumed by both `LabelManager.ensureRepoLabelsExist` and `LabelSyncService.syncRepo`. Distinguishes race (`already exists` in stderr / `already_exists` in REST body) from real errors (422, 401, 403, 5xx).
- **Loud error logs on real failures** — `logger.error` naming the actual failure cause instead of the "may already exist" line.
- **Cache-invalidation on non-race failure** — `ensuredRepos` stays unmarked when any label failed non-race, so the next non-concurrent caller re-runs the pass. Concurrent callers on the shared in-flight Promise still see normal resolution (no reject-cascade).
- **Lineage map for apply-time 404** — when `addLabels` 404s on a label whose provisioning failed non-race in the same process, the thrown error names the provisioning cause inline.

## Manual verification

### Repro the pre-fix log lines (baseline)

1. Check out `develop` before this fix lands.
2. Boot a worker container against any repo without the `blocked:stuck-*` labels already provisioned. Watch worker logs.
3. Observe three `Failed to create workflow label (non-fatal, may already exist)` warns paired with `HTTP 422: Validation Failed / description is too long (maximum is 100 characters)` stderr each.
4. Try to apply a `blocked:stuck-feedback-loop` label to an issue on the same repo — GitHub returns 404 (label not found).

### Verify the fix

1. Check out `916-found-during-cockpit-v1` after implementation lands.
2. Repeat the same repro.
3. **Expected observable changes**:
   - Worker boot logs no longer emit the three "(non-fatal, may already exist)" warns.
   - `LabelManager.ensureRepoLabelsExist` runs once at first-touch and creates all three `blocked:stuck-*` labels successfully.
   - Applying `blocked:stuck-feedback-loop` succeeds (label exists on the repo).
4. **Failure-mode verification** (simulate an unrelated non-race failure — e.g., inject a 401 by revoking the App token temporarily):
   - Worker logs one error-level entry per failed label: `Failed to create workflow label (provisioning error)` with structured fields `{ label, owner, repo, err, statusCode: 401, cause }`.
   - `LabelManager.ensuredRepos` does NOT contain the repo — a subsequent phase-completion re-attempts the pass.
   - If `addLabels(['blocked:stuck-feedback-loop', 'agent:paused'])` then fires and 404s in the same process, the thrown error's message contains `label "blocked:stuck-feedback-loop": <cause> (HTTP 401)`.

## Automated test verification

Run these targeted tests:

```bash
# FR-002 static description-length invariant
pnpm --filter @generacy-ai/workflow-engine test src/actions/github/__tests__/label-definitions.test.ts

# FR-004 shared classifier unit tests
pnpm --filter @generacy-ai/workflow-engine test src/actions/github/__tests__/classify-label-provisioning-error.test.ts

# FR-003 + FR-005 + FR-006 + FR-007 ensure-pass classification, cache-invalidation, race-path debug level
pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/label-manager.ensure.test.ts

# FR-008 same-process lineage + cross-process fallback
pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/label-manager.addlabels-enrichment.test.ts

# FR-004 LabelSyncService per-label loop
pnpm --filter @generacy-ai/orchestrator test src/services/__tests__/label-sync-service.classify.test.ts

# Non-regression sweep
pnpm --filter @generacy-ai/orchestrator test
pnpm --filter @generacy-ai/workflow-engine test
```

## Success criteria (from spec)

| SC     | Verification                                                                                                                    |
|--------|---------------------------------------------------------------------------------------------------------------------------------|
| SC-001 | `label-manager.ensure.test.ts` fixture: `github.createLabel` mock validating description length rejects nothing on `WORKFLOW_LABELS`. |
| SC-002 | `label-definitions.test.ts` parameterized test: green today; adding a >100-char entry in a future PR breaks CI.                  |
| SC-003 | `label-manager.ensure.test.ts` classified-failure fixture: `mockLogger.error` called with cause substring; `mockLogger.warn` NOT called with `may already exist`. |
| SC-004 | `label-manager.ensure.test.ts` race-path fixture (updated from line 104-124): `mockLogger.debug` called with `Workflow label already exists (race)`; zero warn+ log entries. |
| SC-005 | `label-manager.ensure.test.ts` cache-invalidation fixture: after a 422 on one label, `LabelManager.ensuredRepos.has(key) === false`; second `onPhaseComplete` call runs `listLabels` again. |
| SC-006 | Manual repro above: zero "(non-fatal, may already exist)" log lines paired with 422 stderr on a fresh phase-loop boot.          |
| SC-007 | `label-manager.addlabels-enrichment.test.ts`: three assertions — happy path (labels exist, `addLabels` succeeds), same-process 404 (thrown error contains provisioning cause via lineage map), cross-process 404 (raw 404 thrown, FR-003 log is the trace surface). |

## Troubleshooting

- **`classifyLabelProvisioningError` misclassifies a real 422 as `already-exists`** — check that GitHub's stderr / REST body actually contains `already exists` / `already_exists` for the specific error. If a new failure mode surfaces (e.g., a rate-limit error using the phrase `resource already exists in queue`), narrow the regex or add a specific exclusion. Spec §Assumptions notes this stability assumption.
- **`ensuredRepos` marks a repo despite a non-race failure** — verify the closure returns `{ hadNonRaceFailure: boolean }` and that the `add(key)` call is gated on `!hadNonRaceFailure`. The `ensureInFlight` `.then(() => undefined)` step must not lose the value.
- **Concurrent callers see a rejected Promise on non-race failure** — Q3→A specifies the shared Promise resolves normally regardless. Verify no `throw` inside the closure body (all classified errors are caught and continued).
- **`addLabels` 404 enrichment adds junk from labels not in `WORKFLOW_LABELS`** — the enrichment loop must filter to labels present in the map's inner key set; arbitrary user labels (`type:*`, `epic-child`, etc.) that happen to be in `WORKFLOW_LABELS` are fine — they simply won't have a lineage entry.
- **Lineage-map memory growth on long-running workers** — inspection: `LabelManager.provisioningFailures.size` should stabilize at the number of repos this worker has touched. Per-label entries evict on subsequent successful/raced passes. If entries persist forever, verify the closure's `succeededOrRaced` tracking and end-of-closure `delete` loop.
