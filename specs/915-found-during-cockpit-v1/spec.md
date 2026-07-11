# Feature Specification: Found during the cockpit v1

**Branch**: `915-found-during-cockpit-v1` | **Date**: 2026-07-11 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #55 — snappoll full-epic run. Same evidence family as #890 (stderr-only evidence).

## Observed

snappoll#3's implement phase was failed twice by the specs/820 **no-product-code-changes guard** — correctly: both runs changed only `specs/003-*/**` artifacts (`plan.md`, `tasks.md`, `contracts/*`, …; worker log: `changedFiles: [specs/... ×10] excluded: ['specs/']`). But the posted failure alert said only:

> ❌ implement failed — `implement` exit 0. (no output on either stream)

The guard's explanation exists — `result.error.message` = "Phase \"implement\" produced no product-code changes — all changed files are under excluded prefixes [specs/]…" — but `buildErrorEvidence` (phase-loop.ts:989–1011) returns `{command, exitDescriptor, outputTail}` and uses `error.message` **only** to sniff timeout/abort wording; the message itself is dropped. With `error.output` empty on this synthetic path, the alert renders the "(no output on either stream)" literal.

Cost in the live run: the operator and auto session read "exit 0, no output" as a transient anomaly → requeue → identical failure → second escalation gate → operator time burned, and the actual signal ("the implement agent wrote only spec artifacts") was never surfaced. Two aggravations:

- **`exit 0` in a failure alert is a lying label** — the process exited 0 and was failed post-exit by a classifier; the alert should say which check failed it, not present a success code as the failure descriptor.
- Every synthetic-PhaseResult path (product-diff guard, no-progress guard, catch-block) shares this: the one line that explains the failure is the one line the alert cannot carry.

## Fix

Include the classifier message in the evidence: add a `reason` field to `CommandExitEvidence` populated from `result.error.message`, rendered above the output tail in both the stage comment and the failure alert. When the failure comes from a post-exit classifier rather than the process, the exit descriptor should name it (`failed post-exit: no-product-code-changes (process exit 0)`).

**Design (resolved via clarifications):**

- **Synthetic-vs-process discriminator (Q1)**: `buildErrorEvidence` gains an explicit optional `classifier?: string` parameter — presence is the sole discriminator. `error.output` stays free-form on every path (no code churn at the no-progress site to satisfy an inference rule).
- **Reason rendering (Q2)**: single-line reasons render inline as `**Reason**: <reason>`. Multi-line reasons render with `**Reason**:` on its own line followed by a fenced ` ```text ` block containing the verbatim message, capped at 1 KiB with a trailing `…` marker (same fence-and-cap idiom already used for `outputTail`).
- **Catch-block classifier names (Q3)**: site-specific — `'spawn-error'` for the unexpected-spawn catch (~`phase-loop.ts:373`) and `'product-diff-error'` for the product-diff-detection catch (~:600). No shared `'catch-block'` literal. FR-003's third classifier name becomes two names in the fixture set.
- **Markdown safety (Q4)**: ZWSP-escape single backticks in `reason` before rendering, matching the treatment already used for `outputTail` in `stage-comment-manager.ts`. Composes with Q2-B: multi-line content sits inside a fence, single-line content has stray backticks defanged.
- **Callsite scope (Q5)**: all six FR-006 callsites pass the `classifier` argument explicitly. The three synthetic-result sites pass named classifiers (`'no-progress'`, `'no-product-code-changes'`, `'spawn-error'`, `'product-diff-error'`); the shell/CLI process-failure sites (`:294`, `:548`) pass `classifier: undefined`. Explicit `undefined` keeps every callsite's path-classification grep-auditable rather than implied by omission. Process-path rendering is unchanged.

## Clarifications

### Session 2026-07-11

- Q1: How does `buildErrorEvidence` distinguish synthetic (post-exit classifier) results from real shell/CLI process results? → A: Explicit optional `classifier?: string` parameter — presence is the sole discriminator; `error.output` stays free-form on every path.
- Q2: How is `reason` normalized when it may be long or multi-line? → A: Single-line inline; multi-line in a fenced `text` block above the `**Reason**:` label, capped at 1 KiB with `…`.
- Q3: What classifier name does each catch-block synthetic-result site pass? → A: Site-specific names — `'spawn-error'` at ~:373, `'product-diff-error'` at ~:600.
- Q4: How is `reason` sanitized for markdown? → A: ZWSP-escape single backticks in `reason`, matching the existing `outputTail` treatment.
- Q5: Which of the six FR-006 callsites are modified, and how? → A: All six pass the `classifier` argument explicitly; the shell-path callsites (`:294`, `:548`) pass `classifier: undefined`.

## Regression tests

- Product-diff guard failure → alert body contains the excluded-prefixes message and names the guard; never renders "(no output on either stream)" as the only evidence.
- No-progress guard and catch-block synthetic results → same.
- Process-failure path (real non-zero exit) → unchanged shape plus empty/absent reason.


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
