# Implementation Plan: answer-scanner + clarify-resume `viewerDidAuthor` migration

**Feature**: answer-scanner never trusts App-identity clusters' own posts (botLogin unresolvable, viewerDidAuthor absent) — cockpit auto dead-ends at every clarification gate
**Branch**: `910-found-during-cockpit-v1`
**Status**: Complete

## Summary

Extend #878's `viewerDidAuthor` mechanism from the pr-feedback surface to the answer-scanner and clarify-resume surfaces. On App-identity clusters (installation-token auth), the `resolveBotLoginFromEnv()` chain returns `undefined` (no scaffolder writes `CLUSTER_GITHUB_USERNAME`/`GH_USERNAME`) and comment authors evaluate at tier `NONE`, so cluster-authored answer comments are rejected as untrusted at the clarification answer-scanner surface. This blocks cockpit auto's D.1 contract at the highest-frequency gate.

Fix mirrors the #878 shape exactly: add sibling client method `getIssueCommentsWithViewerAuth()` (GraphQL, populates `viewerDidAuthor` per comment), migrate the two named surfaces, extend the `comment-trust.ts:111` warn to both migrated surfaces, and add a permanent regression test enforcing #51's question-marker exclusion ordering.

## Technical Context

- **Language**: TypeScript, Node.js >=22 (ESM)
- **Packages touched**:
  - `packages/workflow-engine/` — client interface + `GhCliGitHubClient`, `comment-trust.ts`, `clarify.ts`
  - `packages/orchestrator/` — `clarification-poster.ts` (`integrateClarificationAnswers`)
- **Dependencies**: no new runtime deps. GraphQL query executed via existing `executeGh(['api', 'graphql', ...])` helper.
- **Testing**: vitest. Fixtures in `packages/workflow-engine/src/security/__tests__/comment-trust.test.ts`, `packages/orchestrator/src/worker/__tests__/clarification-poster-trust.test.ts`, `packages/workflow-engine/src/actions/builtin/speckit/operations/__tests__/clarify-trust.test.ts`.
- **Dependency ordering**: #51 (question-marker exclusion via `isQuestionComment`) MUST be merged before this feature (spec §Ordering warning + FR-007). This PR blocks if #51 slips.

## Project Structure

### Files to modify

```
packages/workflow-engine/src/
  actions/github/client/
    interface.ts                            # add getIssueCommentsWithViewerAuth() method signature
    gh-cli.ts                               # GhCliGitHubClient implementation (mirrors getPRReviewThreads())
  security/
    comment-trust.ts                        # extend line ~111 warn to answer-scanner + clarify-resume surfaces (FR-004)
  actions/builtin/speckit/operations/
    clarify.ts                              # buildTrustedIssueCommentsBlock swaps getIssueComments → getIssueCommentsWithViewerAuth (FR-003)

packages/orchestrator/src/worker/
  clarification-poster.ts                   # integrateClarificationAnswers swaps getIssueComments → getIssueCommentsWithViewerAuth + retry-once wrapper (FR-002, FR-010)
```

### Files to add (tests + fixtures)

```
packages/workflow-engine/src/actions/github/client/__tests__/
  gh-cli-get-issue-comments-with-viewer-auth.test.ts    # unit test for the new client method: GraphQL query shape, response mapping, error surface

packages/workflow-engine/src/security/__tests__/
  comment-trust.test.ts                                 # extend: warn fires on answer-scanner + clarify-resume when viewerDidAuthor absent (SC-006)

packages/orchestrator/src/worker/__tests__/
  clarification-poster-viewer-auth.test.ts              # App-auth fixture: self-authored ingested; personal-auth fixture unchanged; third-party rejected; question-marker excluded (SC-001..SC-005, SC-009)
  clarification-poster-graphql-failure.test.ts          # retry-once + fail-closed; asserts NO REST fallback call (SC-008)

packages/workflow-engine/src/actions/builtin/speckit/operations/__tests__/
  clarify-trust-viewer-auth.test.ts                     # App-auth fixture: cluster comment in trusted block; third-party excluded (US2 acceptance)
```

### Files NOT touched (unchanged callers)

```
packages/workflow-engine/src/actions/epic/update-status.ts       # keeps getIssueComments() (no trust evaluation)
packages/workflow-engine/src/actions/workflow/update-stage.ts    # keeps getIssueComments() (no trust evaluation)
```

## Design Decisions (from clarifications)

- **Q1 → A** (FR-004): extend `viewerDidAuthor absent` warn to both migrated surfaces. On post-migration GraphQL paths the field is structurally required; absence is a shape-drift alarm. Zero steady-state noise.
- **Q2 → A** (FR-001): sibling client method `getIssueCommentsWithViewerAuth()`, mirroring #878's `getPRReviewThreads()`. Unrelated callers (`epic/update-status.ts`, `workflow/update-stage.ts`) keep REST `getIssueComments()` unchanged; one return shape per method; wrong-method trap is caught loudly at runtime by Q1-A's extended warn.
- **Q3 → B** (FR-007): PR-level check (predicate exists + is invoked before answer parsing on the migrated path) + permanent regression test (trusted self-authored comment carrying `<!-- generacy-clarifications:<id> -->` marker → `integrated == 0`). Test makes #51 reverts fail CI forever. No runtime guard (illusory in compiled TS).
- **Q4 → B** (FR-010): retry once against GraphQL on transient failure; fail closed on second failure. Never fall back to REST (silently reproduces the pre-fix defect). Matches `comment-trust`'s fail-closed posture.
- **Q5 → B** (FR-008): if grep-audit surfaces additional self-trust-evaluating `getIssueComments()` callers, spin out per-surface follow-up issues (do not bundle). Expected audit result is zero surprises. Each defect-class surface has its own edge cases (dedupe wedging, `[bot]` normalization, by-design absence).

## Constitution Check

`.specify/memory/constitution.md` does not exist in this repo. No project-level governance principles gate this change beyond CLAUDE.md conventions (single atomic PR, spec-driven flow, no ambient CLAUDE.md updates from `/plan`).

Constraints from CLAUDE.md that apply:
- `specs/<feature>/stack.md` is not updated by `/plan` (per #899).
- Standard PR flow: implement + push + review + merge via cockpit; no `--no-verify` on hooks.
- No new deps beyond what's already vendored in `packages/workflow-engine`.

## Implementation Sequence (high-level)

1. **Client method**: add `getIssueCommentsWithViewerAuth()` to interface + implement in `GhCliGitHubClient` using the same GraphQL/`executeGh` pattern as `getPRReviewThreads()`. Query targets `repository.issue(number).comments(first: 100).nodes { databaseId body author { login } authorAssociation createdAt updatedAt viewerDidAuthor }`. Response mapping normalizes to `Comment[]` with `viewerDidAuthor` populated when non-null. Pagination via `pageInfo` if needed.
2. **`comment-trust.ts` warn scope**: change the surface guard at line 111 from `surface === 'pr-feedback'` to `surface === 'pr-feedback' || surface === 'answer-scanner' || surface === 'clarify-resume'` (i.e. all migrated surfaces). Update the surrounding comment. `Q1 → A`.
3. **Migrate `clarify.ts`** (`buildTrustedIssueCommentsBlock`): swap `client.getIssueComments(...)` → `client.getIssueCommentsWithViewerAuth(...)`. No other logic changes; trust decision continues to run per-comment.
4. **Migrate `clarification-poster.ts`** (`integrateClarificationAnswers`): swap `github.getIssueComments(...)` → `github.getIssueCommentsWithViewerAuth(...)`, wrap in a retry-once helper that fails closed on second failure (no REST fallback). Keep `postUntrustedAnswerExplainers` fetch (line ~652 `existingComments: comments`) using the SAME already-fetched GraphQL comments (no second call).
5. **Regression tests**: add fixtures for App-auth (no env, GraphQL `viewerDidAuthor: true` → trusted), personal-auth (env set, viewerDidAuthor absent → trusted via bot-login), third-party (`viewerDidAuthor: false`, tier NONE → untrusted), question-marker (self-authored + carries `<!-- generacy-clarifications:<id> -->` → `integrated == 0`), and GraphQL-failure (mock fails once → retry succeeds → ingested; fails twice → warn logged, no ingestion, no REST call).
6. **Grep-audit** (FR-008): confirm `epic/update-status.ts` and `workflow/update-stage.ts` are the only other `getIssueComments()` callers and do NOT self-trust-evaluate. Any surprise: spin out per-surface issue (do not bundle).
7. **PR-level check** (FR-007): in tasks.md, add an explicit verification step that `isQuestionComment()` is imported and called at `clarification-poster.ts:643` (or equivalent) on the migrated fetch path before `parseAnswersFromComments`.

## Risks

- **GraphQL cost**: one extra `gh api graphql` invocation per gate check. Frequency is bounded by the phase loop (one fetch per poll cycle per issue). No expected rate-limit issue.
- **Pagination**: existing REST call uses `--paginate`. GraphQL `first: 100` matches the `getPRReviewThreads()` precedent. If clarification threads exceed 100 comments, need pageInfo. Spec doesn't call this out; existing precedent tolerates the cap. Same posture here.
- **#51 dependency**: if #51 slips, FR-007's permanent regression test still lands, but merge-order must hold — the tasks list includes the verification step so the implement phase fails cleanly if `isQuestionComment` is absent from the codebase.
- **Wrong-method trap**: a future trust-evaluating surface that calls `getIssueComments()` gets the extended `viewerDidAuthor absent` warn at runtime (Q1-A composes with Q2-A). Acceptable — visible defect signal is exactly the goal.

## Key Sources / References

- Precedent PR: #878 (`getPRReviewThreads()` GraphQL migration for pr-feedback surface)
- Defect-class lineage: #869 → #874 → #878 → this issue (#910)
- Dependency: #51 (question-marker exclusion `isQuestionComment` — must merge first)
- Spec: `specs/910-found-during-cockpit-v1/spec.md`
- Clarifications: `specs/910-found-during-cockpit-v1/clarifications.md`

## Next Step

`/speckit:tasks` to generate the ordered task list from this plan.
