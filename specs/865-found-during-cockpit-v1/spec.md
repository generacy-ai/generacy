# Feature Specification: Failure evidence posts a new bottom-of-thread comment so notifications and timeline surface the failure

**Branch**: `865-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft
**Source**: [generacy-ai/generacy#865](https://github.com/generacy-ai/generacy/issues/865) — cockpit v1 integration smoke test finding #29. Follow-up to [#847](https://github.com/generacy-ai/generacy/issues/847).

## Summary

The #847 failure-evidence block works end-to-end — but nobody sees it. `StageCommentManager.updateStageComment` renders the evidence by editing the existing stage comment *in place*. That comment was posted when the workflow started (hours earlier, mid-thread). An in-place edit generates **no GitHub notification** and produces **no new activity at the bottom of the thread**. Shipped-but-buried is operationally the same as missing.

**Observed:** `christrudelpw/sniplink#3` failed validate at `2026-07-08T20:59Z`. The evidence block rendered exactly as specified in #847 (failed command, `exit 1`, stderr tail with `npm error Missing script: "test"`) — but *inside* a stage comment posted at `02:27Z`, eleven comments up-thread. The developer watching the issue live concluded "validate failed and I'm not sure why" and went to the container logs. The answer had been on the issue the whole time.

**Fix:** On the *transition into* `status: 'error'` (not on every poll — one comment per failure occurrence), also post a **new** comment at the bottom of the thread carrying the same evidence block. The new comment is what triggers notifications and appears in the timeline; the stage comment remains the canonical state table (and keeps its evidence block too — a `buildErrorEvidence` output is a small, bounded string, so duplicating it is cheap and preserves standalone readability).

The `buildErrorEvidence` output from #847 already contains everything needed — this is a **second consumer** of the same derived payload, not new derivation. Scope is limited to the "post a fresh comment" side; #847's stage-comment behavior is unchanged.

## User Stories

### US1 — Developer watching a live workflow sees a notification when a phase fails

**As a** developer subscribed to a GitHub issue running through speckit,
**I want** a phase failure to trigger a GitHub notification and a new comment at the bottom of the timeline,
**So that** I learn about the failure in real time (email/inbox/mobile push) instead of only via the cockpit dashboard, and I do not have to scroll eleven comments up to find the diagnostic that was rendered by an in-place edit.

**Acceptance Criteria**:
- [ ] When a phase transitions into `status: 'error'`, a new issue comment is posted at the bottom of the thread carrying the same failing-command / exit-descriptor / stderr-tail block that the stage comment renders.
- [ ] The new comment fires the usual GitHub notification/email path (in-place edits do not; a fresh `POST /repos/:owner/:repo/issues/:issue/comments` does).
- [ ] The new comment carries a distinct HTML marker so it can be recognized as a bot-authored failure alert (parallel to `STAGE_MARKERS` for stage comments) — enables de-duplication and cockpit-side identification.

### US2 — Repeated polls / duplicate error transitions do not spam the thread

**As a** developer whose workflow is being polled repeatedly by the worker,
**I want** exactly one failure-alert comment per failure occurrence,
**So that** a stuck error state (or repeated `updateStageComment` calls on the same failure) does not fill the thread with duplicate alerts.

**Acceptance Criteria**:
- [ ] Two back-to-back `updateStageComment({ status: 'error', errorEvidence })` calls for the same failure occurrence produce exactly one bottom-of-thread comment, not two.
- [ ] A *new* failure occurrence (e.g. a retry that fails, or a subsequent phase that fails after a resume) produces a new comment — one comment per occurrence, not one per issue.
- [ ] The de-duplication key is derived from the current phase's error transition, not from the evidence content (so re-running the same phase with the same stderr still emits a fresh alert on the next occurrence).

### US3 — Cockpit `failed:*` classification still works

**As a** cockpit user relying on the `failed:<phase>` classification,
**I want** the existing cockpit pipeline to continue detecting failures with no regression,
**So that** the new comment is purely additive — the stage comment remains the canonical surface the cockpit reads.

**Acceptance Criteria**:
- [ ] The stage comment continues to receive the evidence block (canonical state, per #847). No bytes above `---` change in the stage comment.
- [ ] The cockpit's existing parse path (which reads the stage comment, not the timeline) is unchanged.
- [ ] Successful phase completions do NOT gain a bottom-of-thread comment — the alert surface is exclusively for `status: 'error'` transitions.

## Clarifications

### Session 2026-07-08 — deferred to `/speckit:clarify`

These are the questions the spec-author flagged as needing user input before `/speckit:plan`. Provisional answers below are best-guess directions; `/speckit:clarify` should confirm or correct.

- **Q1 — Provenance of "one comment per occurrence"**. What counts as a distinct failure occurrence?
  - **(A)** Per phase-loop invocation (one alert per `runPhaseLoop` call that reaches a failure site).
  - **(B)** Per phase name within an invocation (validate error alert distinct from implement error alert, even in one run).
  - **(C)** Per `updateStageComment({ status: 'error' })` call. Naive but simplest.
  - Provisional: **(A)**. A single worker run is the atomic "occurrence"; multi-phase failures are rare and can share one alert. Aligns with the issue body's "one comment per failure occurrence."

- **Q2 — De-duplication mechanism**. How does the code know it has already posted an alert for this occurrence?
  - **(A)** Search issue comments for a HTML marker (parallel to `STAGE_MARKERS` lookup in `findOrCreateStageComment`). Cost: one `getIssueComments` per error transition; state lives on GitHub.
  - **(B)** In-process memoization (a Set in `PhaseLoop`). Faster, but does not survive worker restarts mid-run.
  - **(C)** A dedicated `phase-tracker`-style Redis key. Consistent with the `phase-tracker:*` pattern used elsewhere (see #849).
  - Provisional: **(A)** for parity with `StageCommentManager.findOrCreateStageComment` — simplest, no new infra.

- **Q3 — Content: full evidence vs. pointer**. Duplicate the evidence in the new comment, or link back to the stage comment?
  - **(A)** Duplicate the full evidence block (issue body's recommended option). Slight duplication; best standalone readability; email/mobile readers see the evidence without a click.
  - **(B)** Pointer only: one-line summary + link to the stage comment. No duplication; requires a click; comment anchors on edited comments are fiddly on mobile/email.
  - Provisional: **(A)**. Evidence is small by construction (bounded ≤ 4 KiB per #847 FR-004). Standalone readability wins.

- **Q4 — Failure-comment marker semantics**. The stage comment has one marker per `StageType` (`STAGE_MARKERS[stage]`). What identifies the new failure-alert comment?
  - **(A)** One marker per (stage, phase-loop invocation) — e.g. `<!-- generacy:failure-alert:<stage>:<runId> -->`. Requires a stable run ID.
  - **(B)** One marker per stage (`<!-- generacy:failure-alert:<stage> -->`), overwritten by the next occurrence via edit. But the point of this fix is to trigger notifications — overwriting via edit defeats it.
  - **(C)** One marker per failure occurrence, with a monotonic counter or timestamp — a new comment for every occurrence. Content-addressed via marker + timestamp.
  - Provisional: **(C)**. Each occurrence gets its own bottom-of-thread comment (fires a fresh notification); the marker includes a timestamp so old alerts remain identifiable but do not block new posts.

- **Q5 — What about implement retries?** #847 already emits an evidence block for implement retries that DO fail terminally (after `maxImplementRetries`). Do intermediate implement-retry failures (that will be retried) also emit a bottom-of-thread alert?
  - **(A)** Only terminal failures emit a bottom-of-thread alert. Intermediate retries stay silent (cockpit-friendly; no thread noise).
  - **(B)** Every failure occurrence, including transient retries, emits an alert. Loud but accurate.
  - Provisional: **(A)**. Intermediate retries already surface in the stage comment as in-progress updates; the point of this fix is to notify on *actionable* failures.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                            | Priority | Notes                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| FR-001 | On the transition into `status: 'error'`, in addition to updating the stage comment (per #847), a *new* comment MUST be posted at the bottom of the issue thread. The new comment MUST be created via a fresh `POST` (not `PATCH`/edit) so GitHub fires notification and the comment appears in the activity timeline. | P0       | Root cause: in-place edits are silent |
| FR-002 | The new comment MUST carry the same failing command, exit descriptor, and stderr tail rendered inside the stage comment. It MUST reuse the `buildErrorEvidence` output from #847 verbatim (second consumer, not new derivation). | P0       | Recommended option (a) from the issue body |
| FR-003 | The new comment MUST carry an HTML marker uniquely identifying it as a bot-authored failure alert (e.g. `<!-- generacy:failure-alert:<stage>:<occurrence-id> -->`). Marker format resolved in Q4. | P0       | Parity with `STAGE_MARKERS`; enables identification |
| FR-004 | Exactly one failure-alert comment MUST be posted per failure occurrence. Duplicate calls to `updateStageComment({ status: 'error' })` for the same occurrence MUST NOT post duplicate alerts. Definition of "occurrence" resolved in Q1; de-duplication mechanism resolved in Q2. | P0       | Prevents spam on repeated polls |
| FR-005 | A subsequent, distinct failure occurrence (e.g. a retry that also fails, a later phase that fails after a resume) MUST post a new alert. This is what fires the notification the developer needs. | P0       | Complement to FR-004 |
| FR-006 | The stage comment MUST continue to render the evidence block per #847. Bytes inside the stage comment are unchanged relative to #847's output. | P0       | Canonical-state invariant preserved |
| FR-007 | Successful phase completions MUST NOT gain a bottom-of-thread alert comment. The alert surface is exclusively for `status: 'error'` transitions. | P1       | Keep the timeline noise-free |
| FR-008 | The cockpit's `failed:*` classification (which reads the stage comment, not the timeline) MUST NOT regress. No changes to cockpit code are required. | P0       | Additive-only fix |
| FR-009 | Intermediate implement-phase retry failures MUST NOT emit bottom-of-thread alerts. Only failures that reach the *terminal* `updateStageComment({ status: 'error' })` site emit alerts. Resolved in Q5. | P1       | Aligns with "actionable failure" semantics |
| FR-010 | Failure to post the alert comment (e.g. GitHub API 5xx) MUST NOT block the phase-loop error path. The alert is best-effort: on posting failure, log a `warn` and return the same `{ completed: false, gateHit: false }` result the error path already returns. The stage comment update remains the load-bearing surface. | P1       | Defense in depth — the stage comment is still updated first |

## Success Criteria

| ID     | Metric                                                                                     | Target                                        | Measurement                                                                     |
| ------ | ------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------- |
| SC-001 | Bottom-of-thread failure alert fires on the transition into `status: 'error'`              | 100% of terminal error transitions             | Repro on a failing validate against `christrudelpw/sniplink` (or synthetic repo); assert a new comment appears after the failure |
| SC-002 | GitHub notification fires on the failure                                                   | 100% (subscribers receive email/notification) | Manual verification: subscribe to a test issue, cause a failure, observe notification arrival |
| SC-003 | No duplicate alerts posted for repeated error updates within one occurrence                | ≤ 1 alert per occurrence                      | Test: call `updateStageComment({ status: 'error' })` twice back-to-back; assert one comment posted |
| SC-004 | New occurrences (retry-then-fail, subsequent-phase-failure) do post fresh alerts           | 100% of distinct occurrences                  | Test: simulate two failure occurrences in one issue; assert two alert comments  |
| SC-005 | Stage comment output is byte-identical to #847                                              | 0 regressions                                 | Existing `stage-comment-manager.test.ts` unchanged; snapshot-diff against #847 fixture |
| SC-006 | Cockpit `failed:*` classification continues to work                                         | 0 regressions                                 | Run cockpit `watch` / `status` against a failed issue; assert `failed:validate` classification detected |
| SC-007 | Alert-comment posting failure does not block the error path                                | 100% of API failures degrade gracefully       | Test: mock `github.addIssueComment` to reject; assert phase-loop returns normally and stage comment is still updated |

## Assumptions

- The GitHub App token wired into `StageCommentManager` (and the new alert-posting path) already has `issues: write` on target repos. No new scope required.
- #847 has landed. `PhaseResult.error` carries the derived evidence and `buildErrorEvidence` produces the bounded payload (≤ 4 KiB / 30 lines). This spec depends on #847's byte layout being stable.
- GitHub's notification behavior differs meaningfully between `POST /issues/:num/comments` (fires notification, appears in timeline, sends email to subscribers) and `PATCH /issues/comments/:id` (silent update, does not fire notification, does not appear in timeline). This is the observable difference driving the whole fix.
- Cockpit code reads the stage comment (via `STAGE_MARKERS` lookup) and does not depend on the timeline order of comments. Additive bottom-of-thread comments will not confuse the classifier.
- The developer-experience win — a real notification instead of a silent edit — is worth the ~1 extra comment per failure. This is a trust/observability tradeoff, not a bug fix per se.
- Existing `error-transition` sites in `phase-loop.ts` (four sites: pre-validate install failure, unexpected spawn error, implement-increment no-progress, post-phase failure) are the ones that need to fire the alert. The `no-progress` site (line ~278) does NOT carry `errorEvidence` today — it may need one, or may be intentionally silent (see Q5 spillover).

## Out of Scope

- Any change to #847's stage-comment rendering. Bytes inside the stage comment are unchanged.
- Any change to `buildErrorEvidence` in `phase-loop.ts`. The derivation is reused as-is.
- Cockpit code changes. The cockpit classifier reads the stage comment; the new alert comment is invisible to it (and intentionally so — the cockpit doesn't need to see two surfaces for the same event).
- Notification-preference UX. Developers already control subscription preferences via GitHub; this fix simply respects the existing preference by posting a real comment.
- Comment-format tuning beyond the minimal alert body (title line + evidence block). Rich embeds, action buttons, and CTAs are follow-ups.
- Retroactive alerts for issues that failed *before* this fix ships. Only new failure transitions get alerts.
- The intermediate implement-retry surface (currently silent per #847 default). If Q5 resolves to "alert on every occurrence including transient retries," that becomes an in-scope requirement.

---

*Generated by speckit*
