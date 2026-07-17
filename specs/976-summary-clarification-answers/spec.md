# Feature Specification: ## Summary

Clarification answers posted from the **cluster's own GitHub account** are silently dropped

**Branch**: `976-summary-clarification-answers` | **Date**: 2026-07-17 | **Status**: Draft

## Summary

## Summary

Clarification answers posted from the **cluster's own GitHub account** are silently dropped. Developers very commonly run a Generacy cluster under **their own GitHub credentials** (so they don't have to provision a separate bot account just to use Generacy). Under that — normal, documented — setup, a developer's plain-text clarification answer is `viewerDidAuthor === true`, and two `#958` "cluster-self" gates cause it to be ignored: the workflow never auto-resumes, and even a force-resumed clarify phase leaves the answers `*Pending*` and re-arms `waiting-for:clarification`. The only path that works is the marker-stamped relay (`cockpit_relay_clarify_answers`), which a human answering by hand in the GitHub UI will not use.

## Impact / repro (observed on generacy-ai/agency#433)

1. Cluster runs as `christrudelpw`; operator (same account) posts a plain reply:
   ```
   Q1: A
   Q2: B
   Q3: B
   ```
   and adds `completed:clarification`.
2. The clarify phase resumes, but the answer-scanner does not recognize the reply (same account, no marker). `clarifications.md` stays `**Answer**: *Pending*`, the phase re-runs discovery, and re-arms `waiting-for:clarification` — a silent loop with no error surfaced to the operator.
3. Workaround that unblocked it: re-post via `cockpit_relay_clarify_answers` (marker-stamped) → integrated → advanced to `plan`.

## Root cause — two `viewerDidAuthor === true` gates (spec #958 FR-001 / FR-003)

**1. Auto-resume monitor never enqueues on a same-account answer**
`packages/orchestrator/src/services/clarification-answer-monitor-service.ts:202`
```ts
for (const c of comments) {
  if (c.viewerDidAuthor === true) continue;   // ← same-account answer skipped
  if (commentCarriesAnswerMarker(c.body)) continue;
  const decision = isTrustedCommentAuthor(c, 'answer-scanner', trustCtx);
  if (decision.trusted) { hasHumanTrustedComment = true; break; }
}
```
So for a same-account operator, no `completed:clarification` is ever applied automatically — the answer produces no resume at all.

**2. Phase-loop answer-scanner drops the unmarked same-account comment**
`packages/orchestrator/src/worker/clarification-poster.ts:918-931`
```ts
if (c.viewerDidAuthor === true) {
  if (commentCarriesAnswerMarker(c.body)) {
    answerComments.push(c);
  } else {
    // 'Skipped cluster-self comment lacking engine-written answer marker (FR-003)'
  }
} else {
  answerComments.push(c);   // different-account human — parsed permissively (FR-002)
}
```
A same-account plain reply must carry `<!-- generacy-clarification-answers: -->` (stamped **only** by `cockpit_relay_clarify_answers`) or it is discarded.

Note: `isTrustedCommentAuthor` itself already *trusts* self-authored comments (`comment-trust.ts:122`, `reason: 'self-authored'`) — so the trust layer is not the blocker. These two `#958` gates sit in front of it and specifically single out same-account authorship.

## Why the gate exists (don't just delete it)

The gate stops the cluster from integrating its **own machine comments** as answers — the question comments, stage/status comments, audit comments, or an agent free-writing something shaped like `Q1: …`. The `#958` design used the answer-marker as the disambiguator: "a cluster-self comment counts as an answer only if the engine deterministically stamped it." When the cluster identity is a *bot*, that's fine. When the cluster identity is a *human developer*, it also throws away that human's genuine answers.

## Requested change

Honor same-account human answers **without** requiring the engine marker, so single-identity clusters (cluster login == the developer's own account) work out of the box — while preserving machine-comment safety. Directions for the spec/plan phase to weigh:

- **Marker-based machine exclusion instead of identity-based.** Exclude a comment from the answer-scanner only when it carries a known **machine** marker (question markers, stage/status markers, audit markers) — not merely because `viewerDidAuthor === true`. Any other comment matching the `Q<n>:` answer shape, from a trusted author, is a candidate answer. This keeps the bot's own machine output out while letting a human-on-the-cluster-account answer in plain text. (Restores the "[gate on authorship, not content/markers] / plain replies are first-class" principle for same-account operators.)
- **And/or an explicit cluster config flag** (e.g. `clusterIdentityIsHuman: true`, or auto-detected when the cluster login resolves to a real user rather than a `[bot]`/App identity) that turns off the same-account answer-marker requirement in both the monitor and the phase-loop scanner.

Whichever path, apply it to **both** call sites (monitor + phase-loop scanner) so the auto-resume and the integration agree.

## Acceptance

- A plain `Q<n>:` reply authored by the cluster's **own** account, while the issue is at `waiting-for:clarification`, auto-resumes (monitor enqueues `continue`) and integrates into `clarifications.md` — no marker, no manual `completed:clarification`.
- The cluster's own machine comments (question/stage/status/audit) still never mis-integrate as answers.
- Regression tests for both same-account and different-account answer paths (extend `clarification-answer-monitor-service.test.ts`, `clarification-poster*.test.ts`, `clarification-self-answer.test.ts`).
- Failure is no longer silent: if a same-account answer can't be parsed, surface it (the existing untrusted-answer explainer path is a model).

## Clarifications

### Session 1 — 2026-07-17

- **Q1 → A**: Ship marker-based machine exclusion only. No cluster config, no identity classification. Apply at both call sites (monitor at `clarification-answer-monitor-service.ts:202` and phase-loop scanner at `clarification-poster.ts:918-931`).
- **Q2 → A**: All three cluster-emitted machine comment types (question posts, stage/status, audit) already carry distinguishable markers; fix is scanner-side only, no poster migration. Broaden the scanner's exclusion set from `CLARIFICATION_QUESTION_MARKERS` to one canonical `MACHINE_MARKERS` set covering every family: `generacy-clarifications:`, `generacy-stage:clarification|specification|planning|implementation`, `generacy-cockpit:manual-advance`, `generacy-clarification-answers:`, `generacy-untrusted-answer:`, `generacy-clarification-parse-failures:`, and the `speckit-stage:*` variants.
- **Q3 → A**: Surface rejected same-account answers via the existing untrusted-answer explainer comment path (`generacy-untrusted-answer:` family / `postUntrustedAnswerExplainers`). No new label.
- **Q4 → A**: Same-account permissive path is parity with FR-006 different-account path — any trusted, marker-free comment is a candidate; `Q<n>:` parsing decides what integrates. No extra shape or temporal gate for same-account.
- **Q5 → D**: Not applicable — Q1=A uses no identity signal, so no cluster-login human/bot classification is performed.

Full context and options in [`clarifications.md`](./clarifications.md).

## Related

- generacy-ai/agency#433 — hit this; unblocked via the marker relay.
- `cockpit_relay_clarify_answers` / `clarification-answer-marker.ts` — the current (only) working same-account path.
- Spec `958-found-during-local-snappoll` — introduced FR-001/FR-003, the gates above.

---
<sub>Filed via Claude Code after diagnosing why agency#433 kept reverting to `waiting-for:clarification`.</sub>


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
