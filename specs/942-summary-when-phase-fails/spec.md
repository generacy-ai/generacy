# Feature Specification: Detect repeat-identical phase failures and escalate instead of retrying verbatim

**Branch**: `942-summary-when-phase-fails` | **Date**: 2026-07-15 | **Status**: Draft

## Summary

When a phase fails, the retry path re-runs the exact same phase against the exact same generated artifacts — so a failure caused by a defective upstream artifact fails identically forever. On `christrudelpw/snappoll#8`, `implement` failed three times in a row with the **byte-identical** failure reason, ~10 minutes apart, and only succeeded after the operator hand-implemented the missing components (a ~3-hour intervention) so the fourth run had nothing to do.

Root cause of that particular underlying failure per the postmortem: the generated `tasks.md` for `#8` carried a self-contradictory RTL-testing requirement, so the implement agent kept concluding it could only touch `specs/**` — tripping the `no-product-code-changes` post-exit check every time. The workflow bug this issue tracks is not the bad `tasks.md`; it is the **loop treating an identical repeat failure as if it were fresh**.

## Evidence (christrudelpw/snappoll#8)

Three identical failure alerts on the issue:

- `23:30:57` · `<!-- generacy:failure-alert:implementation:64aabe7b… -->`
- `23:43:34` · `<!-- generacy:failure-alert:implementation:5e6e1169… -->`
- `00:02:30` · `<!-- generacy:failure-alert:implementation:d9b7040d… -->`

All three bodies were identical:

> ❌ **implement failed** — `implement` failed post-exit: no-product-code-changes (process exit 0).
> **Reason**: Phase "implement" produced no product-code changes — all changed files are under excluded prefixes [specs/]. Implement must modify at least one non-excluded file.
> output: (no output on either stream)

Label timeline: `failed:implement` at `23:30:54` → retry → `23:43:31` → requeue (`process:speckit-feature` at `23:51:44`) → `00:02:27` → **3-hour gap (operator hand-implements VoteForm/ResultsChart)** → `03:19:59` `phase:implement` → `03:21:34` `completed:implement` (2 minutes — nothing left to do).

## Mechanism / root cause

Three code facts, taken together, guarantee the loop:

1. **Alert marker is per-run, not per-content.** `postFailureAlert()` in `packages/orchestrator/src/worker/stage-comment-manager.ts:337` writes marker `<!-- generacy:failure-alert:<stage>:<runId> -->` where `runId` is a UUID minted once per phase-loop invocation (`packages/orchestrator/src/worker/phase-loop.ts:173`). Its dedup scan (`stage-comment-manager.ts:340`) only suppresses a second post **within the same run**. Every external retry/requeue gets a fresh `runId`, so a byte-identical failure posts a brand-new comment.
2. **Retry decision reads labels only.** `PhaseResolver.resolveStartPhase()` (`packages/orchestrator/src/worker/phase-resolver.ts:48`) and `LabelManager.onError()`/`onResumeStart()` (`packages/orchestrator/src/worker/label-manager.ts:185, 231`) key entirely on `phase:*` / `completed:*` / `failed:*` / `waiting-for:*` labels. Nothing inspects prior `failure-alert` comments to distinguish "first failure of this phase" from "third verbatim repeat."
3. **In-invocation retry counter is not persisted.** `phase-loop.ts:543-564` maintains an `implementRetryCount` inside a single worker invocation, but every external requeue starts a fresh invocation with the counter reset to zero.

Combined: three verbatim-identical failures ~10 minutes apart carry an unambiguous signal ("retrying will not help; the inputs are wrong"), and the current pipeline is architecturally blind to that signal.

## Suggested fix (from issue #942)

1. **Repeat-failure detection**: fingerprint the failure alert (phase + reason class, or hash of reason text). On the Nth identical failure (issue proposes N=2), stop retrying the phase.
2. **Escalate differently**: route to an artifact-repair path — re-open the *previous* phase (regenerate/repair `tasks.md` with the failure reason as context) or surface a distinct `failed:<phase>-repeated` state so the cockpit can present "repair tasks.md / regenerate plan / skip" instead of "requeue."
3. **Include repeat count in subsequent alerts** so operators (and any cockpit escalation gate) can see "this is attempt 3, identical to attempts 1–2" without diffing comments.

## User Stories

### US1: A byte-identical repeat failure stops the retry loop

**As an** operator running a speckit workflow whose `implement` phase has just failed a second time with a byte-identical reason,
**I want** the workflow to stop auto-retrying `implement` and instead surface a distinct escalation state,
**So that** the run does not waste 30+ minutes and dozens of worker-tokens on retries that cannot possibly succeed against the same upstream artifact.

**Acceptance Criteria**:
- [ ] On the second failure with the same fingerprint (see FR-001), the orchestrator does NOT re-apply the labels that would cause the label-monitor to enqueue another `implement` attempt.
- [ ] Instead, a distinct terminal label (e.g. `failed:<phase>-repeated` — exact spelling per FR-003 clarification) is applied and `agent:in-progress` is removed.
- [ ] The failure alert posted for the second (and any subsequent same-fingerprint) failure includes the repeat count and a link/reference to the prior alerts.

### US2: Operator sees the escalation cleanly from the issue timeline

**As an** operator triaging a stuck issue from the GitHub timeline,
**I want** the third failure alert (if any) to say "attempt 3, identical to attempts 1–2" rather than looking like a fresh independent failure,
**So that** I can diagnose "this is a bad `tasks.md`, not a flaky agent" without diffing three comment bodies by eye.

**Acceptance Criteria**:
- [ ] The alert body carries the attempt count (e.g. "attempt 2 of same failure" or "identical to prior N attempts").
- [ ] The marker or body references the prior alerts (comment IDs, timestamps, or the shared fingerprint) so the causal chain is machine-discoverable.

### US3: Cockpit / auto-mode has a hook to route the escalation

**As** the cockpit auto-mode driver (or a human operator on `cockpit auto`),
**I want** the escalated `failed:<phase>-repeated` state to be a distinct signal from an ordinary `failed:<phase>`,
**So that** auto-mode can route to a repair path (re-open the preceding phase with the failure reason as context) instead of blindly requeueing.

**Acceptance Criteria**:
- [ ] The escalation label is visible on the issue and distinguishable from ordinary `failed:<phase>` by string equality (no substring matches).
- [ ] The label transition is idempotent: a fourth same-fingerprint attempt does not somehow un-escalate.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The orchestrator MUST compute a stable "failure fingerprint" for each phase failure, derived from `{ phase, reason-classifier-string }` (or an equivalent tuple that is deterministic across worker invocations for the same underlying defect). The fingerprint MUST NOT include the per-invocation `runId`, timestamps, or any other value that changes across otherwise-identical failures. | P1 | Fingerprint granularity (reason-classifier vs. full-reason-hash vs. phase+classifier+outputTail) is a clarification item — see [NEEDS CLARIFICATION: FR-001 fingerprint definition]. |
| FR-002 | The orchestrator MUST detect when the current failure's fingerprint matches the fingerprint of one or more prior failure alerts on the same issue. Detection MUST use a persisted signal (either the alert-comment history on the issue, or a new persistent store) — reliance on in-memory per-invocation state is explicitly disallowed because every external requeue starts a fresh invocation. | P1 | The alert-comment history is the natural persistence layer (already tamper-visible on the issue timeline) but see [NEEDS CLARIFICATION: FR-002 persistence mechanism]. |
| FR-003 | On the Nth same-fingerprint failure (N is a threshold — issue proposes N=2), the orchestrator MUST apply a distinct escalation label instead of the normal `failed:<phase>` transition, so downstream automation can route it separately. | P1 | Escalation label spelling (`failed:<phase>-repeated`, `escalation:repeat-failure`, or other) and the exact value of N are clarification items — see [NEEDS CLARIFICATION: FR-003 label + threshold]. |
| FR-004 | Every failure alert MUST include an attempt count for the current fingerprint (e.g. "attempt 2 of same failure") and enough back-reference to prior alerts of the same fingerprint that an operator can find them without diffing comment bodies (e.g. list prior alert comment IDs, or embed the shared fingerprint hex in the marker). | P1 | Alert body currently: `❌ **<phase> failed** — <command> <exitDescriptor>` + `**Reason**: <reason>` + `output: <tail>`. Extension shape TBD in `contracts/`. |
| FR-005 | The escalation MUST NOT interfere with the existing `implementRetryCount` in-invocation retry loop (`phase-loop.ts:543`). That loop is an intra-run optimization for partial-progress; the escalation gate applies to the cross-invocation "same phase re-run from scratch" case. | P2 | Guardrail — don't accidentally suppress the useful partial-progress retry. |
| FR-006 | The escalation MUST be reversible by an operator: clearing the escalation label (manually or via a cockpit verb) MUST return the issue to the normal retry state so the operator can force a re-attempt after fixing the upstream artifact. | P2 | Whether a dedicated cockpit verb ships with this issue or is deferred to a follow-up is a clarification item — see [NEEDS CLARIFICATION: FR-006 cockpit verb scope]. |
| FR-007 | On the first failure (fingerprint not seen before), behavior MUST be unchanged: post an alert, apply `failed:<phase>` + `agent:error`, allow the label-monitor to requeue via existing mechanisms. Escalation only kicks in on the *repeat*. | P1 | Guardrail — a single flaky failure remains a normal `retry` case. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Verbatim repeat failures stop after N attempts | 0 issues receive >N same-fingerprint failure alerts in a rolling 24h window | Grep failure-alert markers on production/dogfood issues; count identical-body sequences |
| SC-002 | Escalation label is applied within one failure-cycle of hitting N | On a repeat-failure issue, the escalation label appears in the label timeline within 60s of the Nth failure alert's timestamp | Manual reproduction: force a repeatable failure (e.g. a `tasks.md` with an impossible constraint), observe label timeline |
| SC-003 | Operator triage time on repeat-failure issues | Median time-to-first-operator-action drops from ~3h (current, per snappoll#8) to <15 min | Compare timeline of first-failure→first-operator-comment across before/after cohort of failed issues |
| SC-004 | Alert readability | 100% of repeat failure alerts include the attempt count and back-reference (FR-004) | Grep of alert bodies for the extension fields |
| SC-005 | No regression on single-failure retries | 100% of single-failure issues still requeue via the existing label-monitor path (FR-007) | Regression test asserting first-failure path is byte-identical to current behavior |

## Regression Tests

| ID | Target | Scenario | Expected |
|----|--------|----------|----------|
| RT-001 | Failure fingerprint computation (FR-001) | Two failures with the same phase + classifier + reason but different `runId`/timestamp | Same fingerprint value |
| RT-002 | Failure fingerprint computation (FR-001) | Two failures with the same phase but different classifier | Different fingerprint values |
| RT-003 | Repeat detection (FR-002) | Second failure on an issue with one prior same-fingerprint alert already posted | Detection returns "repeat, count=2" |
| RT-004 | Escalation label (FR-003) | Nth same-fingerprint failure | Escalation label applied; ordinary `failed:<phase>` NOT applied (or applied plus escalation, per FR-003 clarification) |
| RT-005 | First-failure path (FR-007) | Fingerprint not seen before | Ordinary `failed:<phase>` + `agent:error`; no escalation label |
| RT-006 | Alert extension (FR-004) | Second same-fingerprint failure | Alert body contains attempt count + back-reference to first alert |
| RT-007 | Reversibility (FR-006) | Escalation label manually removed | Next failure of same fingerprint restarts the count from 1 (or resumes — per clarification) |
| RT-008 | In-invocation retry preserved (FR-005) | `implement` failure with partial changes within a single worker invocation | Intra-invocation `implementRetryCount` retry still fires; no escalation until the *next* full invocation also fails identically |

## Assumptions

- The `failure-alert` comments on the GitHub issue are a durable-enough signal to serve as the fingerprint history (they persist across worker restarts, container recreation, and cluster rebuild). If that turns out to be inadequate — for example, if a private/re-created issue could lose the history — an alternative persistent store would be needed (see FR-002 clarification).
- The classifier string (`no-product-code-changes`, etc.) is stable enough across runs to serve as (part of) the fingerprint. It is generated deterministically by post-exit validators in `phase-loop.ts` for the classes of failure that currently exhibit the repeat-loop pathology.
- The intra-invocation `implementRetryCount` (`phase-loop.ts:543`) remains valuable and is out of scope for this fix. This spec addresses only the cross-invocation "external requeue" loop.
- N (the escalation threshold) can be a compile-time constant for the initial ship; making it configurable is deferred.
- The cockpit-side response to the escalation label (auto-repair vs. operator prompt vs. no-op) can be shipped incrementally after the orchestrator-side label is in place. Producing the signal is P1; consuming it is not.

## Out of Scope

- Automatically re-opening the previous phase (regenerating/repairing `tasks.md` with the failure reason as context). This spec produces the escalation *signal* and stops the verbatim retry loop; the auto-repair *action* is a follow-up.
- Cockpit UI/UX to render the escalation state in `cockpit status` output beyond whatever the label naturally surfaces.
- Cross-issue fingerprint learning ("this failure pattern recurred on 5 different issues this week"). Fingerprints are per-issue in v1.
- Reworking the `no-product-code-changes` post-exit check itself, or any other specific classifier. This spec is classifier-agnostic; it addresses the retry loop that magnifies any deterministic classifier failure.
- Introducing a background poller to re-check escalated issues after a cool-off period.
- Configurable N per phase / per workflow. Ships with a single constant; per-workflow overrides are a follow-up if needed.

---

*Generated by speckit*
