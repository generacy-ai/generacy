# Feature Specification: fix(orchestrator): clarification-answer monitor resume-loops on the cluster's own bot comments

**Branch**: `993-summary-orchestrator-s` | **Date**: 2026-07-18 | **Status**: Draft
**Type**: `workflow:speckit-bugfix`
**Upstream**: [generacy#993](https://github.com/generacy-ai/generacy/issues/993)

## Summary

The orchestrator's `ClarificationAnswerMonitorService` enters an infinite ~5-minute resume loop on any issue parked at `waiting-for:clarification` + `agent:paused`. It re-runs the clarify phase every poll cycle until the phase crashes to `failed:clarify` + `agent:error`. Root cause: the service does **not** recognize the cluster's own bot identity (`generacy-ai[bot]`, the GitHub App login) as self, and its machine-marker skip does not cover all engine-authored comments — so the always-present `<!-- generacy-stage:specification -->` summary comment (authored by the App) passes the "trusted human comment" check and perpetually satisfies the resume predicate.

Fix: teach the monitor to treat App-bot authors (`[bot]` suffix / `author.type == 'Bot'`, and specifically `generacy-ai[bot]`) as non-human, harden the answer predicate to be *positive* (marker-based or genuine non-cluster human, *newer* than the latest question), and widen the machine-marker skip to cover non-question engine markers (`generacy-stage:*`, `speckit-stage:*`).

## Root Cause (verbatim from issue)

The monitor resumes an issue when it finds "≥1 trusted human-authored comment" that is not a recognized clarification-question marker (`packages/orchestrator/src/services/clarification-answer-monitor-service.ts:180-220`). Two compounding gaps:

1. **The cluster's bot identity is not recognized as self.** The trust check compares comment authors against `clusterGithubUsername` (resolved to the *account*, e.g. `christrudelpw`), but on this cluster the comments are authored by the GitHub App login **`generacy-ai[bot]`** — a distinct login. `gh api user` from the orchestrator returns `403 Resource not accessible by integration`, confirming it operates under the App installation token (author = `generacy-ai[bot]`). So `generacy-ai[bot]`'s comments pass the trust check as external/human authors.

2. **The machine-marker skip doesn't cover all engine comments.** `commentCarriesMachineMarker` only matches the clarification-**question** marker set (`packages/orchestrator/src/worker/clarification-markers.ts:18-24` — `generacy-stage:clarification`, `generacy-clarifications:`, `generacy-clarification:`, `generacy-cockpit:clarifications-batch:`). It does **not** match the always-present `<!-- generacy-stage:specification -->` summary comment, nor the `<!-- speckit-stage:clarification -->` prefix the speckit-feature workflow emits. Those bot comments fall through the skip and reach the (broken) author check.

Because the `generacy-stage:specification` summary is posted at the specification stage — **before** clarification and always present — the "trusted human comment" condition is satisfied on the very first poll after the issue enters `waiting-for:clarification`. The monitor enqueues a resume; the resumed clarify phase finds no real answer, never applies `completed:clarification`, and the issue stays at `waiting-for:clarification` → re-resumed next poll (~5 min) → forever, until repeated re-runs crash the phase (`clarify exit 1`).

## Evidence (snappoll cluster, 2026-07-18)

- `clarification-answer-resume-enqueued` for issues #5–#8 at 302s intervals: `t`, `t+303s`, `t+302s`, `t+302s`, `t+301s` (source: orchestrator poll).
- #5 comments — all authored by `generacy-ai[bot]`: `<!-- generacy-stage:specification -->`, `<!-- speckit-stage:clarification -->`, `<!-- generacy-clarifications:5 -->`. Only `generacy-clarifications:5` is recognized by `commentCarriesMachineMarker`.
- #6 and #7 final labels: `completed:specify, failed:clarify, agent:error` + a `clarify failed — clarify exit 1` comment.
- `gh api user` (orchestrator) → `403 Resource not accessible by integration` → App installation token.

## User Stories

### US1: A parked clarification issue does not eat compute or crash

**As a** cluster operator running a speckit workflow,
**I want** an issue parked at `waiting-for:clarification` to stay parked until a genuine external answer arrives,
**So that** the clarify phase does not resume-loop, does not exhaust the GitHub API budget, and does not fabricate `failed:clarify`/`agent:error` states on issues that are simply awaiting human input.

**Acceptance Criteria**:
- [ ] An issue at `waiting-for:clarification` whose only comments are cluster-bot-authored (spec summary + question comments) records **zero** `clarification-answer-resume-enqueued` events across at least two full poll cycles.
- [ ] Neither `failed:clarify` nor `agent:error` is applied to such an issue by the monitor.

### US2: The App bot login is treated as self regardless of PAT identity

**As a** cluster running under a GitHub App installation (comment-author login `generacy-ai[bot]`) whose PAT/account identity (`clusterGithubUsername`) is a distinct account,
**I want** the monitor to identify the App-bot login as a cluster/machine author,
**So that** the identity split between the PAT account and the App-bot comment author does not silently break the "trusted human answer" gate.

**Acceptance Criteria**:
- [ ] `generacy-ai[bot]` comments never count as human clarification answers.
- [ ] Any comment author whose login ends in `[bot]` (or whose `author.type == 'Bot'` per the GraphQL/REST payload) is treated as non-human by the answer predicate.
- [ ] The behaviour holds even when `gh api user` returns 403 and `clusterGithubUsername` cannot be resolved (App installation token case).

### US3: A genuine human answer still resumes the phase

**As a** developer answering a clarification question on a parked issue,
**I want** my answer comment to promptly (within one poll cycle) resume the clarify phase,
**So that** the workflow proceeds without me needing to know the internals of the marker vocabulary.

**Acceptance Criteria**:
- [ ] A comment authored by a login that is neither `clusterGithubUsername` nor a `[bot]` account, posted **after** the latest clarification-question comment, resumes the phase on the next poll.
- [ ] A comment carrying a recognized `CLARIFICATION_ANSWER_MARKERS` marker also resumes the phase, regardless of author.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The clarification-answer monitor MUST treat any comment whose author login ends in `[bot]` as a non-human author (never counts as a clarification answer). | P1 | Covers the general GitHub App / bot-account case, not just `generacy-ai[bot]`. |
| FR-002 | The monitor MUST treat `generacy-ai[bot]` explicitly as a cluster-self author, regardless of how `clusterGithubUsername` resolves (or fails to resolve). | P1 | Guards the App-installation-token case where `gh api user` returns 403 and the account name is unknown. |
| FR-003 | The answer predicate MUST be positive: a comment counts as a clarification answer only if (a) it carries a `CLARIFICATION_ANSWER_MARKERS` marker OR (b) it is authored by a non-bot, non-cluster-self login. The current "any comment that is not a question marker" negative predicate MUST be removed. | P1 | Prevents future regressions from new engine-authored marker types. |
| FR-004 | A candidate answer comment MUST be strictly newer (by `createdAt`) than the latest clarification-question comment on the issue for the monitor to resume the phase. | P1 | Ensures a pre-existing/earlier bot comment (e.g. the spec summary) can never perpetually satisfy the predicate. |
| FR-005 | `commentCarriesMachineMarker` (or an equivalent skip) MUST recognize `generacy-stage:*` and `speckit-stage:*` HTML-comment prefixes in addition to the existing question-marker set. | P2 | Defense in depth — the FR-001/FR-002 fix alone closes the loop, but this makes engine comments unambiguously identifiable everywhere. |
| FR-006 | The comment fetch used by the monitor MUST include the author's `login` and `type` (or equivalent bot-flag) fields so FR-001 can be evaluated without additional round-trips. | P2 | Adjust the GraphQL/REST projection if needed. |
| FR-007 | The monitor MUST NOT apply `failed:clarify` or `agent:error` on an issue that has no valid answer to act on. Failure labels come from a real clarify phase run, not from the monitor. | P2 | Documents the observed symptom (#6, #7 crashing out) is downstream of the loop; the fix prevents the loop from triggering runs in the first place. |
| FR-008 | A changeset (`.changeset/*.md`) MUST accompany the fix in the same PR, per repository CI gate. | P1 | Bump: `patch` (bugfix, `workflow:speckit-bugfix`). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Resume-enqueue rate on bot-only-comment issues | 0 events per issue per hour | Reproduce the snappoll scenario in a regression test: create an issue at `waiting-for:clarification` + `agent:paused` with only bot-authored comments (spec summary + question marker); assert the monitor produces zero `clarification-answer-resume-enqueued` events across ≥2 simulated poll cycles. |
| SC-002 | Genuine-human-answer resume latency | ≤ 1 poll cycle | Regression test: seed the issue as in SC-001, add a comment authored by a non-bot, non-cluster login with `createdAt` after the latest question marker; assert exactly one `clarification-answer-resume-enqueued` event on the next poll. |
| SC-003 | Answer-marker resume | ≤ 1 poll cycle | Regression test: add a comment carrying a `CLARIFICATION_ANSWER_MARKERS` marker (any author, incl. bot); assert exactly one resume enqueue. |
| SC-004 | Failed-phase leakage | 0 `failed:clarify` / `agent:error` labels applied by the monitor path on bot-only-comment fixtures | Regression test assertion + audit of labels applied during the SC-001 test. |
| SC-005 | Existing clarification-answer tests | 100% pass | `pnpm test` in `packages/orchestrator` shows no regressions in the existing suite. |
| SC-006 | Changeset present in diff | 1 newly added `.changeset/*.md` file | `git diff --diff-filter=A --name-only origin/develop..HEAD -- .changeset/` returns ≥1 file. |

## Assumptions

- The monitor already fetches sufficient comment metadata (author login, `createdAt`) or can be extended to do so without a schema change.
- `CLARIFICATION_ANSWER_MARKERS` exists (or a small equivalent set can be established) as the canonical marker vocabulary for cockpit-mediated answers; if missing, defining it is in-scope for the fix.
- The App-bot login string on production clusters is `generacy-ai[bot]`. Any additional bot logins are covered by the generic `[bot]`-suffix rule in FR-001.
- The `<!-- generacy-stage:specification -->` and `<!-- speckit-stage:clarification -->` comments are load-bearing for other flows and MUST NOT be removed — the fix must live in the monitor's predicate, not by suppressing those comments.
- The fix is independent of #987's poll-gate change; this is a latent defect that pre-dates #987.

## Out of Scope

- Rewriting the cockpit clarifications-batch protocol or introducing a new answer marker beyond what is minimally needed for the positive predicate.
- Resolving the `gh api user` 403 (the App-installation-token identity resolution is a broader concern; this spec works around it by treating the App-bot login as self).
- Changing the poll cadence (~5 minutes) of `ClarificationAnswerMonitorService`.
- Changes to `LabelMonitorService`, `PrFeedbackMonitorService`, or other services that also read comments — unless they share the same predicate code path, in which case the fix propagates naturally.
- Cross-repository / multi-org bot identity — one App login per cluster is assumed.

---

*Generated by speckit — refined from generacy#993*
