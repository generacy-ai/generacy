# Feature Specification: ## Summary

The orchestrator's `ClarificationAnswerMonitorService` enters an **infinite ~5-minute resume loop** on any issue parked at `waiting-for:clarification` + `agent:paused`, re-running the clarify phase every poll cycle until it crashes to `failed:clarify` + `agent:error`

**Branch**: `993-summary-orchestrator-s` | **Date**: 2026-07-18 | **Status**: Draft

## Summary

## Summary

The orchestrator's `ClarificationAnswerMonitorService` enters an **infinite ~5-minute resume loop** on any issue parked at `waiting-for:clarification` + `agent:paused`, re-running the clarify phase every poll cycle until it crashes to `failed:clarify` + `agent:error`. Observed on the snappoll preview cluster (2026-07-18): P3 issues #5–#8 were re-enqueued for resume every ~302s; **#6 and #7 crashed out to `failed:clarify` + `agent:error`**, #5 and #8 kept looping until the cluster was stopped. Each resume is a full clarify agent-run, so this was the dominant compute/GitHub-API consumer during the run — it presents as "something is exhausting the API" and "the issue keeps getting resumed every 5 min without a `completed:clarification` label."

## Root cause

The monitor resumes an issue when it finds "≥1 trusted human-authored comment" that is not a recognized clarification-question marker (`packages/orchestrator/src/services/clarification-answer-monitor-service.ts:180-220`). It mistakes the cluster's **own bot-authored comments** for human answers, via two compounding gaps:

1. **The cluster's bot identity is not recognized as self.** The trust check compares comment authors against `clusterGithubUsername` (resolved to the *account*, e.g. `christrudelpw`), but on this cluster the comments are authored by the GitHub App login **`generacy-ai[bot]`** — a distinct login. `gh api user` from the orchestrator returns `403 Resource not accessible by integration`, confirming it operates under the App installation token (author = `generacy-ai[bot]`). So `generacy-ai[bot]`'s comments pass the trust check as external/human authors.

2. **The machine-marker skip doesn't cover all engine comments.** `commentCarriesMachineMarker` only matches the clarification-**question** marker set (`packages/orchestrator/src/worker/clarification-markers.ts:18-24` — `generacy-stage:clarification`, `generacy-clarifications:`, `generacy-clarification:`, `generacy-cockpit:clarifications-batch:`). It does **not** match the always-present `<!-- generacy-stage:specification -->` summary comment, nor the `<!-- speckit-stage:clarification -->` prefix the speckit-feature workflow emits (the recognized set has `generacy-stage:clarification`, not `speckit-stage:`). So those bot comments fall through the skip and reach the (broken) author check.

Because the `generacy-stage:specification` summary is posted at the specification stage — **before** clarification and always present — the "trusted human comment" condition is satisfied on the very first poll after the issue enters `waiting-for:clarification`. The monitor enqueues a resume; the resumed clarify phase finds no real answer, never applies `completed:clarification`, and the issue stays at `waiting-for:clarification` → re-resumed next poll (~5 min) → forever, until repeated re-runs crash the phase (`clarify exit 1`).

## Evidence (snappoll, 2026-07-18)

- `clarification-answer-resume-enqueued` for #5–#8 at 302s intervals: `t`, `t+303s`, `t+302s`, `t+302s`, `t+301s` (source: poll).
- #5 comments — all authored by `generacy-ai[bot]`: `<!-- generacy-stage:specification -->`, `<!-- speckit-stage:clarification -->`, `<!-- generacy-clarifications:5 -->`. (Of these, only `generacy-clarifications:5` is recognized by `commentCarriesMachineMarker`.)
- #6, #7 final labels: `completed:specify, failed:clarify, agent:error` + a `clarify failed — clarify exit 1` comment.
- `gh api user` (orchestrator) → `403 Resource not accessible by integration` → App installation token.

## Proposed fix

**Primary — recognize the cluster's own bot identity as self.** The monitor must treat `generacy-ai[bot]` (the App login, `author.type == 'Bot'` / the `[bot]` suffix) — not just the resolved account `clusterGithubUsername` — as a non-human author whose comments never count as clarification answers.

**Secondary (defense in depth):**
- Identify a clarification *answer* **positively** — a comment carrying a `CLARIFICATION_ANSWER_MARKERS` marker, or one authored by a genuine non-cluster human — rather than "any comment that isn't a question marker." The current negative predicate is inherently fragile.
- Require the candidate answer comment to be **newer than the latest clarification-question comment**, so a pre-existing/earlier comment (like the spec summary) can never perpetually satisfy the predicate.
- Optionally widen the machine-marker skip to cover non-question engine comments (`generacy-stage:*`, `speckit-stage:*`).

## Acceptance criteria

- An issue at `waiting-for:clarification` whose only comments are cluster/bot-authored (spec summary + question comments) is **not** resumed.
- `generacy-ai[bot]` (App login / `[bot]` type) is never treated as a human clarification answerer, regardless of how `clusterGithubUsername` resolves.
- A resume fires only on a genuine answer (answer marker, or a true external-human comment newer than the questions).
- Regression test reproducing the #5–#8 loop: bot-only comments → zero resume enqueues.
- Changeset included.

## Impact / context

Any speckit issue that reaches clarification without a valid answer resume-loops indefinitely — re-running the clarify agent every ~5 min and eventually failing the issue. It's both a significant compute/API drain and a workflow-integrity bug (it fabricates `failed:clarify`/`agent:error` states). Surfaced while diagnosing the snappoll auto run: the smee outage (#991) left P3 issues parked at `waiting-for:clarification`, which then tripped this loop. The resume predicate is independent of the #987 poll-gate change (same service, different logic) — this is a latent defect, not a #987 regression. Note the identity split: the cluster PAT identity (`christrudelpw`) differs from the App comment-author login (`generacy-ai[bot]`); see also the same-account clarification-answer handling in prior clarify work.


## User Stories

### US1: Operator running a smee-less speckit cluster

**As an** operator running a preview/snappoll cluster whose issues reach `waiting-for:clarification` under the App installation identity,
**I want** the clarification-answer monitor to ignore its own bot-authored comments,
**So that** issues parked at `waiting-for:clarification` stay parked until a genuine human answer arrives, and don't burn compute/API by looping through the clarify phase every ~5 min until they crash to `failed:clarify` + `agent:error`.

**Acceptance Criteria**:
- [ ] An issue at `waiting-for:clarification` whose only comments are cluster/bot-authored (spec-summary + question comments) is **not** resumed.
- [ ] `generacy-ai[bot]` (App login / `[bot]`-suffix / `author.type == 'Bot'`) is never counted as a human clarification answerer, regardless of how `clusterGithubUsername` resolves.
- [ ] A resume fires only on a genuine answer: a `CLARIFICATION_ANSWER_MARKERS` marker comment authored by a non-bot, or a true external-human comment newer than the latest question batch.
- [ ] Regression test reproducing the #5–#8 loop: bot-only comments → zero resume enqueues across N poll cycles.
- [ ] Changeset included.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The monitor MUST treat any comment whose author login carries the `[bot]` suffix (or whose `author.type == 'Bot'`) as a non-human author whose comment can never satisfy the resume predicate, regardless of the resolved `clusterGithubUsername`. | P1 | Filter applies unconditionally — a marker on a bot-authored comment does NOT rescue it (see FR-003, Q1). |
| FR-002 | The monitor MUST recognize the literal `generacy-ai[bot]` as the cluster's own App identity ("self") for log-labeling purposes. | P1 | Hardcoded; fork/staging clusters (e.g. `staging-generacy[bot]`) fall through to the generic FR-001 `[bot]`-suffix filter with identical behavior — the specificity is a log label, not a behavior branch (Q5=A). |
| FR-003 | The monitor MUST identify a clarification *answer* positively as either: **(a)** a comment carrying a marker in `CLARIFICATION_ANSWER_MARKERS` AND whose author is NOT `[bot]`-suffixed, **OR** **(b)** a comment whose author is neither `[bot]`-suffixed nor cluster-self. | P1 | Replaces the current negative "any comment that isn't a question marker" predicate. Cluster-relayed answers (cockpit's `generacy-clarification-answers:` marker, authored by `generacy-ai[bot]`) flow through the `completed:clarification` label / LabelMonitorService path — NOT this monitor (Q1=A). |
| FR-004 | The candidate answer comment MUST be strictly newer, by `createdAt`, than the latest clarification-question comment on the issue. "Latest clarification-question comment" = the newest comment (by `createdAt`) whose body matches any prefix in `CLARIFICATION_QUESTION_MARKERS`. `updatedAt` is NOT consulted. | P1 | `createdAt`-only is replay-safe and blocks the bot-self-edit re-trigger vector (the `<!-- generacy-stage:specification -->` summary refreshes as phases progress) (Q2=A, Q4=A). |
| FR-005 | `commentCarriesMachineMarker` MUST match any comment whose body begins with `<!-- generacy-stage:` or `<!-- speckit-stage:` (prefix-family match on any suffix), NOT just the currently enumerated stages. | P1 | Kills the whole enumeration-drift class — every future engine-authored stage marker is skipped without a code change. Does NOT catch question-batch prefixes (`generacy-clarifications:`, `generacy-cockpit:clarifications-batch:`), so the FR-004 anchor is unaffected (Q3=C). |
| FR-006 | Changeset MUST be added under `.changeset/` for the packages whose non-test `src/` is modified (orchestrator; possibly worker if markers move). | P1 | CI gate — see CLAUDE.md. Bump level = `patch` (defect fix, `workflow:speckit-bugfix`). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Bot-only-comment resume rate | 0 resumes | Regression test: seed issue with `<!-- generacy-stage:specification -->` + `<!-- speckit-stage:clarification -->` + `<!-- generacy-clarifications:N -->` comments (all authored by a `[bot]`-suffixed login), run monitor across N poll cycles, assert `clarification-answer-resume-enqueued` count == 0. |
| SC-002 | Real answer resume works | 1 resume within one poll cycle | Regression test: seed the SC-001 setup plus one comment authored by a non-bot login (e.g. `christrudelpw`) with a `createdAt` newer than the question comment, assert exactly one resume-enqueue on the next poll. |
| SC-003 | Marker-carrying answer (non-bot author) | 1 resume within one poll cycle | Regression test: seed a comment carrying a `CLARIFICATION_ANSWER_MARKERS` marker whose author is NOT `[bot]`-suffixed and whose `createdAt` beats the question comment, assert one resume-enqueue. (Bot-authored marker case is covered by SC-001.) |
| SC-004 | Stage-marker enumeration drift resistance | 0 resumes for future stages | Unit test: `commentCarriesMachineMarker('<!-- speckit-stage:some-future-stage -->\n...')` returns true without a code change to the marker list. |

## Assumptions

1. Cluster-relayed clarification answers (cockpit MCP `generacy-clarification-answers:` marker comments authored by `generacy-ai[bot]`) reach the phase-loop via the `completed:clarification` label applied by the relay, resumed by LabelMonitorService — NOT via this monitor. Verified against `clarification-answer-monitor-service.ts:180-184` documentation.
2. GitHub's REST/GraphQL comment payload includes `author.login` with the `[bot]` suffix for App-installation comments, matching the observed snappoll behavior (`generacy-ai[bot]`).
3. The `CLARIFICATION_QUESTION_MARKERS` registry is authoritative and complete for identifying clarification-question comments at the FR-004 anchor point; if a future timing edge shows the umbrella `<!-- generacy-stage:clarification -->` marker being emitted AFTER a question batch and mis-anchoring FR-004, the fix is to exclude it from the anchor set (per Q2 caveat).
4. `<!-- generacy-stage:*` and `<!-- speckit-stage:*` prefixes are strictly engine-authored — no human posts these, so the prefix-family match in FR-005 is safe.
5. The changeset bump is `patch` (defect fix, `workflow:speckit-bugfix`). Orchestrator surface changes are internal — no public API added.

## Out of Scope

1. Fork/staging App-bot login discovery (`staging-generacy[bot]`, `generacy-preview[bot]`, …) — behavior is already correct via FR-001; only the log-label specificity is lost, which is acceptable (Q5=A).
2. Runtime discovery of the App login via `GET /repos/:owner/:repo/installation` — not needed for FR-002's log-label purpose (Q5=A).
3. Config knob for the cluster's App login — same rationale (Q5=A).
4. `updatedAt`-based newness for edit-based answers — replay-safety wins; the operator's remedy for a missed answer is to post a new comment (Q4=A).
5. Changes to the `completed:clarification` / LabelMonitorService resume path — cluster-relayed answers already work through that path; this fix is scoped to the monitor's independent resume predicate.
6. Poll-gate / adaptive polling changes (see #987) — same service, different logic; independent of this fix.

---

*Generated by speckit*
