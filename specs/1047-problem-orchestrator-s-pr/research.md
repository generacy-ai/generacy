# Research: PR-feedback fixer consumes review bodies

**Feature**: #1047
**Branch**: `1047-problem-orchestrator-s-pr`

This document captures the technology and design decisions locked in during `/speckit:clarify` and cross-references the specific source-of-truth files that justify each. All six clarification questions have `.md` traceability in `clarifications.md`; this file records the *implementation-level* consequences.

## Decisions

### D1: Fetch review bodies via `GET /repos/{owner}/{repo}/pulls/{n}/reviews`

**Choice**: REST endpoint through the existing `gh api` shim in `packages/workflow-engine/src/actions/github/client/gh-cli.ts`.

**Rationale**:
- Same auth surface as the existing `getPRReviewThreads` call — no new credential, no new failure mode.
- REST returns `submissionState` (the field FR-001 keys on for the CHANGES_REQUESTED/COMMENTED filter) and `user.login` (the field Q3's per-author supersession keys on).
- GraphQL equivalent (`pullRequest.reviews`) is workable but adds an extra client method and doubles the schema surface. Pagination behavior is the same class of concern in both.

**Alternatives considered**:
- **GraphQL**: rejected — parity with the existing pattern (`postPrComment`, `listPrCommentBodies` both REST) matters more than the marginal type-safety win. The existing `getPRReviewThreads` uses GraphQL only because REST does not expose thread resolution; that constraint doesn't apply to review bodies.
- **Reuse `gh pr view --json reviews`**: rejected — `--json reviews` returns a limited subset (`body`, `author.login`, `state`, `submittedAt`) and does not expose review `id` reliably in older `gh` versions. Review `id` is load-bearing for the FR-008 acknowledgment key.

**Sources**:
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — existing `gh api` patterns
- `packages/workflow-engine/src/actions/github/client/interface.ts:243-253` — `listPrCommentBodies` / `postPrComment` prior art

### D2: Filter fetched reviews to `submissionState ∈ {CHANGES_REQUESTED, COMMENTED}`

**Choice**: filter client-side in `PrFeedbackHandler`, not server-side. Fetch everything; filter after.

**Rationale**:
- Per Q2 answer, `COMMENTED` is load-bearing: `agency/specs/422-summary-auto-md-s/contracts/request-changes-post.md § Field rules` mandates `event: COMMENT` for every self-authored review under the single-credential model. `CHANGES_REQUESTED`-only would fetch zero of the observed failures.
- Client-side filtering keeps the client method surface generic (`listReviews`) so future callers can filter differently without new methods.
- `APPROVED` and `DISMISSED` are excluded; `PENDING` is a review-in-progress and REST omits it from the list endpoint anyway.

**Sources**:
- `clarifications.md` Q2 — full rationale
- `agency/specs/422-summary-auto-md-s/contracts/request-changes-post.md § Field rules` — the `event: COMMENT` invariant

### D3: Marker parser reads `<!-- generacy-cockpit:unanchored-findings -->` blocks, tolerates missing `**Files:**` lines

**Choice**: pure function `parseReviewBody(body, reviewId, login) → ParsedReview`. Absent marker → empty findings. Marker present, `**Files:**` absent on a `### Finding <n>` → the finding is parsed but has `hasFilesLine: false` and contributes zero constraints.

**Rationale**:
- Per Q1 answer (option B, wire-contract extension), the producer-side render adds a `**Files:** <comma-separated>` line under each `### Finding <n>`. Consumer parser must tolerate both shapes to allow independent landing.
- The block structure is stable: `<!-- generacy-cockpit:unanchored-findings -->` opens a section that contains ordered `### Finding 1`, `### Finding 2`, ... sub-headings. Existing producer contract at `agency/specs/422-summary-auto-md-s/contracts/request-changes-post.md § Unanchored-block shape`.

**Alternatives considered**:
- **Regex-scan the finding prose** (Q1 option A): rejected — false-positives on incidentally path-shaped tokens (`"unlike foo.ts, ..."`), and false-negatives when the prose doesn't name the file at all. Consumer-side regex re-derivation of a field the producer discarded is exactly what FR-005 forbids for the marker-absent path; extending it to the marker-present path is inconsistent.
- **Content-hash gate** (Q1 option D): rejected — re-introduces the SC-003 false-complete mode.

**Sources**:
- `clarifications.md` Q1 — full rationale
- `agency/specs/422-summary-auto-md-s/contracts/request-changes-post.md § Unanchored-block shape` — canonical producer shape
- `agency/specs/422-summary-auto-md-s/data-model.md § Finding` — the `file` field that already exists on the producer's data model but is currently discarded during render

### D4: Per-finding gate with per-review-author supersession

**Choice**: For each distinct reviewer login with new reviews since the last cycle, only that author's newest submission gates. Every finding in that submission with a `**Files:**` list must have at least one of its named files touched by a commit in the cycle. AND across findings; findings with no `**Files:**` line contribute zero constraints; findings in the acknowledgment set (see D5) do not gate.

**Rationale**:
- Per Q3 answer, per-author supersession is the only scheme that handles the bot-vs-human parallel review case correctly. `pr-feedback-monitor-service.ts:210` reads the cluster username from `CLUSTER_GITHUB_USERNAME` / `GH_USERNAME`; humans post as themselves. A human's later `APPROVED` review would silently erase the bot's still-unaddressed body findings under a "newest overall" scheme (Q3 option A).
- Per Q5 answer, per-finding (not union) is the only scheme that preserves SC-003. Union would let a fixer that touches file A pass a review naming (A, B, C) despite B and C sitting unaddressed.
- Per-finding with tracking (Q5 option C over A) lets Disposition C's marker comment name which specific finding remains unaddressed at zero marginal compute cost.

**Sources**:
- `clarifications.md` Q3, Q5 — full rationale
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:210` — cluster-identity resolution
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:213-232` — the per-author trust loop that establishes bot-vs-human as distinct logins

### D5: Acknowledgment record is a marker-keyed top-level PR comment (Disposition C)

**Choice**: When Disposition C fires, apply `blocked:body-finding-unaddressed` and post one PR comment carrying `<!-- generacy-cockpit:body-findings-unaddressed -->` + a machine-readable enumeration of `(reviewer login, review id, finding index)` for every unaddressed finding. Idempotent via `listPrCommentBodies` marker-grep before posting (same pattern as `maybePostUntrustedNotice`). On the next cycle, parse the newest marker comment and treat listed findings as "acknowledged, do not re-gate" — they still reach the prompt via FR-002 but do not participate in FR-003.

**Rationale**:
- Per Q6 answer, do not advance a watermark: FR-001's "newer than the last cycle" predicate is the SINGLE source feeding both the FR-002 prompt and the FR-003 gate. Advancing would delete the findings from the prompt on the cycle the fixer most needs them.
- No new persistence infrastructure: the monitor's only per-PR state is two in-memory Maps that are pure polling-health telemetry; `PrFeedbackHandler` is constructed fresh per job across the queue boundary (`claude-cli-worker.ts:295-299`), so it holds no cross-cycle state by construction.
- Marker-keyed PR comment is restart-safe, process-agnostic, and reuses the exact pattern already deployed in the untrusted-notice path (`pr-feedback-monitor-service.ts:435-488`).
- Q5 synergy: the same enumeration serves two purposes — operator triage on Disposition C AND ack-set input on resume. One artifact, two consumers.

**Alternatives considered**:
- **Advance the watermark** (Q6 option A): rejected — deletes context on the cycle the fixer needs it most; also requires the net-new watermark infrastructure.
- **Retry-with-terminal disposition** (Q6 option C): rejected — runs an identical prompt against identical inputs for unbounded token spend; requires the same new store PLUS a second label.
- **Do nothing on resume** (Q6 option D): rejected — factually broken. FR-003's hold fires only AFTER thread resolves succeed, so the next poll hits monitor Case C at `pr-feedback-monitor-service.ts:264-285` and never re-enqueues. The label-loop D describes cannot happen; the failure mode D would ship is a stall-until-new-review, indistinguishable from the pre-fix behavior.

**Sources**:
- `clarifications.md` Q6 — full rationale (with premise correction)
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:435-488` — untrusted-notice prior art
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:264-285` — the monitor's Case C that Q6-D would depend on

### D6: New label `blocked:body-finding-unaddressed` requires no monitor-side change

**Choice**: apply the new label from within `PrFeedbackHandler` on Disposition C. Monitor honors it via the existing prefix skip gate.

**Rationale**:
- `pr-feedback-monitor-service.ts:328-341` is a bare `l.startsWith('blocked:')` prefix match with no allow-list. Confirmed via grep. New `blocked:*` labels are contract-honored at zero monitor-side change.
- CLAUDE.md rule: "new label vocabulary in `workflow-engine` → `minor`". The label is a semantic addition to the public label taxonomy, so the changeset entry for `@generacy-ai/workflow-engine` is `minor` regardless of whether new code lands in that package.

**Sources**:
- `clarifications.md` Q4 — full rationale
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:328-341` — the prefix skip gate

### D7: Commit-touched-file set derived from `git diff --name-only <baseSha>..HEAD`

**Choice**: compute the touched-file set from the git diff between the pre-fix and post-push SHAs, scoped to the cycle. Not from `commitAndPushChanges`'s status output.

**Rationale**:
- The gate needs "files touched by ANY commit in this cycle" not "files staged in this exact commit". A cycle may push multiple commits (partial-completion strategy on timeout, FR-013 at `pr-feedback-handler.ts:571-578`). A single-commit view would false-block on cycles that produced multiple commits.
- The pre-cycle SHA is already available from `getPullRequest` (head.ref at cycle start); the post-cycle SHA is the value `getHeadShortSha` returns for the reply-body decoration (`pr-feedback-handler.ts:330`).
- `git diff --name-only <base>..HEAD` is idempotent, deterministic, and adds one `executeCommand` call.

**Alternatives considered**:
- **Parse commit list + accumulate**: rejected — same output, more code, more edge cases (merge commits, rebases).
- **Reuse `getStatus()` from `commitAndPushChanges`**: rejected — that reports pre-commit staging, which by construction is empty post-push.

**Sources**:
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:571-578` — FR-013 multi-commit partial completion
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:726-739` — `getHeadShortSha` shape to mirror

## Implementation patterns

- **Pure-function extraction**: parsers and gate live in single-purpose files (`pr-feedback-body-parser.ts`, `pr-feedback-ack-parser.ts`, `pr-feedback-body-gate.ts`). Handler tests set up wire fixtures once and drive the pure functions to enumerate edge cases. Handler integration tests exercise the fetch/CLI/commit envelope through the same fixtures.
- **Stub GitHubClient at handler boundary**: existing test patterns in `packages/orchestrator/src/__tests__/` use TypeScript stubs implementing `GitHubClient` and `AgentLauncher`. Extend the same pattern to inject preset review lists.
- **Marker-comment idempotency**: mirror `maybePostUntrustedNotice`'s shape (`pr-feedback-monitor-service.ts:435-488`) — `try { listPrCommentBodies } catch { warn; skip }` + `if (existing.some(b => b.includes(MARKER))) { debug; skip }`.
- **Fail-open marker parsing**: the two parsers return sentinel empty structures rather than throwing. Callers treat empty as "no gating information", which matches FR-005's fail-open contract.

## Key sources

- Spec: `specs/1047-problem-orchestrator-s-pr/spec.md`
- Clarifications: `specs/1047-problem-orchestrator-s-pr/clarifications.md` (Q1-Q6, all resolved)
- Existing handler: `packages/orchestrator/src/worker/pr-feedback-handler.ts`
- Existing monitor: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- Existing client interface: `packages/workflow-engine/src/actions/github/client/interface.ts`
- Producer wire contract (upstream, `agency` repo): `agency/specs/422-summary-auto-md-s/contracts/request-changes-post.md § Unanchored-block shape` + `§ Field rules`
- Producer data model (upstream, `agency` repo): `agency/specs/422-summary-auto-md-s/data-model.md § Finding, § UnanchoredEntry`
- GitHub REST reference: `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`
- CLAUDE.md changeset rules: `/workspaces/generacy/CLAUDE.md § Changesets`
