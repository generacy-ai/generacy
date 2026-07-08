# Feature Specification: Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #29

**Branch**: `865-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #29. Follow-up to #847.

**The #847 failure-evidence block works, but nobody sees it.** `StageCommentManager` renders the evidence by editing the existing stage comment in place. That comment was posted when the workflow started — hours earlier, mid-thread. An in-place edit generates no GitHub notification and no new activity at the bottom of the thread.

## Observed

christrudelpw/sniplink#3 failed validate at 2026-07-08T20:59Z. The evidence block rendered exactly as specified (failed command, `exit 1`, stderr tail with `npm error Missing script: "test"`) — inside a stage comment posted at 02:27Z, eleven comments up-thread. The developer watching the issue live concluded "validate failed and I'm not sure why" and went to the container logs; the answer had been on the issue the whole time. Shipped-but-buried is operationally the same as missing.

## Proposal

On the transition into `status: 'error'` (not on every poll — one comment per failure occurrence), **also post a short new comment** at the bottom of the thread:

> ❌ **validate failed** — `npm test && npm run build` exited 1.
>
> <details><summary>stderr (last N lines)</summary>… </details>

Options for how the two surfaces split:
- **(a) Duplicate the evidence**: new comment carries the full evidence block; stage comment keeps it too (canonical state). Slight duplication, best standalone readability. **Recommended** — the evidence is small by construction (bounded stderr tail).
- (b) Pointer only: new comment is one line linking the stage comment anchor. No duplication, but the reader still has to click through, and comment anchors on edited comments are fiddly on mobile/email.

Either way the new comment is what triggers notifications and shows in the timeline; the stage comment remains the canonical state table. The `buildErrorEvidence` output from #847 already contains everything needed — this is a second consumer, not new derivation.


## User Stories

### US1: Developer watching an issue sees a terminal failure without going to logs

**As a** developer watching an in-flight speckit issue,
**I want** a fresh bottom-of-thread comment when the workflow hits a terminal failure,
**So that** GitHub notifies me and I can see the failing phase, command, and stderr tail without hunting up-thread or diving into container logs.

**Acceptance Criteria**:
- [ ] On the transition into `status: 'error'` for a terminal failure (validate error, terminal implement-retry exhaustion, or the `phase-loop.ts:~278` no-progress site), a new comment is posted at the bottom of the issue thread — not an edit to an existing comment.
- [ ] The comment's summary line names the failing phase, the failing command, and the exit descriptor so email/mobile notification previews carry the diagnosis without a click (e.g., `❌ validate failed — npm test && npm run build exited 1`).
- [ ] The full evidence block (failing command, exit descriptor, bounded stderr tail — verbatim `buildErrorEvidence` output from #847) is included inside a collapsible `<details>` section beneath the summary line.
- [ ] The comment carries the HTML marker `<!-- generacy:failure-alert:<stage>:<runId> -->` for de-duplication and cockpit-side identification.
- [ ] For a single `runPhaseLoop` invocation, at most one failure-alert comment is posted (repeat polls of `updateStageComment({ status: 'error' })` for the same occurrence are silent).
- [ ] Intermediate implement retries (retries the worker will automatically self-heal from) do NOT post an alert.
- [ ] The canonical stage comment continues to render the evidence block in-place; the alert comment is a second consumer, not a replacement.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | On the transition into `status: 'error'` for a terminal failure, post a new comment at the bottom of the issue thread (not an edit). | P1 | Terminal failure = would land the workflow in `waiting-for:developer`. |
| FR-002 | The alert comment MUST include a short summary line naming the failing phase, failing command, and exit descriptor, followed by a `<details>` block containing the full `buildErrorEvidence` output from #847 (verbatim reuse). | P1 | Summary line lets email/mobile previews carry the diagnosis without a click; `<details>` keeps timeline compact. |
| FR-003 | The alert comment MUST carry the HTML marker `<!-- generacy:failure-alert:<stage>:<runId> -->`, where `<stage>` is the failing phase and `<runId>` is a stable token minted at the start of the current `runPhaseLoop` invocation. | P1 | `<runId>` acts as the per-occurrence dedup key (Q4/A). A worker restart mid-run mints a new `runId` and MAY post a fresh alert — acceptable, the phase genuinely re-ran. |
| FR-004 | Before posting, the alert-posting code MUST scan existing issue comments for a marker matching the current `(stage, runId)` (mirror of `findOrCreateStageComment`'s `STAGE_MARKERS` lookup). If one exists, suppress the post. | P1 | State lives on GitHub, survives worker restarts, no new Redis key (avoids the `phase-tracker:*` pattern that #862 is moving away from). |
| FR-005 | Occurrence granularity is per `runPhaseLoop` invocation: exactly one alert per invocation that reaches a terminal-failure site. Multi-phase failures within one invocation share a single alert. | P1 | The loop stops at the first phase failure in practice, so per-invocation and per-phase-within-invocation coincide. |
| FR-006 | Intermediate implement-retry failures (retries the worker will automatically re-attempt within `maxImplementRetries`) MUST NOT post an alert. Only terminal (`maxImplementRetries`-exhausted) failures alert. | P1 | Intermediate retries are not actionable for the developer; the alert surface is reserved for actionable failures. |
| FR-007 | The `phase-loop.ts:~278` "no-progress" site MUST also emit an evidence block (currently missing per prior assumptions) so that terminal alerts from this site carry a diagnostic in their `<details>` block. | P1 | Q5/C — otherwise some terminal alerts fire with nothing to say, which is the shipped-but-useless variant of the bug this spec fixes. |
| FR-008 | The canonical stage comment continues to render the evidence block in-place. The alert comment is a second consumer of the same `buildErrorEvidence` output — no new derivation of evidence content. | P1 | Preserves stage comment as canonical state table; alert comment is purely for notification/timeline surface. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | A developer subscribed to an issue that hits a terminal validate failure receives a GitHub notification that renders the failing phase + command + exit descriptor in the notification preview (email or mobile). | 100% of terminal-failure occurrences trigger the notification. | Manual trigger: run a workflow that will fail validate, confirm the notification arrives and the preview text names the phase and failing command. |
| SC-002 | On a single `runPhaseLoop` invocation that reaches a terminal-failure site, no more than one failure-alert comment appears on the issue, regardless of poll count. | 1 alert comment per invocation. | Count comments carrying the `<!-- generacy:failure-alert:<stage>:<runId> -->` marker after the run completes. |
| SC-003 | The `phase-loop.ts:~278` no-progress site produces an alert comment whose `<details>` block contains a non-empty evidence payload. | Non-empty `<details>` for 100% of no-progress terminal failures. | Trigger the no-progress path in a test/staging run and inspect the alert-comment payload. |
| SC-004 | Intermediate implement retries (retries followed by a successful re-attempt within `maxImplementRetries`) produce zero alert comments. | 0 alerts for intermediate retries. | Trigger a workflow where the first implement attempt fails but the retry succeeds; confirm no failure-alert comment appears. |

## Assumptions

- The `buildErrorEvidence` output from #847 is already available at every terminal-failure site EXCEPT the `phase-loop.ts:~278` no-progress site, which FR-007 addresses.
- A stable per-invocation `runId` can be minted at the start of `runPhaseLoop` and threaded to all terminal-failure sites within that invocation. Implementation may reuse an existing identifier (e.g., a workflow-run correlation ID) if one exists; otherwise a fresh UUID minted on entry is sufficient.
- The `getIssueComments` API cost of one call per error transition (Q2/A) is acceptable — error transitions are rare (per `runPhaseLoop`, not per poll).
- GitHub comment posting is idempotent enough via the marker search; a race where two concurrent workers post alerts for the same `(stage, runId)` is not a concern because a single `runId` corresponds to a single `runPhaseLoop` invocation (single-writer per occurrence).

## Out of Scope

- Alerts for non-terminal (intermediate retry) failures. Explicitly excluded by FR-006.
- Changes to the canonical stage comment's rendering — FR-008 preserves it verbatim.
- Migrating existing `phase-tracker:*` Redis dedup keys. #862 is doing that work separately; this spec does not add new `phase-tracker:*` keys and does not touch existing ones.
- Cockpit-side UI for consuming the new `generacy:failure-alert:*` marker (e.g., surfacing alert history). Marker is defined here for future consumption but no cockpit changes are required by this spec.
- Alerts for successful phase completions or gate transitions (this is a failure-only notification surface).

---

*Generated by speckit*
