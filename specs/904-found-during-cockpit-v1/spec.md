# Feature Specification: Found during the cockpit v1

**Branch**: `904-found-during-cockpit-v1` | **Date**: 2026-07-10 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #48.

## Observed (sniplink P3, auto session transcript)

`generacy cockpit merge --repo christrudelpw/sniplink 9` (and `10`) failed repeatedly with `gh pr merge failed (exit 1): GraphQL: Pull Request is still a draft` — while the actual PRs for those issues were unambiguously ready:

```
PR#23 draft=false branch=009-phase-3-polish-delivery closes=[9]   (mergeable, validated, review-approved)
PR#21 draft=false branch=010-phase-3-polish-delivery closes=[10]  (MERGEABLE/CLEAN, validated, review-approved)
PR#22/24/25 draft=true  (sibling issues #11/#13/#12, still in flight)
```

The verb is resolving the issue to a **draft sibling PR** instead of the issue's own PR. Corroborating evidence: invoked with a bogus ref (`#21`, actually a PR number — see companion agency finding), the resolver reported `{"status":"red","reason":"missing-label","pr":{"number":25}...}` — it linked "issue 21" to PR #25, an unrelated draft. The failure emerged only in P3, where PR bodies cross-reference sibling issues ("depends on #9", "after #10 merges"), which implicates the `pr-body` mention-scan link method: multiple PRs mention the issue, and the resolver picks a wrong candidate. Meanwhile GitHub's authoritative link — `closingIssuesReferences` — is populated, unique, and correct for every PR in the repo.

Two aggravating sub-defects:
- **The error never names the PR it resolved.** `gh pr merge failed: still a draft` with no PR number forced the operator/session to reverse-engineer the target from a separate bogus-ref run. Every merge action must log the resolved PR number and how it was resolved (`linkMethod`).
- **Draft PRs are ever considered candidates at all.** A draft cannot be merged; a resolver whose output feeds `gh pr merge` should treat drafts as non-candidates (or last-resort with a loud warning).

## Fix — resolution precedence, deterministic and loud

1. `closingIssuesReferences` (GitHub's Development link) — if exactly one open PR closes the issue, that's the answer, full stop. (In this repo it was unique and correct for all five PRs.)
2. Head-branch match (`NNN-*` feature-branch naming) as the fallback when closing refs are absent.
3. `pr-body` mention-scan only as a last resort, **excluding drafts**, and if more than one candidate survives: fail loud listing the candidates — never merge a guess. (Invariant: merge is the one irreversible verb in the cockpit; ambiguity is an error, not a coin flip.)
4. Always log/emit `resolved PR #N via <method>` on both success and failure paths.

Check the shared resolver: the `pr-body` linkMethod is also used by `PrFeedbackMonitorService` ("Linked PR #14 to issue #4 via pr-body") — if the same ambiguity exists there, feedback could attach to the wrong PR once sibling bodies cross-reference; the precedence fix should land in the shared link logic, not merge-only.

## Regression tests

- Fixture: issue with one closing-ref PR + two sibling drafts whose bodies mention the issue → resolves to the closing-ref PR.
- No closing ref, branch-name match exists → branch match wins over body mentions.
- Body-mention-only with two non-draft candidates → loud failure listing both, exit non-zero, no merge attempted.
- Draft-only candidates → loud failure ("only draft PRs reference this issue"), no merge attempted.
- Failure paths include the resolved PR number + linkMethod in output.


## User Stories

### US1: `cockpit merge` never merges (or fails against) a sibling PR

**As an** auto-mode cockpit operator running P3 workflows where sibling PR bodies cross-reference each other's issues,
**I want** `generacy cockpit merge <issue>` to resolve to *this* issue's PR — via GitHub's authoritative Development link (`closingIssuesReferences`) — never to a draft sibling that happens to mention the issue in its body,
**So that** `gh pr merge failed: Pull Request is still a draft` stops firing when the real PR is ready, and I don't have to reverse-engineer the resolved target from a separate bogus-ref run to figure out which PR the verb picked.

**Acceptance Criteria**:
- [ ] For an issue with exactly one `closingIssuesReferences` PR, the merge verb resolves to that PR regardless of how many sibling drafts mention the issue in their bodies.
- [ ] When resolution succeeds, the output/log emits `resolved PR #N via <method>` where `<method>` is one of `closing-refs | branch-name | pr-body`.
- [ ] When resolution *fails* (unresolved, wrong-state PR, missing label, checks failing, etc.), the output/log still names the PR number the resolver picked and its `linkMethod` — no more "gh pr merge failed" without a PR ID.
- [ ] Draft PRs are never selected by the `pr-body` mention-scan fallback; if the only candidates are drafts, the verb fails loud (`"only draft PRs reference this issue"`) with exit code 1 and does not call `gh pr merge`.
- [ ] When the `pr-body` fallback finds more than one non-draft candidate, the verb fails loud listing the candidates and does not call `gh pr merge`.

### US2: `PrFeedbackMonitorService` attaches feedback to the correct PR under sibling cross-references

**As** the orchestrator wiring PR review feedback back to worker issues,
**I want** the shared PR-to-issue link logic to prefer `closingIssuesReferences` over `pr-body` mention parsing,
**So that** in P3-style topologies where PR bodies say "depends on #N" / "after #M merges", feedback never lands on a sibling's issue queue and re-triggers the wrong worker.

**Acceptance Criteria**:
- [ ] `PrLinker.linkPrToIssue` consults `closingIssuesReferences` (via `gh pr view --json closingIssuesReferences` or equivalent) as its first strategy, ahead of both body-keyword parsing and branch-name parsing.
- [ ] The `linkMethod` field in `PrToIssueLink` gains a `'closing-refs'` variant; the emitted log line (`Linked PR #N to issue #M via <method>`) reports it.
- [ ] Existing branch-name and pr-body strategies remain in place as fallbacks in the documented precedence order.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The issue-to-PR resolver (`GhWrapper.resolveIssueToPRRef` in `packages/cockpit/src/gh/wrapper.ts`) MUST consult `closingIssuesReferences` on the issue first, filter to `state == OPEN`, and — if exactly one such PR exists — return it directly. | P1 | Replaces today's `gh pr list --search linked:<N>` primary path, whose `linked:` query matches sibling drafts that only mention the issue via body cross-reference. |
| FR-002 | When no closing-ref PR exists, the resolver MUST fall back to head-branch match (`^NNN-` naming), taking the single open PR whose head branch begins with `<issue>-`. | P1 | Existing branch-name-derived link, kept as second-choice. |
| FR-003 | When neither closing refs nor branch names identify a candidate, the resolver MUST fall back to a `pr-body` mention scan that **excludes drafts**. If more than one non-draft candidate remains, the resolver MUST fail loud with the list of candidates and MUST NOT call `gh pr merge`. If only draft candidates exist, the resolver MUST fail loud with `"only draft PRs reference this issue"`. | P1 | Merge is the one irreversible verb in the cockpit; ambiguity is an error, not a coin flip. |
| FR-004 | On both success and failure paths, `runMerge` (`packages/generacy/src/cli/commands/cockpit/merge.ts`) MUST emit a log line and include in stdout the resolved PR number and the `linkMethod` used (`closing-refs`/`branch-name`/`pr-body`). Existing `gh pr merge failed …` errors MUST be preceded by (or include) the resolved PR identity. | P1 | Sub-defect #1 in the finding. |
| FR-005 | Draft PRs MUST NEVER be candidates in the `pr-body` fallback branch. The closing-refs and branch-name branches MAY surface draft PRs (because those PRs are authoritatively the issue's PR); when `runMerge` receives a draft, it MUST fail with reason `pr-is-draft` and emit `resolved PR #N via <method> — draft, cannot merge` rather than the current opaque `gh pr merge failed: still a draft`. | P1 | Sub-defect #2 in the finding. |
| FR-006 | `PrLinker.linkPrToIssue` (`packages/orchestrator/src/worker/pr-linker.ts`) MUST consult `closingIssuesReferences` (via `gh pr view --json closingIssuesReferences` on the PR) as its first strategy, ahead of both `parsePrBody` and `parseBranchName`. When present and unambiguous, the resulting `PrToIssueLink.linkMethod` MUST be `'closing-refs'`. | P1 | Precedence fix lands in the shared link logic, not merge-only. |
| FR-007 | The `PrToIssueLink['linkMethod']` union in `packages/orchestrator/src/types/monitor.ts` MUST gain a `'closing-refs'` variant, and every existing consumer (log lines, telemetry, tests) MUST accept it. | P1 | Type-level plumbing for FR-006. |
| FR-008 | Failure exit paths in `runMerge` (unresolved, wrong-state, missing-label, checks-failing, ambiguous, draft) MUST include the resolved PR number and `linkMethod` in the emitted JSON payload (via `buildFailingCheckPayload` or an equivalent field on the failing-check schema). | P2 | Downstream: auto-mode's `finding` records now carry enough info to identify the wrong-PR class without a bogus-ref replay. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Wrong-PR resolution rate in P3-style fixtures (one closing-ref PR + N draft siblings whose bodies mention the issue) | 0 across the regression suite | Fixture: issue with `closingIssuesReferences=[PR#23]` plus 3 draft siblings whose bodies say `depends on #<issue>` — `resolveIssueToPRRef` must return PR#23. |
| SC-002 | Merge-failure output naming the resolved PR | 100% of failure exit paths include `resolved PR #N via <method>` | Grep stdout of every failing test in `merge.test.ts` for `resolved PR #\d+ via (closing-refs|branch-name|pr-body)`. |
| SC-003 | Draft-PR merge-attempt rate | 0 (drafts never reach `gh pr merge`) | New fixture: draft PR returned by closing-refs → runMerge fails with `pr-is-draft`, `gh.mergePullRequest` mock never called. |
| SC-004 | Ambiguous `pr-body` fallback failure | Exit code 1, no merge attempted, stdout lists all candidate PR numbers | Fixture: no closing refs, no branch-name match, two non-draft PRs whose bodies mention the issue → verb fails loud, both PR numbers appear in output. |
| SC-005 | `PrLinker` correctness on the same P3 topology | `linkMethod === 'closing-refs'` when closing refs exist and are unique | `pr-linker.test.ts` fixture: a PR whose body says `depends on #9` but whose `closingIssuesReferences=[{number: 4}]` → links to issue #4 via `closing-refs`, not to #9 via `pr-body`. |
| SC-006 | Zero regressions in existing merge/link fixtures | 100% of pre-existing tests in `merge.test.ts` and `pr-linker.test.ts` pass unchanged | CI. |

## Assumptions

- GitHub's `closingIssuesReferences` (Development link) is populated by our workers on every PR they open — evidence: the finding notes it was "populated, unique, and correct for every PR in the repo." If a worker-produced PR ever lacks the Development link, the branch-name fallback (FR-002) catches it, so the fix is safe even in that edge case.
- The `gh` CLI exposes `closingIssuesReferences` via `gh pr view --json closingIssuesReferences` and the reverse direction via `gh issue view --json closedByPullRequestsReferences` (already used in `resolveIssueToPRRef`'s current fallback path — this issue promotes it from fallback to primary).
- The current `linked:<N>` search behaviour that surfaces sibling drafts is not GitHub bug-fixable; the fix is purely client-side query selection.
- `PrFeedbackMonitorService` already treats `PrLinker.linkPrToIssue`'s output as authoritative; strengthening the resolver upgrades that service automatically without touching its own code.
- No cross-repo issue↔PR links exist in scope; `closingIssuesReferences` is queried within the same repo the merge verb was invoked against.

## Out of Scope

- Cross-repo issue-PR linking (workflow currently constrains PR and issue to the same repo; a multi-repo topology is a separate concern).
- Any rewrite of the `pr-body` closing-keyword parser itself (`Closes #N`, etc.) — its logic is fine; the issue is precedence, not parsing.
- Fixing the *upstream* GitHub `linked:<N>` search behaviour — this spec sidesteps it, not resolves it.
- A general-purpose "loud logging" audit across other cockpit verbs — the failing-check payload change (FR-008) is scoped to `runMerge` only in this issue.
- Retroactively re-linking already-merged PRs whose historical `linkMethod` was `pr-body` — new links land through the new precedence; old records are frozen.

---

*Generated by speckit*
