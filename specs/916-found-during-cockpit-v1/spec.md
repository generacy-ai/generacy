# Feature Specification: orchestrator: blocked:stuck-* label provisioning 422s (description >100 chars) and is swallowed as 'may already exist' — latent 404 at apply time (#889 class)

**Branch**: `916-found-during-cockpit-v1` | **Date**: 2026-07-11 | **Status**: Draft

## Clarifications

### Batch 1 — 2026-07-11
- **Q1 (FR-004) → A**: Shared `classifyLabelProvisioningError` helper in `packages/workflow-engine/src/actions/github/` used by both `LabelManager.ensureRepoLabelsExist` and `LabelSyncService.syncRepo`. One classification, one home, both consumers. `LabelSyncService` still returns `success: false` on non-race, but classifies via the shared helper and continues past races.
- **Q2 (FR-008) → B**: In-memory lineage map (`Map<repoKey, Map<labelName, provisioningError>>`) on `LabelManager`, populated by the classified-error branch of `ensureRepoLabelsExist`. `addLabels` checks the map on 404 and enriches the thrown error's message with the provisioning cause. Cleared alongside FR-005's cache invalidation. FR-003's classified error log remains the always-there floor for cross-process gaps.
- **Q3 (FR-005) → A**: On non-race classified failure, the shared in-flight Promise resolves normally (no rejection, no return-type change). `ensuredRepos` stays unmarked; the next non-concurrent caller re-attempts. Rejecting the shared Promise would turn one optional label's 422 into failures for every concurrent phase run — worse than the observed bug (the observed incident ran a whole epic to completion with these labels missing). Loudness belongs in FR-003's log and Q2's lineage map, not in control flow.
- **Q4 (FR-001) → A**: Terse cause + "Remove to retry" directive + issue ref. Concrete strings (each ≤100 chars):
  - `blocked:stuck-feedback-loop`: `PR-feedback loop paused: last cycle could not advance the trigger. Remove to retry.`
  - `blocked:stuck-validate-fix`: `Validate-fix paused (#892): duplicate evidence, no-diff, or sibling overlap. Remove to retry.`
  - `blocked:stuck-merge-conflicts`: `Merge-conflict resolver (#898) exhausted its one autonomous attempt. Remove to retry.`
- **Q5 (FR-003, FR-007, SC-004) → B**: Race (`already exists`) path logs at **debug**. Healthy multi-worker startup races by design — warn on every healthy boot is noise-tier and trains operators to ignore warns. Post-rewrite, the only warn+ emission from this catch is a real classified failure.

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #56 — snappoll full-epic run. Same defect class as #889 (unprovisioned label → 404 at apply time), reintroduced through the provisioning path that was supposed to close it.

## Observed

Worker label provisioning fails for three built-in workflow labels because their **descriptions exceed GitHub's 100-character limit**, and the failure is swallowed by a catch whose log message asserts the opposite of what happened:

```
Failed to create label blocked:stuck-feedback-loop: HTTP 422: Validation Failed
  description is too long (maximum is 100 characters)
msg: "Failed to create workflow label (non-fatal, may already exist)"
```

Same for `blocked:stuck-validate-fix` and `blocked:stuck-merge-conflicts` (snappoll worker logs, every phase-loop startup). The labels do **not** already exist — creation genuinely failed — so the first time any workflow path tries to *apply* a `blocked:stuck-*` label, it will 404: the exact dead-end #889 fixed for `waiting-for:*`, reintroduced through the provisioning path that was supposed to prevent it. The "(non-fatal, may already exist)" log line is a lying error signature: a 422 validation error is not an already-exists race.

The current descriptions in `WORKFLOW_LABELS` (`packages/workflow-engine/src/actions/github/label-definitions.ts`) measure:

- `blocked:stuck-feedback-loop`: **118 chars** (>100, rejected by GitHub)
- `blocked:stuck-validate-fix`: **172 chars** (>100, rejected by GitHub)
- `blocked:stuck-merge-conflicts`: **174 chars** (>100, rejected by GitHub)

The swallowing catch lives at `packages/orchestrator/src/worker/label-manager.ts:333-345` (`ensureRepoLabelsExist`) and treats every failure as a benign create-race. `LabelSyncService.syncRepo` (`packages/orchestrator/src/services/label-sync-service.ts:75-107`) hits the same descriptions on the same GitHub validation, but its top-level `try/catch` marks the whole repo `success: false` — a louder but still ambiguous surface.

## Fix

Two coordinated changes, mirroring the #889 class remediation:

1. **Shorten the three built-in label descriptions to ≤100 characters** and add a static unit test asserting every entry in `WORKFLOW_LABELS` has `description.length <= 100`, so this can never regress silently again.
2. **Classify the provisioning catch in `ensureRepoLabelsExist`**: `already_exists` (GitHub 422 with `"code":"already_exists"` or CLI stderr `already exists`) → keep the debug/warn path, keep going. **Anything else** (422 validation, 401 auth, 403 permission, 5xx transient) → error-level log naming the real cause. Continuing after non-race failure means a guaranteed 404 later at apply time; fail loud so the operator sees the problem now, not on the first pause.

## Regression tests

- **Static (never-regress)**: parameterized test over `WORKFLOW_LABELS` asserting every entry has `description.length <= 100`. Failing this test blocks merge.
- **Provisioning**: 422 validation-failure fixture → error-level log containing `"description is too long"` (or generalized: the raw stderr/body) and **not** the "(non-fatal, may already exist)" text; already-exists fixture → warn/debug continue path unchanged.
- **Apply-path**: applying a label that failed provisioning (fixture: `blocked:stuck-*` missing on the repo, `addLabels` returns 404) surfaces the provisioning failure lineage in the error, not a bare 404. Depending on chosen fix depth (see FR-006), this may be an error thrown from the ensure-pass or a structured log message referencing the earlier provisioning failure.

## User Stories

### US1: Provisioning surfaces real failure causes to the operator

**As a** cluster operator watching worker logs during the phase-loop startup,
**I want** label-provisioning failures to be logged with their actual cause (not a generic "may already exist" line),
**So that** I can distinguish a benign create-race from a validation/auth/permission failure that will strand a workflow later — and act before the first `waiting-for:` or `blocked:stuck-*` label apply 404s the run.

**Acceptance Criteria**:
- [ ] A 422 validation-failure on `github.createLabel` in `ensureRepoLabelsExist` produces an **error-level** log entry whose message names the actual failure (e.g. contains `description is too long`, `HTTP 422`, or the raw stderr), not the "(non-fatal, may already exist)" text.
- [ ] A create-race (`already exists`) failure produces a **debug-level** log entry (Q5 → B) that keeps the benign-race semantics and does not appear at warn+ on healthy repos.
- [ ] The classification is stable across the two `createLabel` code paths (`gh-cli.ts:938-943` and `gh-cli.ts:1354-1358`) — both surface stderr containing `already exists` for the race and something else for the validation failure.

### US2: The three `blocked:stuck-*` labels are actually provisioned

**As a** cluster worker running the phase loop,
**I want** every entry in `WORKFLOW_LABELS` to successfully provision on a fresh repo,
**So that** the label protocol's pause primitives (`blocked:stuck-feedback-loop`, `blocked:stuck-validate-fix`, `blocked:stuck-merge-conflicts`) are available the first time a handler needs to apply one, matching the #889 fix's contract for `waiting-for:*`.

**Acceptance Criteria**:
- [ ] Descriptions on the three `blocked:stuck-*` entries in `packages/workflow-engine/src/actions/github/label-definitions.ts` are ≤100 characters.
- [ ] A static unit test parameterized over `WORKFLOW_LABELS` asserts `label.description.length <= 100` for every entry; adding a future entry that violates the limit breaks this test.
- [ ] On a fresh App-auth cluster fixture (mirroring snappoll), `ensureRepoLabelsExist` completes without a single 422 validation error against `WORKFLOW_LABELS`.

### US3: A worker that fails to provision fails visibly, not silently

**As a** cluster worker handling a phase completion,
**I want** a non-race provisioning failure to be visible via the log surface at minimum — and ideally via a persistent runtime signal — so the operator does not have to grep worker logs to discover that a `blocked:stuck-*` label was never created.

**Acceptance Criteria**:
- [ ] Non-race provisioning failures produce an error-level log with structured fields (`label`, `owner`, `repo`, `err`, and — where extractable — the GitHub error code / HTTP status).
- [ ] The label-manager's memoization key (`ensuredRepos` / `ensureInFlight`) does not mark a repo "ensured" if any label failed for a non-race reason, so a subsequent worker on the same process gets another chance rather than a permanent silent-failed cache.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Shorten `blocked:stuck-feedback-loop`, `blocked:stuck-validate-fix`, and `blocked:stuck-merge-conflicts` descriptions in `packages/workflow-engine/src/actions/github/label-definitions.ts` to ≤100 characters each. Concrete replacements (Q4 → A): `blocked:stuck-feedback-loop` = `PR-feedback loop paused: last cycle could not advance the trigger. Remove to retry.`; `blocked:stuck-validate-fix` = `Validate-fix paused (#892): duplicate evidence, no-diff, or sibling overlap. Remove to retry.`; `blocked:stuck-merge-conflicts` = `Merge-conflict resolver (#898) exhausted its one autonomous attempt. Remove to retry.` | P1 | Descriptions are informational — no code parses them. Shape: terse cause + `Remove to retry` directive + `#892`/`#898` refs where applicable. |
| FR-002 | Add a static parameterized unit test in the workflow-engine package asserting every entry of `WORKFLOW_LABELS` has `label.description.length <= 100`. Test lives in the same package as the definitions so a future add is caught at merge time. | P1 | Makes this class of defect never-regress. |
| FR-003 | Rewrite the catch in `ensureRepoLabelsExist` (`packages/orchestrator/src/worker/label-manager.ts:333-345`) to **classify** the caught error via the shared `classifyLabelProvisioningError` helper (see FR-004). Race branch (match on `/already[ _]exists/i`) → `this.logger.debug` (Q5 → B — the only warn+ emission from this catch is a real classified failure); no throw; ensure-pass continues and populates `ensuredRepos` normally. Non-race branch → `this.logger.error` with a message naming the actual failure cause (e.g. `'Failed to create workflow label (provisioning error)'`) and structured fields (`err`, `statusCode?`, `label`, `owner`, `repo`). Non-race entry is also recorded in the lineage map (see FR-008). | P1 | Rewrite must not throw from `ensureRepoLabelsExist` — the outer `addLabels` still has to run in the create-race case. Non-race errors are logged loud but not thrown. |
| FR-004 | Extract the race-vs-error classification into a shared helper `classifyLabelProvisioningError(err)` in `packages/workflow-engine/src/actions/github/` (returns `{ kind: 'already-exists' } \| { kind: 'error', cause: string, statusCode?: number }`). Both `LabelManager.ensureRepoLabelsExist` and `LabelSyncService.syncRepo` (`packages/orchestrator/src/services/label-sync-service.ts:75-107`) call the helper on caught `createLabel` errors and dispatch accordingly. `LabelSyncService`'s outer `try/catch` at line 103 is replaced by a per-label try/catch inside the loop: race → continue silently; classified error → log error + set `success: false` on the returned result (still surfaces failure to its caller). | P1 | Q1 → A. One classification, one home, both consumers. Prevents provisioning-surface drift (this very bug's shape). |
| FR-005 | The `ensuredRepos` memoization set is only populated when **every** `createLabel` in the pass either succeeded or failed with an `already_exists` classification. Any error-classified failure leaves the repo unmarked, so the next call re-attempts provisioning. The shared in-flight Promise in `ensureInFlight` **resolves normally** (does not reject) even when the pass records a non-race failure (Q3 → A) — concurrent callers await success as today; the retry is driven by the next non-concurrent call finding the repo still unmarked. Rejecting the shared Promise would convert one optional label's 422 into failures for every concurrent phase run, an outage worse than the observed bug; loudness belongs in FR-003's error log and FR-008's lineage map. Rationale: a silent-failed cache turns a transient bug (rate limit, brief permission drift) into a permanent worker-lifetime dead-end. | P1 | Behavioral change; add a regression fixture. |
| FR-006 | Regression test: on the snappoll-shaped fixture (three-label 422 injected on `createLabel`), verify (a) the ensure-pass emits three **error**-level logs whose messages contain the actual failure cause and **not** the "may already exist" substring, (b) the outer `addLabels` still runs, (c) `ensuredRepos` does not include the repo after the pass, (d) a subsequent `onPhaseComplete` retries provisioning on the same worker, (e) the lineage map (FR-008) contains one entry per failed label, (f) applying `blocked:stuck-feedback-loop` after the failed pass produces an error whose message includes the provisioning cause. Race fixture (injected `already exists`) verifies (g) **debug**-level log, no warn+, no error, `ensuredRepos` populated. | P1 | This is the anti-swallowing regression test — deleting the classification makes it fail. |
| FR-007 | Preserve the existing benign-race behavior end-to-end: an `already exists` classification produces a **debug** log (Q5 → B, tightened from the earlier "warn/debug"), does not throw, does not delay `addLabels`, and does populate `ensuredRepos`. Existing test at `packages/orchestrator/src/worker/__tests__/label-manager.ensure.test.ts:104-124` is updated to assert the debug-level log and the classification-branch message (was warn+`expect.stringContaining('Failed to create workflow label')`). | P1 | Backwards-compatible for the healthy path. Log-level narrowing is intentional: healthy multi-worker startup races on every boot; debug keeps it out of default operator dashboards. |
| FR-008 | `LabelManager` maintains an in-memory lineage map: `Map<string, Map<string, ProvisioningError>>` keyed by `${owner}/${repo}` → `labelName` → the classified error recorded by FR-003's non-race branch. On `addLabels`, when the underlying API returns 404 for a label that appears in `WORKFLOW_LABELS`, the lineage-map entry (if present) is spliced into the thrown error's message so the operator (or auto session) reading the apply-time failure sees the provisioning cause inline. Map entries are cleared alongside FR-005's `ensuredRepos` invalidation (same lifecycle). FR-003's classified error log is the always-there floor: cross-process gaps (ensure-pass ran in a different process) degrade gracefully to the raw 404 plus the log. | P1 | Q2 → B. Implementation is a small addition — one map field on `LabelManager`, one write in the non-race branch, one lookup in `addLabels`. No new error class. |
| FR-009 | Ship as a single atomic PR: (i) three shortened descriptions with Q4 → A wording, (ii) static description-length test, (iii) shared `classifyLabelProvisioningError` helper, (iv) classification rewrite in `ensureRepoLabelsExist` with FR-003 log levels, (v) `LabelSyncService.syncRepo` per-label loop consuming the same helper (FR-004), (vi) memoization-cache change (FR-005) with normal-resolve semantics for the shared in-flight Promise, (vii) lineage map + `addLabels` enrichment (FR-008), (viii) regression fixture (FR-006), (ix) preserved race behavior (FR-007). | P1 | All Q1–Q5 decisions land in this PR. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | All `WORKFLOW_LABELS` provision successfully on a fresh repo | Zero 422 responses across the `WORKFLOW_LABELS` set on a fresh App-auth fixture | Fixture: mock `createLabel` to real GitHub-shape validation (reject description >100 chars); ensure-pass over all `WORKFLOW_LABELS` returns zero errors. |
| SC-002 | Static description-length test never regresses | 100% of `WORKFLOW_LABELS` entries have `description.length <= 100` | Parameterized test in the workflow-engine package; adding a >100-char description to `WORKFLOW_LABELS` breaks CI. |
| SC-003 | Non-race provisioning failures are visible at error level | Error-level log on 422/401/403/5xx from `createLabel`; substring match on the actual failure cause (not "may already exist") | Log-capture assertion on the regression fixture (FR-006). |
| SC-004 | Race provisioning failures remain benign | **Debug**-level log on `already exists` (Q5 → B, no longer warn); zero warn+ log entries on healthy multi-worker boot; ensure-pass completes; `addLabels` runs | Existing race fixture at `label-manager.ensure.test.ts:104-124` updated to assert debug level and race-branch message. |
| SC-005 | Ensure-pass cache is not poisoned by non-race failures | After a classified error, `ensuredRepos` does not contain the repo; a subsequent `onPhaseComplete` on the same worker re-attempts provisioning | Fixture: first ensure-pass fails one label with 422; assert second call runs `listLabels` + `createLabel` again. |
| SC-006 | Snappoll-shaped run no longer surfaces the three lying log lines | Zero "(non-fatal, may already exist)" log entries paired with 422 stderr in a full phase-loop startup on a fresh repo | Log audit on end-to-end fixture. |
| SC-007 | Apply-time 404 for `blocked:stuck-*` is either eliminated (labels exist) or traceable (error surfaces provisioning cause) | Given a healthy provisioning pass, `addLabels('blocked:stuck-feedback-loop')` succeeds; given an injected provisioning failure in the same process, the resulting `addLabels` error message contains the provisioning cause substring (via the FR-008 lineage map); across processes (map miss), the error is the raw 404 and FR-003's classified log is the trace surface | Three-fixture assertion (happy path, same-process 404, cross-process 404). |

## Assumptions

- GitHub's 100-char description limit is stable and applies uniformly to `createLabel` — the observed 422 message ("`description is too long (maximum is 100 characters)`") is the authoritative constraint. Shortening the three offending descriptions is sufficient; no other `WORKFLOW_LABELS` entry currently exceeds 100 chars (verified by inspection).
- Both `createLabel` code paths in `gh-cli.ts` (`938-943` and `1354-1358`) surface the underlying stderr in the thrown `Error.message`, so the classification helper can pattern-match on the exception's message rather than needing structured error objects.
- The `already exists` substring is the canonical race signal in both `gh label create` CLI stderr and GitHub REST API 422 `errors[0].code`. If a future GitHub CLI version drops this substring, the classification helper needs updating — but no such change is scheduled.
- `LabelSyncService.syncRepo` and `LabelManager.ensureRepoLabelsExist` are the only two provisioning paths for `WORKFLOW_LABELS` in-cluster. `LabelSyncService` runs once at boot per repo; `ensureRepoLabelsExist` runs per-worker per phase completion. Both share `WORKFLOW_LABELS` as the source of truth.
- FR-005's cache-invalidation-on-failure change does not create a hot-loop: `ensureRepoLabelsExist` is only invoked from `onPhaseComplete`, and each phase-completion is bounded by workflow progression, not by wall-clock ticks. Worst case: one wasted `listLabels` + `createLabel` per phase completion until the underlying failure is fixed — acceptable in exchange for self-healing behavior.

## Out of Scope

- Migrating the label-definitions file itself out of `packages/workflow-engine/src/actions/github/` — the file location is fine; only descriptions change.
- Redesigning the `LabelManager.ensureRepoLabelsExist` memoization semantics beyond FR-005's fail-invalidation rule (e.g. TTL, per-label caching, or moving the state to Redis) — kept in-process as today.
- Adding new label protocol vocabulary (`blocked:stuck-*` or otherwise) — this PR shortens existing descriptions, does not add or remove labels.
- Merging `LabelSyncService` and `LabelManager` into a single service — FR-004 shares the classification helper across both, but the two provisioning surfaces (one-time boot sync vs. per-phase ensure) remain distinct. Merging them is deferred.
- Any changes to the `waiting-for:*` provisioning path — #889's fix stands.
- Any changes to the `gh label create` CLI invocation itself in `gh-cli.ts` — the two paths already surface stderr in thrown errors, which is all classification needs.

---

*Generated by speckit*
