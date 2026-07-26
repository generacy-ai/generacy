# Tasks: PR-feedback fixer consumes review bodies

**Input**: Design documents from `/specs/1047-problem-orchestrator-s-pr/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Implemented

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 / US2 / US3)

## Phase 1: Wire types + GitHub client extension (workflow-engine)

- [X] **T001** [US1] Add `ReviewSubmissionState` union (`'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'`) and `Review` interface to `packages/workflow-engine/src/types/github.ts` next to the existing `ReviewThread` declaration (~:112). Field shape per `data-model.md § Review`: `{ id: number; user: { login: string }; body: string; state: ReviewSubmissionState; submittedAt: string }`. Load-bearing invariants: `id` is the FR-008 acknowledgment key; `user.login` is the Q3 per-author supersession key; `submittedAt` is the per-author "newest" tie-breaker.

- [X] **T002** [US1] Add `listReviews(owner: string, repo: string, prNumber: number): Promise<Review[]>` to the `GitHubClient` interface in `packages/workflow-engine/src/actions/github/client/interface.ts` next to `getPRReviewThreads` (~:216). JSDoc must document: (a) fetches submissions only — inline threads use `getPRReviewThreads`; (b) `state` filter is caller-side; (c) throws `GhAuthError` on 401/403, `Error` on any other non-zero exit (mirrors `getPRReviewThreads` at `gh-cli.ts`).

- [X] **T003** [US1] Implement `listReviews` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts` via `gh api /repos/{owner}/{repo}/pulls/{prNumber}/reviews?per_page=100`. Requirements: (a) paginate on `link: <...>; rel="next"` header (single page is the common case; realistic PR review counts stay under 100); (b) map REST field names to camelCase (`submitted_at` → `submittedAt`); (c) parse `user.login` and drop other `user` fields; (d) surface `state` verbatim (uppercase enum); (e) do NOT filter here — every state is returned. Follow the same `gh api` invocation shape as sibling REST methods (`postPrComment`, `listPrCommentBodies`).

## Phase 2: Pure functions — parsers and gate (orchestrator)

<!-- Phase boundary: Phase 1 wire types must exist before parsers can import them -->

- [X] **T004** [P] [US3] Create `packages/orchestrator/src/worker/pr-feedback-body-parser.ts` exporting `parseReviewBody(review: Review): ParsedReview`. Contract per `data-model.md § ParsedReview / § ParsedFinding`: absent `<!-- generacy-cockpit:unanchored-findings -->` marker → `{ reviewId, reviewer, submittedAt, findings: [] }`. Marker present → iterate `### Finding <n>` sub-headings in order, `index` is 1-based ordinal. Under each finding, look for `**Files:** path/one, path/two` line → split on `,`, trim each, drop empties → `{ files, hasFilesLine: true }`. Missing `**Files:**` line → `{ files: [], hasFilesLine: false }` (fail-open per FR-005). No path canonicalization (GitHub paths are case-sensitive, workspace-relative). See `contracts/unanchored-block-parse.md`.

- [X] **T005** [P] [US2] Create `packages/orchestrator/src/worker/pr-feedback-ack-parser.ts` exporting `parseAcknowledgedFindings(commentBodies: string[]): AcknowledgedFindings` (returns `ReadonlySet<string>` keyed by `${reviewer}:${reviewId}:${index}`). Contract per `data-model.md § AcknowledgedFindings`: filter bodies containing `<!-- generacy-cockpit:body-findings-unaddressed -->` marker; take the **last** by array order (chronological — matches `listPrCommentBodies` return order); parse the enumeration under `### Unaddressed findings` with regex `^- ` + backtick + `([^`]+)` + backtick + ` review #(\d+) finding (\d+)`; ignore the trailing `(files: ...)` decoration (identity is `(reviewer, reviewId, index)`); empty/malformed/no-match → empty set (fail-open). See `contracts/body-findings-unaddressed-marker.md`.

- [X] **T006** [P] [US2] Create `packages/orchestrator/src/worker/pr-feedback-body-gate.ts` exporting `evaluateBodyGate(input: { parsedReviews: ParsedReview[]; commitTouchedFiles: ReadonlySet<string>; acknowledged: AcknowledgedFindings }): GateResult`. Semantics per `data-model.md § Gate-evaluator contract` (FR-003 + Q3 + Q5 + Q6): (1) group by `reviewer`, keep only max-`submittedAt` per group (per-author newest); (2) filter each retained review's `findings` to `hasFilesLine === true`; (3) drop findings whose key is in `acknowledged`; (4) a finding is *satisfied* iff at least one path in `files` is a member of `commitTouchedFiles`; (5) all remaining must be satisfied for `{ satisfied: true }`, else `{ satisfied: false, unaddressed: UnaddressedFinding[] }` listing every unsatisfied one with `namedFiles`. Zero-input / all-filtered → `{ satisfied: true }` trivially. Cross-author does NOT supersede (bot vs human are distinct logins).

## Phase 3: Unit tests for pure functions

<!-- Phase boundary: implementations must exist to be tested -->

- [X] **T007** [P] [US3] Create `packages/orchestrator/src/__tests__/pr-feedback-body-parser.test.ts` covering: (a) marker absent → empty findings; (b) marker present, zero `### Finding` sub-headings → empty findings; (c) marker present, single finding with `**Files:**` → `hasFilesLine: true`, correct paths; (d) marker present, single finding **without** `**Files:**` → `hasFilesLine: false`, empty files (older-producer compatibility per FR-005); (e) multi-finding with mixed shapes; (f) `**Files:**` line splits on comma + trims + drops empties; (g) 1-based `index` ordering matches heading appearance.

- [X] **T008** [P] [US2] Create `packages/orchestrator/src/__tests__/pr-feedback-ack-parser.test.ts` covering: (a) empty input → empty set; (b) no matching marker → empty set (fail-open); (c) single marker comment with N enumeration rows → N keys; (d) multiple marker comments → newest (last by array order) wins, earlier ones ignored; (e) round-trip parse of the exact marker shape from `contracts/body-findings-unaddressed-marker.md`; (f) key format `${reviewer}:${reviewId}:${index}` matches gate's expectation.

- [X] **T009** [P] [US2] Create `packages/orchestrator/src/__tests__/pr-feedback-body-gate.test.ts` covering: (a) empty `parsedReviews` → `{ satisfied: true }`; (b) per-author newest — same author two submissions, only newest gates; (c) cross-author non-supersession — reviewer A's finding stays gating when reviewer B posts newer (Q3 regression); (d) per-finding AND — review with findings (A, B, C), commits touch only A → `{ satisfied: false, unaddressed: [B, C] }` (SC-003 regression); (e) `hasFilesLine: false` contributes zero constraints (FR-005); (f) ack-set exclusion — finding in `acknowledged` does not gate; (g) `namedFiles` in `unaddressed` is non-empty by construction.

## Phase 4: Handler wiring (orchestrator)

<!-- Phase boundary: parsers/gate must be tested-and-green before handler consumes them -->

- [X] **T010** [US1] [US2] Modify `packages/orchestrator/src/worker/pr-feedback-handler.ts` fetch block (~:141-235): after the existing `getPRReviewThreads` call, additionally call `github.listReviews(owner, repo, prNumber)`, filter to `state ∈ {CHANGES_REQUESTED, COMMENTED}` and `body !== ''`, parse each via `parseReviewBody`, cache the parsed list. Wrap the new REST call in the same `try/catch` shape as the existing thread fetch (`GhAuthError` → surface; other errors → log-and-continue-with-empty-list to preserve inline-thread flow).

- [X] **T011** [US1] Modify `packages/orchestrator/src/worker/pr-feedback-handler.ts` prompt-assembly (~:272-273): extend `unresolvedComments` with review-body items shaped as `{ id: review.id, path: undefined, line: undefined, body: 'review body (no file anchor):\n\n' + review.body, author: review.user.login }`. `buildFeedbackPrompt` at `:435-465` already renders these as `'general comment'` — no renderer change. Order is not load-bearing (FR-006).

- [X] **T012** [US2] Add private helper `getCommitTouchedFiles(checkoutPath: string, baseSha: string, headSha: string): Promise<Set<string>>` on `PrFeedbackHandler` via `executeCommand('git', ['diff', '--name-only', `${baseSha}..${headSha}`], { cwd: checkoutPath })`. Follow the shape of `getHeadShortSha` (~:726-739). Handles multi-commit cycles (FR-013 partial-completion at `:571-578`) — a single-commit view (e.g. `getStatus()`) would false-block.

- [X] **T013** [US2] Modify `packages/orchestrator/src/worker/pr-feedback-handler.ts` post-commit branch (~:315-398): after `commitAndPushChanges`, compute `commitTouchedFiles` via T012, fetch existing comment bodies via `github.listPrCommentBodies` (one call, reused for both ack-parse and Disposition C idempotency), parse acknowledgment set via `parseAcknowledgedFindings`, evaluate the gate via `evaluateBodyGate`. On `satisfied: false` → **Disposition C** (T014). On `satisfied: true` → fall through to existing reply/resolve/happy-path branch unchanged. Preserve the `agent:in-progress` clearing behavior via the existing `finally` (#926 pattern).

- [X] **T014** [US2] Implement Disposition C inside `pr-feedback-handler.ts`: (a) apply `blocked:body-finding-unaddressed` label via `github.addLabels`; (b) idempotency-check the fetched comment bodies for the `<!-- generacy-cockpit:body-findings-unaddressed -->` marker before posting (mirror `maybePostUntrustedNotice` at `pr-feedback-monitor-service.ts:435-488`); (c) if not present, `postPrComment` with the exact marker shape from `data-model.md § Marker comment shape` — header comment, human summary, `### Unaddressed findings` list with `- ` + backtick + `<reviewer>` + backtick + ` review #<reviewId> finding <index> (files: ` + backtick + `<file>` + backtick + `, ...)` per entry; (d) skip the reply/resolve loop; (e) exit through the existing `finally`. Distinct from Disposition B (`blocked:stuck-feedback-loop`).

## Phase 5: Integration test

- [X] **T015** [US1] [US2] Create `packages/orchestrator/src/__tests__/pr-feedback-handler-body-flow.test.ts` driving the handler through a stubbed `GitHubClient` + `AgentLauncher` (follow the existing stub pattern in `packages/orchestrator/src/__tests__/`). Scenarios:
  - **SC-001**: body-only finding on a file not in the diff → fixer commit touches that file, cycle advances normally.
  - **SC-002**: same finding text posted inline and posted as body → same edit lands in both cases (parity).
  - **SC-003**: body-only finding, stubbed fixer produces no commits → cycle does NOT advance to Disposition A; Disposition C fires.
  - **SC-004** (positive): body with marker + `**Files:** path/to/foo.md` under Finding 1 → gate uses `path/to/foo.md`.
  - **SC-004** (complement): body with marker but no `**Files:**` line → finding does not gate (FR-005 fallback).
  - **SC-006**: body with two findings (files A, B), stub touches only A → Disposition C, marker comment enumerates Finding 2 (file B) as unaddressed.
  - **SC-007**: post-Disposition-C resume — same reviews, marker comment already present with the two findings → `evaluateBodyGate` treats them as acknowledged, does NOT re-gate; findings still reach the prompt (FR-002).

## Phase 6: Changeset

- [X] **T016** Create `.changeset/1047-pr-feedback-review-bodies.md` with `@generacy-ai/workflow-engine: minor` (new public `listReviews` method + new label vocabulary `blocked:body-finding-unaddressed` per CLAUDE.md § Changesets rule "new label vocabulary in `workflow-engine` → `minor`") and `@generacy-ai/orchestrator: patch` (internal behavior change, no new exports). Single file, both bumps. Description names both packages and both drivers. Verify it is a **newly added** file (`git status --porcelain .changeset/` shows `A`, not `M`) — the changeset-bot gate greps `--diff-filter=A`.

## Phase 7: Verification

- [X] **T017** Run `pnpm --filter @generacy-ai/workflow-engine build && pnpm --filter @generacy-ai/orchestrator build` to catch cross-package type errors on the new `Review` type + `listReviews` method exports.

- [X] **T018** Run `pnpm --filter @generacy-ai/workflow-engine test && pnpm --filter @generacy-ai/orchestrator test` — all seven new/modified test files green (`pr-feedback-body-parser.test.ts`, `pr-feedback-ack-parser.test.ts`, `pr-feedback-body-gate.test.ts`, `pr-feedback-handler-body-flow.test.ts`, plus any pre-existing `pr-feedback-*` tests). No pre-existing test regressions.

- [X] **T019** Grep-verify FR-007 no-op integration: `grep -n "startsWith('blocked:')" packages/orchestrator/src/services/pr-feedback-monitor-service.ts` still matches the bare prefix gate at ~:328-341 with no allow-list — new `blocked:body-finding-unaddressed` label is honored with zero monitor-side change (D6 assumption).

## Dependencies & Execution Order

**Sequential phase boundaries** (must complete in order):
- Phase 1 (workflow-engine) → Phase 2 (orchestrator parsers/gate) → Phase 3 (unit tests) → Phase 4 (handler wiring) → Phase 5 (integration test) → Phase 6 (changeset) → Phase 7 (verification)

**Parallel opportunities within phases**:
- Phase 2: T004, T005, T006 are independent files with no cross-references → run in parallel.
- Phase 3: T007, T008, T009 test different files → run in parallel.
- Phase 4: T010 → T011 → T012 → T013 → T014 are sequential (all modify `pr-feedback-handler.ts` and T013/T014 build on T010–T012). No `[P]` markers.

**Cross-story dependencies**:
- US1 (fetch review bodies → prompt): T001–T003 → T010 → T011.
- US2 (cycle-completion gate + Disposition C): T004 (parser) + T005 (ack) + T006 (gate) → T012 → T013 → T014. Depends on US1 for the fetch surface.
- US3 (marker-block parser): T004 → T007. Feeds US2 via `ParsedReview`.

**Story-ordering rationale**: US1 lands the fetch/prompt surface (unblocks reviewer immediately), US2 layers the correctness gate on top. US3 is the wire-contract adapter that both consume.

## Notes

- No playbook re-pin task required: this issue does NOT edit any file matching `packages/claude-plugin-cockpit/commands/*.md` in this repo (the producer wire contract lives in the separate `agency` repo, tracked as a companion change per spec.md § Out of Scope).
- Producer-side render addition in `agency` (adds `**Files:**` line under each `### Finding <n>`) is a coordinated companion change. This PR is written tolerant of the line's absence (FR-005) — the two changes can ship in either order. Test T007(d) and T015 SC-004(complement) pin the fallback path.
- The unit tests in Phase 3 are the enforcement mechanism for the pure-function contracts. Do NOT weaken assertions during Phase 4 handler wiring to make integration flow easier — if a pure-function contract needs to change, revise the pure-function test first, then the handler.

---

*Generated by speckit*
