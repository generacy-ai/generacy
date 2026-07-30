# Implementation Plan: PR-feedback fixer consumes review bodies

**Feature**: PR-feedback fixer must consume review bodies, not just inline threads
**Branch**: `1047-problem-orchestrator-s-pr`
**Status**: Complete
**Issue**: [#1047](https://github.com/generacy-ai/generacy/issues/1047)

## Summary

Widen the PR-feedback loop's input set from *unresolved inline review threads only* to *unresolved inline threads + review bodies from every non-`APPROVED`/`PENDING`/`DISMISSED` review submitted since the last cycle*. Bodies flow through the existing prompt renderer (which already degrades gracefully when `path`/`line` are missing) so file-outside-the-diff findings reach Claude in the same round they were posted.

Add a per-finding **gate** on top: parse `<!-- generacy-cockpit:unanchored-findings -->` blocks in each new body, extract each `### Finding <n>`'s `**Files:**` list, and require at least one file per finding to be touched by a commit in the cycle before Disposition A (success) is allowed. When any finding's files are untouched, take a new **Disposition C**: apply `blocked:body-finding-unaddressed`, post a marker-keyed top-level PR comment enumerating the unaddressed findings by `(reviewer login, review id, finding index)`, and pause. On operator resume (label removal → new review triggers a re-poll), findings named in the most-recent marker comment are treated as "acknowledged, do not re-gate" — they still reach the prompt for context, they just don't block.

Scope is **consumer-side only**: this repo. The producer-side render addition (`**Files:** path/one, path/two` line under each `### Finding <n>` in `agency/packages/claude-plugin-cockpit`) is a coordinated companion change tracked separately; the parser degrades gracefully when the line is absent so the two changes can ship in either order without regression.

## Technical Context

**Language**: TypeScript (Node.js >=22, ESM)
**Packages touched**:
- `packages/workflow-engine` — add `listReviews` method + `Review` type on `GitHubClient` interface, `GhCliGitHubClient` implementation via `gh api /repos/{owner}/{repo}/pulls/{n}/reviews`. **Minor** bump (new public capability + new label vocabulary `blocked:body-finding-unaddressed`).
- `packages/orchestrator` — extend `PrFeedbackHandler` to fetch review bodies, parse the marker block, merge into the fixer prompt, evaluate the per-finding gate against the cycle's commit file set, and apply Disposition C when appropriate. Extend `PrFeedbackMonitorService` if any re-fetch is needed on the acknowledgment path (spec assumption: none — marker comment is the single source of truth). **Patch** bump (no new exports; internal behavior change on an already-public handler).

**Dependencies**: no new npm deps. Uses existing `gh api`, existing `postPrComment` / `listPrCommentBodies` on `GitHubClient` (interface.ts:247/253).

**Testing**: Vitest, co-located `__tests__/` per existing orchestrator convention.

**GitHub API surface**: `GET /repos/{owner}/{repo}/pulls/{number}/reviews` (REST), consumed via `gh api`. No new auth surface — same `GH_TOKEN` chain the existing thread fetch uses.

**Load-bearing existing hooks**:
- `pr-feedback-monitor-service.ts:328-341` — bare `l.startsWith('blocked:')` skip gate. Confirmed no allow-list; new `blocked:body-finding-unaddressed` is honoured with zero monitor-side change (Q4 answer).
- `pr-feedback-handler.ts:435-465` — `buildFeedbackPrompt` renders `location` as `c.path && c.line ? '${c.path}:${c.line}' : c.path || 'general comment'`. Review bodies with no `path`/`line` degrade to `'general comment'` label; FR-002 satisfied by upstream input, no renderer change.
- `pr-feedback-monitor-service.ts:435-488` — `maybePostUntrustedNotice` pattern: `listPrCommentBodies` marker-grep before `postPrComment`. Disposition C's marker-comment post follows this exact idiom (Q5 rationale).

**Load-bearing NON-hooks** (i.e. things that intentionally do NOT change):
- The monitor's `Case C` path at `pr-feedback-monitor-service.ts:264-285` (`totalUnresolvedThreads === 0 → reset, return false`) precedes the `blocked:*` check. This is what makes FR-008 correct-by-construction: after Disposition C, there is nothing that "re-enters naturally" until a new review adds a new thread. The label-removal semantics assumed by option D of Q6 do not apply. See clarifications Q6 rationale.
- No new watermark / cursor introduced. `grep -rni watermark packages/orchestrator/src` = 0. FR-001's "newer than the last fix cycle" reuses the existing per-PR state (the fact that the handler runs at all means new threads or a new review arrived; the fetch pulls all non-terminal reviews and dedupes by `review.id` against the marker-comment acknowledgment set).

## Project Structure

```
packages/workflow-engine/
├── src/
│   ├── types/
│   │   └── github.ts                              # ADD: `Review` type
│   └── actions/github/client/
│       ├── interface.ts                            # ADD: listReviews(owner, repo, prNumber): Promise<Review[]>
│       └── gh-cli.ts                               # ADD: listReviews impl via `gh api`

packages/orchestrator/
├── src/
│   ├── worker/
│   │   ├── pr-feedback-handler.ts                  # MODIFY: fetch bodies, parse marker, merge into prompt, evaluate gate, Disposition C
│   │   ├── pr-feedback-body-parser.ts              # NEW: pure parser for the unanchored-findings marker block
│   │   ├── pr-feedback-body-gate.ts                # NEW: pure per-finding gate evaluator (findings × commit file set → satisfied/unsatisfied[])
│   │   └── pr-feedback-ack-parser.ts               # NEW: pure parser for the body-findings-unaddressed marker comment (acknowledgment set)
│   └── __tests__/
│       ├── pr-feedback-body-parser.test.ts         # NEW: unit — marker present/absent, with/without **Files:** line, multi-finding
│       ├── pr-feedback-body-gate.test.ts           # NEW: unit — per-finding satisfaction matrix, ack-set exclusion
│       ├── pr-feedback-ack-parser.test.ts          # NEW: unit — round-trip parse of the marker comment shape
│       └── pr-feedback-handler-body-flow.test.ts   # NEW: integration — SC-001, SC-002, SC-003, SC-004, SC-006, SC-007 in the handler under a stubbed GitHubClient

.changeset/
└── 1047-pr-feedback-review-bodies.md               # NEW: workflow-engine minor + orchestrator patch
```

Existing files touched — line pointers for reviewer:
- `packages/workflow-engine/src/actions/github/client/interface.ts:216` (near `getPRReviewThreads`) — add `listReviews`
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — add impl next to existing `getPRReviewThreads` impl
- `packages/workflow-engine/src/types/github.ts:112` (near `ReviewThread`) — add `Review` interface + `ReviewSubmissionState` union
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:141-235` — the review-thread fetch block, extended to also fetch reviews
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:272-273` — `buildFeedbackPrompt` call site, `unresolvedComments` array extended with body items
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:315-327` — Disposition B branch, extended to Disposition C check
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:329-398` — happy-path branch, gated on FR-003 result

## Constitution Check

No `.specify/memory/constitution.md` in the repo. Applied project conventions instead:

- **Changeset (CLAUDE.md rule):** required — this touches `packages/workflow-engine/src/**` (new public method + new label vocabulary) and `packages/orchestrator/src/**` (behavior change). Single `.changeset/1047-pr-feedback-review-bodies.md` file with `@generacy-ai/workflow-engine: minor` + `@generacy-ai/orchestrator: patch`. Rationale for `minor` on workflow-engine per CLAUDE.md's "new label vocabulary in `workflow-engine` → `minor`" rule (`blocked:body-finding-unaddressed`), which coincidentally aligns with the new-public-capability rule for `listReviews`. **Test-only** exemption does NOT apply — real source change on both packages.
- **No new abstractions beyond what the task requires:** the three new files (`body-parser`, `body-gate`, `ack-parser`) are pure-function extractions from what would otherwise be inline blocks in the handler. Justified by the tests: each has a distinct pure input/output surface with per-finding matrices that are painful to test through the handler's fetch/CLI/commit envelope.
- **No error handling beyond boundaries:** the marker parsers are internal — they trust input structure and return `null` / empty arrays for malformed input, degrading to FR-005 behavior. The `listReviews` REST call is a boundary; errors get the same `try/catch` shape as `getPRReviewThreads` at handler.ts:229-235.
- **Fail-open on the marker path:** enforced by FR-005 across parsers + gate. This is a deliberate divergence from the general "trust internal code" rule because the marker contract straddles a repo boundary (producer in `agency`, consumer here) and must tolerate the two-sided rollout.

## Phase Plan

1. **Data + client surface** (workflow-engine)
   - Add `Review` type + `ReviewSubmissionState` union in `types/github.ts`.
   - Add `listReviews(owner, repo, prNumber): Promise<Review[]>` to `GitHubClient` interface.
   - Implement in `gh-cli.ts` via `gh api /repos/{owner}/{repo}/pulls/{n}/reviews` (with pagination — REST returns up to 30 by default, follow `?per_page=100` and paginate if `link` header present, mirroring existing REST patterns; realistic PR review counts stay under 100, so a single page is the common case).
   - Filter is caller-side (the handler): fetch returns everything, handler filters to `submissionState ∈ {CHANGES_REQUESTED, COMMENTED}` per Q2 answer.

2. **Marker parser + ack parser + gate** (orchestrator, pure functions)
   - `pr-feedback-body-parser.ts`: input `reviewBody: string, reviewId: number, reviewerLogin: string` → output `ParsedReview { reviewId, reviewer, findings: ParsedFinding[] }` where `ParsedFinding = { index, files: string[], hasFilesLine: boolean }`. Absent marker → `{ findings: [] }`. Present marker, no `**Files:**` line under a `### Finding <n>` → `{ files: [], hasFilesLine: false }` (this finding does not gate per FR-005).
   - `pr-feedback-ack-parser.ts`: input `commentBodies: string[]` → output `AcknowledgedFindings = Set<string>` keyed by `${reviewer}:${reviewId}:${index}`. Parses the newest `<!-- generacy-cockpit:body-findings-unaddressed -->` marker comment (there may be several across cycles; take the last one by comment order — the monitor's `listPrCommentBodies` returns in chronological order per its existing usage).
   - `pr-feedback-body-gate.ts`: input `parsedReviews: ParsedReview[], commitTouchedFiles: Set<string>, acknowledged: AcknowledgedFindings` → output `GateResult = { satisfied: true } | { satisfied: false, unaddressed: UnaddressedFinding[] }`. Evaluates FR-003 semantics: per-review-author newest, per-finding satisfaction (AND across findings), findings with `hasFilesLine: false` contribute zero constraints, findings in `acknowledged` do not gate.

3. **Handler wiring**
   - After the existing thread fetch at `pr-feedback-handler.ts:156-217`, additionally call `github.listReviews(owner, repo, prNumber)`, filter to `{CHANGES_REQUESTED, COMMENTED}`, filter to bodies non-empty, and parse each via `pr-feedback-body-parser.ts`. Cache the parsed list.
   - Convert each non-empty body into the shape `buildFeedbackPrompt` expects: `{ id: review.id, path: undefined, line: undefined, body: 'review body (no file anchor):\n\n' + review.body, author: review.user.login }`. Concatenate to `unresolvedComments`.
   - Fetch existing PR comment bodies via `github.listPrCommentBodies` (single call, reused for both the ack parse and Disposition C idempotency).
   - After `commitAndPushChanges`, compute `commitTouchedFiles: Set<string>` from `git diff --name-only <baseRef>..HEAD` scoped to the just-pushed commit range. Existing handler doesn't have this helper — add `getCommitTouchedFiles(checkoutPath, baseSha, headSha)` on the handler (private) using `executeCommand` (same shape as `getHeadShortSha`).
   - Evaluate the gate. On `satisfied: false`: apply `blocked:body-finding-unaddressed`, post the marker-keyed PR comment via `postPrComment` (idempotent via `listPrCommentBodies` marker check), skip the reply-and-resolve loop, exit through the existing `finally` (which clears `agent:in-progress` per the #926 pattern).
   - On `satisfied: true`: fall through to the existing reply/resolve/happy-path branch unchanged.

4. **Tests**
   - Unit tests for each pure function against the wire fixtures in `contracts/`.
   - Integration test for the handler under a stubbed `GitHubClient` that returns preset thread + review lists, asserting: SC-001 (body-only finding produces edit), SC-002 (inline vs body parity), SC-003 (no false-complete on unaddressed body), SC-004 (marker with `**Files:**` gates; marker without does not), SC-006 (partial-progress lands Disposition C and enumerates the unaddressed finding), SC-007 (post-Disposition-C resume with same reviews does not re-gate the acknowledged findings).

5. **Changeset**
   - `pnpm changeset` (or hand-write) → `.changeset/1047-pr-feedback-review-bodies.md` naming both packages with the bumps above.

## Risks & mitigations

- **Producer-side render lag**: agency-side render addition may not ship before this. Mitigated by FR-005 fail-open — absent `**Files:**` → no gate → today's behavior preserved on that finding. Body still reaches the prompt (FR-002). Test SC-004's complement pins this.
- **Approver-with-nit noise**: Q2 answer excludes `APPROVED` from the fetch; verified against `agency/specs/422-summary-auto-md-s/contracts/request-changes-post.md § Field rules`. If a human approver leaves an `APPROVED` review with body nits, those bodies are intentionally dropped — matches "review = things I want fixed before this merges" convention.
- **Cross-cluster label collision**: `blocked:body-finding-unaddressed` is a new label. The monitor's `l.startsWith('blocked:')` gate honors it without registration (Q4/FR-007). No allow-list to update, no cross-repo change needed.
- **Superseded-review false-clear**: Q3 answer (per-author newest) prevents a human reviewer's later APPROVED-only submission from wiping the bot's still-unaddressed body findings. Test in `pr-feedback-body-gate.test.ts` pins this — two reviews by two authors, only the newest-per-author gates, cross-author does not.
- **Ack-set growth**: over time, a long-lived PR can accumulate many acknowledged findings. Not a memory concern (the set is rebuilt from marker comments each cycle) but a UX concern — the marker comment can get long. Out of scope for this fix; document in quickstart.

## Next step

`/speckit:tasks` to generate the task list from this plan.

---

*Generated by speckit*
