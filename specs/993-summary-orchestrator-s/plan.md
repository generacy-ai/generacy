# Implementation Plan: Clarification-answer monitor stops resuming on its own bot comments

**Feature**: The `ClarificationAnswerMonitorService` enters an infinite ~5-minute resume loop on any issue parked at `waiting-for:clarification` + `agent:paused` because it mistakes the cluster's own `generacy-ai[bot]` comments (spec-summary, `<!-- speckit-stage:clarification -->`, etc.) for human answers. Snappoll 2026-07-18: P3 issues #5–#8 were re-enqueued every ~302s until #6 and #7 crashed to `failed:clarify` + `agent:error`.
**Branch**: `993-summary-orchestrator-s`
**Status**: Complete

## Summary

Three surgical, spec-driven changes plug the resume-predicate hole so a `waiting-for:clarification` issue whose only comments are cluster/bot-authored stays parked — and a real human answer still resumes it on the next poll:

1. **Positive answer predicate** (FR-001, FR-003) in `ClarificationAnswerMonitorService.processClarificationAnswerEvent`. Replace the current "any comment that isn't a question-marker" negative with a strict positive: a comment counts as an answer only if it is (a) marker-carrying (`CLARIFICATION_ANSWER_MARKERS`) **and** its author login is not `[bot]`-suffixed, **or** (b) authored by a login that is neither `[bot]`-suffixed nor cluster-self, and `isTrustedCommentAuthor` returns trusted. A `[bot]` marker never rescues — cluster-relayed cockpit answers flow through the `completed:clarification` label / LabelMonitorService path, not this monitor (Q1=A).

2. **Newness anchor** (FR-004): the candidate answer's `created_at` must be **strictly** greater than the newest `created_at` among comments matching `CLARIFICATION_QUESTION_MARKERS`. `updated_at` is never consulted. Anchored to `created_at` only, because the bot **updates** the ever-present `<!-- generacy-stage:specification -->` summary as phases progress — an `updated_at`-tolerant check would re-satisfy newness on every poll and reopen the loop (Q4=A). If there is no question-marker comment yet on the issue, the predicate short-circuits to false (there is nothing to answer).

3. **`MACHINE_MARKERS` family match** (FR-005) in `packages/orchestrator/src/worker/clarification-markers.ts`. `matchMachineMarker` / `commentCarriesMachineMarker` swap from an enumerated prefix list to a **family** match on `<!-- generacy-stage:` and `<!-- speckit-stage:` (any suffix), retaining the enumerated entries for the non-stage families (question markers via `CLARIFICATION_QUESTION_MARKERS`, `generacy-cockpit:manual-advance`, `generacy-clarification-answers:`, `generacy-untrusted-answer:`, `generacy-clarification-parse-failures:`). This kills the whole enumeration-drift class — `<!-- speckit-stage:clarification -->` (the demonstrably-missed prefix) plus every future engine-authored stage marker gets skipped without a code change. The two families are strictly engine-authored, so the match is safe (Q3=C). It does **not** catch the question-batch prefixes (`generacy-clarifications:`, `generacy-cockpit:clarifications-batch:`), so the FR-004 anchor set is unaffected.

The `isTrustedCommentAuthor` helper is **not** changed — its bot-login match at `packages/workflow-engine/src/security/comment-trust.ts:104-110` compares against `ctx.botLogin` (the cluster's App account name). The bug is that the monitor's `[bot]`-suffix filter is *upstream* of `isTrustedCommentAuthor` — we fail-fast on `[bot]` authors before delegating trust so a `[bot]` login never enters the trust matrix in the first place. FR-002's `generacy-ai[bot]` self-recognition is a log label, not a behavior branch; the FR-001 suffix filter already routes every fork/staging App-bot identically (Q5=A).

## Technical Context

- **Language / runtime**: TypeScript, Node ≥22, ESM
- **Primary package**: `@generacy-ai/orchestrator` (`packages/orchestrator/`)
- **Test framework**: Vitest (existing suites: `packages/orchestrator/src/services/__tests__/`, `packages/orchestrator/src/worker/__tests__/`)
- **New dependencies**: none. Reuses:
  - `commentCarriesMachineMarker`, `matchMachineMarker` and the answer-marker helpers from `packages/orchestrator/src/worker/clarification-markers.ts`
  - `CLARIFICATION_QUESTION_MARKERS` (unchanged) as the FR-004 anchor set
  - `isTrustedCommentAuthor` (unchanged) for the FR-003(b) trusted-human branch — the monitor still delegates author-trust after the bot filter
  - `Comment.created_at`, `Comment.author` from `packages/workflow-engine/src/types/github.ts` (existing GraphQL fetch already populates both)
- **Type extensions**: none. `Comment` already carries the fields the predicate reads (`author`, `created_at`, `body`, `viewerDidAuthor`).
- **New pure helpers** (private, co-located with the monitor):
  - `isBotAuthoredLogin(author: string): boolean` — `.trim().toLowerCase().endsWith('[bot]')`. Case-insensitive; whitespace-tolerant. Same normalization shape as `normalizeLogin` in `comment-trust.ts:49-51`, without stripping the suffix (we're *detecting* it, not removing it).
  - `latestQuestionCommentCreatedAt(comments: Comment[]): string | undefined` — scans for the newest `created_at` (lexicographic ISO-8601 comparison — GitHub timestamps are strictly RFC 3339 zulu, so string compare == time compare) among comments where `matchClarificationQuestionMarker(body) !== undefined`. Returns `undefined` when there is no question comment on the issue.
- **Changeset**: `.changeset/993-clarification-answer-bot-filter.md`, `patch` bump for `@generacy-ai/orchestrator`. Defect fix (`workflow:speckit-bugfix`); no new public export surface. Aligns with CLAUDE.md changeset rules.

## Project Structure

Files to modify:

```
packages/orchestrator/src/
├── services/
│   └── clarification-answer-monitor-service.ts       # positive answer predicate + newness anchor + [bot] filter (FR-001, FR-003, FR-004)
├── worker/
│   └── clarification-markers.ts                      # MACHINE_MARKERS family match on generacy-stage: / speckit-stage: (FR-005)
└── ... (no other files modified — this is a two-file behavior fix)

packages/orchestrator/src/services/__tests__/
└── clarification-answer-monitor-service.test.ts      # regression + acceptance-criteria coverage (SC-001, SC-002, SC-003)

packages/orchestrator/src/worker/__tests__/
└── clarification-markers.test.ts                     # extend: family-match cases for future stages (SC-004)

.changeset/
└── 993-clarification-answer-bot-filter.md            # patch bump (defect fix)
```

New spec artifacts (this planning phase):

- `specs/993-summary-orchestrator-s/plan.md` (this file)
- `specs/993-summary-orchestrator-s/research.md`
- `specs/993-summary-orchestrator-s/data-model.md`
- `specs/993-summary-orchestrator-s/contracts/monitor-predicate-contract.md`
- `specs/993-summary-orchestrator-s/contracts/machine-markers-contract.md`
- `specs/993-summary-orchestrator-s/quickstart.md`

Out of scope (per spec §"Out of Scope"):

- Fork/staging App-bot login discovery — FR-001's generic `[bot]`-suffix rule already routes every App-bot to the same outcome; the FR-002 specificity is a log label only (Q5=A).
- Runtime discovery of the App login via `GET /repos/:owner/:repo/installation` (Q5=A).
- Config knob for the cluster's App login (Q5=A).
- `updated_at`-based newness for edit-based answers (Q4=A).
- Any change to the `completed:clarification` / LabelMonitorService cluster-relayed-answer path.
- Any change to the `isTrustedCommentAuthor` helper (`packages/workflow-engine/src/security/comment-trust.ts`) — the bug lives in the monitor's negative predicate, not in the trust helper.
- Poll-gate / adaptive polling changes (see #987 / #953) — same service, different logic.

## Constitution Check

No `.specify/memory/constitution.md` in the tree — check skipped. Adhered to project CLAUDE.md conventions:

- **Changeset gate**: `.changeset/993-clarification-answer-bot-filter.md` added (`patch` — defect fix per `workflow:speckit-bugfix`). Non-test-only diff under `packages/orchestrator/src/` requires a changeset per CLAUDE.md.
- **No premature abstraction**: `isBotAuthoredLogin` and `latestQuestionCommentCreatedAt` are file-local pure functions in the monitor module. They're not re-exported. If a second caller ever needs the same predicate (e.g. a future `PrFeedbackMonitorService` bot filter), the promotion is one line — but promoting speculatively spreads blast radius.
- **No comments unless load-bearing**: two comments earn their keep and match the pattern used in siblings like #987. (1) One line above the `isBotAuthoredLogin` filter site, noting that `[bot]`-authored marker comments intentionally fail the predicate and cluster-relayed answers flow through `completed:clarification` instead — future readers will otherwise try to "fix" this by letting bot markers count. (2) One line above the `latestQuestionCommentCreatedAt` call, noting `created_at`-only (not `updated_at`) is intentional and replay-safe. Everything else is dropped.
- **No feature flags**: the fix corrects a bug that fabricates `failed:clarify` / `agent:error` state. There is no gated rollout — the old behavior is broken and has no legitimate consumer.

## Key Decisions

| # | Decision | Source |
|---|----------|--------|
| 1 | Bot filter is *upstream* of `isTrustedCommentAuthor`. `[bot]`-suffix detection runs before the trust helper is consulted; `[bot]` authors never enter the trust matrix. Rationale: the current bug is that `isTrustedCommentAuthor`'s bot-login match at `comment-trust.ts:104-110` only fires when `ctx.botLogin === normalizeLogin(author)`, which on this cluster is the resolved account (`christrudelpw`) not the App login (`generacy-ai[bot]`). The upstream filter closes that gap without reshaping the trust helper. | FR-001 + evidence (`gh api user` returns `403 Resource not accessible by integration`) |
| 2 | `[bot]`-authored marker comments intentionally **fail** the answer predicate (Q1=A). Cluster-relayed cockpit answers (`generacy-clarification-answers:` marker, authored by `generacy-ai[bot]`) are integrated via the `completed:clarification` label / phase-loop path — the relay applies that label directly, which resumes through LabelMonitorService, NOT this monitor. Letting a bot marker count here would reopen the exact bug. | Q1=A |
| 3 | FR-004 anchor set is `CLARIFICATION_QUESTION_MARKERS` (existing registry, unchanged). Newest-by-`created_at` — no numeric-suffix parsing on `<!-- generacy-clarifications:N -->`, no narrowing to a subset. Robust to any future question-marker family. Iterative clarify cycles: an answer to batch N must beat batch N's timestamp. | Q2=A |
| 4 | `created_at` only, never `updated_at`. Replay-safe and deterministic; blocks the re-trigger vector where the bot updates its own `<!-- generacy-stage:specification -->` summary and advances `updated_at`. The operator's remedy for a missed answer is to post a NEW comment. | Q4=A |
| 5 | `MACHINE_MARKERS` matching becomes a family-prefix match on `<!-- generacy-stage:` and `<!-- speckit-stage:` (any suffix), removing the enumerated per-stage entries. The observed-missed prefix (`<!-- speckit-stage:clarification`) and every future engine-authored stage marker are skipped without a code change. Safe because these prefixes are strictly engine-authored. Does NOT catch the question-batch prefixes, so the FR-004 anchor is unaffected. | Q3=C |
| 6 | FR-002's `generacy-ai[bot]` self-recognition is a **log-label only**, not a behavior branch. FR-001's generic `[bot]`-suffix filter makes every App-bot login (`generacy-ai[bot]`, `staging-generacy[bot]`, `generacy-preview[bot]`, …) behave identically — never counted as an answer. The specificity buys a log line reading "cluster-self" vs "external bot", not a different code path. | Q5=A |
| 7 | The two new helpers (`isBotAuthoredLogin`, `latestQuestionCommentCreatedAt`) are file-local `function` declarations at the bottom of `clarification-answer-monitor-service.ts`, not new modules and not new exports. Follows the file's existing pattern (`toEngineLogger`, `Semaphore` are also file-local). Promoting to shared modules is a follow-up if a second call site materializes. | CLAUDE.md §"No premature abstraction" |
| 8 | `isTrustedCommentAuthor` is **not** modified. Its bot-login match uses `ctx.botLogin` — the resolved cluster account — which is correct for the trust-matrix's original purpose (same-account trust, `viewerDidAuthor` short-circuit for GraphQL). The fix's upstream `[bot]`-suffix filter is a distinct guarantee: no bot login is ever counted as a clarification answer *by this monitor*, independent of trust. Changing the trust helper would ripple into pr-feedback and clarify-resume surfaces. | Spec §"Out of Scope" |
| 9 | The `commentCarriesMachineMarker` skip runs **before** the `[bot]` filter, unchanged from today. Order matters for cost, not correctness: machine markers filter out ~80% of engine noise cheaply (single-pass string prefix check), leaving only human-or-bot free-text comments for the more nuanced author checks. Both filters together are load-bearing: without the family match on stage markers, some engine comments reach the author check; without the `[bot]` filter, the App-bot's free-text comments still slip through. | Direct analysis of the loop shape |
| 10 | ISO-8601 lexicographic string comparison is used for `created_at` newness (`a > b` rather than `new Date(a).getTime() > new Date(b).getTime()`). GitHub's REST + GraphQL both return strictly RFC 3339 Z-terminated timestamps at second precision; string compare == time compare, and it's an order of magnitude cheaper than `Date` construction inside the poll loop. This mirrors the existing `merge-conflict-monitor-service.ts` pattern for `updatedAt` comparison. | Direct read of `packages/workflow-engine/src/actions/github/client/gh-cli.ts:308-315,376-383` |
| 11 | Regression test seeds the exact snappoll fixture: three bot comments (`<!-- generacy-stage:specification -->`, `<!-- speckit-stage:clarification -->`, `<!-- generacy-clarifications:5 -->`) authored by `generacy-ai[bot]`, no other comments. Asserts `processClarificationAnswerEvent` returns `false` and the queue manager is not called. Positive-path test seeds the same three bot comments **plus** one non-bot comment (`christrudelpw`, `authorAssociation: 'MEMBER'`, `created_at` newer than the newest question marker) and asserts exactly one `enqueueIfAbsent` invocation. | SC-001, SC-002 |
| 12 | Changeset is `patch` for `@generacy-ai/orchestrator` (defect fix, `workflow:speckit-bugfix` per CLAUDE.md). No new export from any package `index.ts`; the two new helpers are private to the monitor module. | CLAUDE.md §Changesets |

## Next Step

Run `/speckit:tasks` to generate the task list with dependency ordering. Suggested parallelization:

- FR-005 (`clarification-markers.ts` family match) is a leaf edit, independent of everything else — can go first / in parallel.
- FR-001 + FR-003 + FR-004 (the monitor's predicate rewrite) are one file's changes and land together.
- Regression + SC-002 tests depend on both FR-001/003/004 and FR-005 landing.
- Changeset is the last edit before `git commit`.
