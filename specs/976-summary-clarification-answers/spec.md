# Feature Specification: Honor clarification answers from cluster's own GitHub account

**Branch**: `976-summary-clarification-answers` | **Date**: 2026-07-17 | **Status**: Draft

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

## Related

- generacy-ai/agency#433 — hit this; unblocked via the marker relay.
- `cockpit_relay_clarify_answers` / `clarification-answer-marker.ts` — the current (only) working same-account path.
- Spec `958-found-during-local-snappoll` — introduced FR-001/FR-003, the gates above.

## User Stories

### US1: Developer running cluster under own GitHub credentials

**As a** developer running a Generacy cluster under my own GitHub account (not a separate bot),
**I want** my plain-text `Q<n>:` clarification reply to be recognized and integrated automatically,
**So that** I don't have to provision a separate bot identity or use the `cockpit_relay_clarify_answers` MCP relay just to answer a clarification question by hand in the GitHub UI.

**Acceptance Criteria**:
- [ ] A plain `Q<n>:` reply authored by the cluster's own account, while the issue is at `waiting-for:clarification`, auto-resumes (monitor enqueues `continue`).
- [ ] The reply integrates into `clarifications.md` without requiring the `<!-- generacy-clarification-answers: -->` marker.
- [ ] No manual `completed:clarification` label application required.
- [ ] The clarify phase advances to the next phase (e.g. `plan`) rather than looping back to `waiting-for:clarification`.

### US2: Cluster operator whose cluster identity is a bot

**As an** operator whose cluster identity is a GitHub App / `[bot]` account,
**I want** the cluster's own machine comments (question posts, stage/status comments, audit comments) to continue to be excluded from answer scanning,
**So that** the cluster does not integrate its own machine output as if it were a human answer.

**Acceptance Criteria**:
- [ ] The cluster's own machine comments (question/stage/status/audit) never mis-integrate as answers.
- [ ] Existing bot-identity clarification flows (marker-stamped via `cockpit_relay_clarify_answers`) continue to work unchanged.

### US3: Operator receiving a silent failure

**As a** cluster operator posting a same-account clarification answer that the system cannot recognize,
**I want** a surfaced explanation of why the reply was not accepted,
**So that** I can correct my reply rather than watch the workflow silently loop back to `waiting-for:clarification`.

**Acceptance Criteria**:
- [ ] If a same-account answer cannot be parsed or is otherwise rejected, the failure is surfaced (e.g. via the existing untrusted-answer explainer path).
- [ ] The failure mode is not silent: the operator sees a comment or label reflecting the rejection reason.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The clarification-answer monitor MUST enqueue a `continue` for a plain-text `Q<n>:` reply authored by the cluster's own GitHub account while the issue is at `waiting-for:clarification`, provided the comment does not carry a known machine marker. | P1 | Fixes gate at `clarification-answer-monitor-service.ts:202`. |
| FR-002 | The phase-loop answer scanner MUST include a same-account plain-text `Q<n>:` reply as a candidate answer, provided the comment does not carry a known machine marker. | P1 | Fixes gate at `clarification-poster.ts:918-931`. |
| FR-003 | The system MUST exclude cluster-self comments that carry a known **machine** marker (question, stage/status, audit) from the answer scanner. | P1 | Preserves machine-comment safety. |
| FR-004 | The auto-resume monitor and the phase-loop answer scanner MUST apply the same acceptance rules for same-account comments, so a comment that triggers the resume also integrates. | P1 | Prevents divergence between call sites. |
| FR-005 | Existing marker-stamped relay path (`cockpit_relay_clarify_answers`) MUST continue to work for both bot-identity and human-identity clusters. | P1 | Backwards compatibility. |
| FR-006 | Existing different-account human-answer path MUST continue to be parsed permissively (no marker required). | P1 | Preserves FR-002 behavior from #958. |
| FR-007 | When a same-account answer cannot be parsed or integrated, the system MUST surface the failure (e.g. via the existing untrusted-answer explainer path) rather than silently re-arming `waiting-for:clarification`. | P2 | Fixes silent-loop failure mode. |
| FR-008 | The trust layer (`isTrustedCommentAuthor` with `reason: 'self-authored'`) MUST remain the authoritative trust gate for same-account comments after the identity-based exclusion is removed. | P1 | The trust check stays; only the pre-trust identity gate loosens. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Plain `Q<n>:` reply from cluster's own account auto-resumes and integrates. | 100% success on the agency#433 repro scenario. | Regression test in `clarification-answer-monitor-service.test.ts` + `clarification-poster*.test.ts` covering the same-account plain-text answer path. |
| SC-002 | Cluster's own machine comments (question/stage/status/audit) are still excluded from answer integration. | 0 false-positive integrations. | Regression test in `clarification-self-answer.test.ts` covering each machine-marker type. |
| SC-003 | Auto-resume monitor and phase-loop scanner produce the same accept/reject decision for a given same-account comment. | 100% agreement across both call sites. | Cross-check regression test that feeds identical comment fixtures to both code paths. |
| SC-004 | Same-account answer rejection is not silent. | Every rejected same-account answer produces a surfaced failure signal (comment, label, or explainer). | Regression test that asserts a surfaced failure when a same-account comment is rejected. |
| SC-005 | Existing marker-stamped and different-account paths remain green. | 0 regressions in `#958` behavior. | Existing `#958` regression suite continues to pass. |

## Assumptions

- The cluster's own machine comments (question posts, stage/status comments, audit comments) each carry a **known, distinguishable machine marker** that the answer scanner can look for. If a machine-comment type does not currently carry a marker, adding one is in scope for this change.
- The trust layer (`isTrustedCommentAuthor` at `comment-trust.ts:122`) is the correct authoritative gate for same-account answer acceptance; the identity-based pre-trust gates from `#958` are the wrong disambiguator for human-identity clusters.
- "Cluster identity is human vs. bot" can either (a) be treated identically at the code level by relying on marker-based machine exclusion instead of identity-based, or (b) be surfaced as an explicit or auto-detected config signal (`clusterIdentityIsHuman`). The plan phase will choose between these paths.
- Applying the change to both the monitor and the phase-loop scanner is required — divergence between them re-creates the silent-loop failure mode.

## Out of Scope

- Broader refactor of the `#958` clarification-answer trust and marker system beyond fixing the same-account gate.
- Changes to the `cockpit_relay_clarify_answers` MCP relay path.
- Changes to how clarification questions themselves are posted or discovered.
- Changes to `clarifications.md` file format or the phase-transition state machine.
- Support for multi-identity clusters (a cluster acting as multiple GitHub identities) — out of scope until real demand.

---

*Generated by speckit*
