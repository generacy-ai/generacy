# Clarifications: Failure evidence posts a new bottom-of-thread comment

**Issue**: [generacy-ai/generacy#865](https://github.com/generacy-ai/generacy/issues/865)
**Branch**: `865-found-during-cockpit-v1`

---

## Batch 1 — 2026-07-08

### Q1: Occurrence granularity
**Context**: FR-004 says "exactly one failure-alert comment per failure occurrence." The de-duplication key (Q2) and the alert-comment marker format (Q4) both hinge on what an "occurrence" *is*. Same issue over its lifetime may see many failures — retry-then-fail, subsequent-phase failure after resume, or a re-trigger after `waiting-for:developer`. We need one bright line.
**Question**: What counts as a distinct failure occurrence — the unit that gets exactly one alert comment?
**Options**:
- A: Per phase-loop invocation. One alert per `runPhaseLoop` call that reaches a failure site. Multi-phase failures within one run share a single alert. (Provisional pick — aligns with issue body's "one comment per failure occurrence.")
- B: Per phase name within an invocation. A validate-error alert is distinct from an implement-error alert even inside one run. Rare but possible if the loop swallows an error and continues.
- C: Per `updateStageComment({ status: 'error' })` call. Simplest, but requires FR-004's de-duplication to actively suppress spam from repeated polls.

**Answer**: *Pending*

---

### Q2: De-duplication mechanism
**Context**: FR-004 requires suppressing duplicate alerts on repeated `updateStageComment({ status: 'error' })` calls for the same occurrence. The mechanism determines where state lives (GitHub / process / Redis), what happens on worker restart mid-run, and what the failure mode is when de-dup breaks.
**Question**: How does the alert-posting code know it has already posted an alert for the current occurrence?
**Options**:
- A: Search issue comments for the HTML marker (mirror of `findOrCreateStageComment`'s `STAGE_MARKERS` lookup). One `getIssueComments` call per error transition; state lives on GitHub. Survives worker restarts. (Provisional pick — parity with existing pattern, no new infra.)
- B: In-process `Set` in `PhaseLoop`. Zero API cost; does not survive worker restarts mid-run (a restart during the error path could re-post).
- C: Dedicated `phase-tracker`-style Redis key (consistent with the `phase-tracker:*` pattern used in #849's paired resume-dedupe clear). Consistent with cluster-side observability tooling; adds a small new key.

**Answer**: *Pending*

---

### Q3: Alert-comment content — full evidence vs. pointer
**Context**: The stage comment already carries the evidence block (per #847). The bottom-of-thread alert is a *second* consumer. It can either duplicate the payload (best mobile/email readability, ~4 KiB of duplication) or point back to the stage comment (fiddly comment-anchor UX on GitHub mobile/email clients, but no duplication).
**Question**: What does the new alert comment contain?
**Options**:
- A: The full failing-command / exit-descriptor / stderr-tail block (verbatim reuse of `buildErrorEvidence` output from #847). Standalone readability; email/mobile subscribers see the diagnostic without a click. Bounded ≤ 4 KiB per #847 FR-004. (Provisional pick — issue body's recommended option.)
- B: One-line summary + link to the stage comment ("Validate failed — see stage comment for evidence"). No duplication; requires a click to see the diagnostic.
- C: Short summary line + collapsible `<details>` block containing the full evidence. Compromise: readable on the timeline without dominating it, still standalone-readable when expanded.

**Answer**: *Pending*

---

### Q4: Failure-alert-comment HTML marker
**Context**: FR-003 requires a unique HTML marker on the alert comment (parallel to `STAGE_MARKERS`) for de-duplication (Q2 option A) and cockpit-side identification. The marker's shape decides whether an existing alert *blocks* a new one (edit-in-place — but edits are silent, defeating the fix) or whether each occurrence gets a distinct marker so a fresh POST always fires a notification.
**Question**: What is the marker format for failure-alert comments?
**Options**:
- A: One marker per (stage, phase-loop invocation) — `<!-- generacy:failure-alert:<stage>:<runId> -->`. Requires a stable `runId` threaded from `runPhaseLoop`.
- B: One marker per stage — `<!-- generacy:failure-alert:<stage> -->`. The next occurrence would need to *edit* the existing marker-bearing comment, which defeats the fix (edits are silent).
- C: One marker per occurrence, with a monotonic component — `<!-- generacy:failure-alert:<stage>:<iso-timestamp> -->`. Each occurrence gets a distinct marker so a fresh POST always fires a notification. Older alerts remain identifiable but do not block new posts. (Provisional pick — matches the fix's intent.)

**Answer**: *Pending*

---

### Q5: Intermediate implement-retry failures — alert or silent?
**Context**: #847 emits an evidence block for implement retries that fail *terminally* (after `maxImplementRetries`). Intermediate retries (the ones that will be retried) may or may not surface the evidence to the stage comment today. The alert-comment surface has a corresponding choice: notify on every failure, or only on the actionable (terminal) ones.
**Question**: Do intermediate implement-retry failures (that will be automatically retried) emit a bottom-of-thread alert?
**Options**:
- A: Only terminal failures (the ones that would land the workflow in `waiting-for:developer`) emit a bottom-of-thread alert. Intermediate retries stay silent. Cockpit-friendly; no thread noise. (Provisional pick — the fix targets *actionable* failure surfaces.)
- B: Every failure occurrence, including transient retries, emits an alert. Louder but strictly accurate — subscribers see every failure, even the ones the worker will self-heal.
- C: Only terminal failures alert, AND the "no-progress" site at `phase-loop.ts:~278` also gets an evidence block (currently missing per the Assumptions section) so that terminal alerts always carry a diagnostic. Slightly larger scope; closes the assumptions-section gap.

**Answer**: *Pending*
