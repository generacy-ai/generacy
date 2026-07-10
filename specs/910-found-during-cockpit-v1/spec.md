# Feature Specification: answer-scanner never trusts App-identity clusters' own posts (botLogin unresolvable, viewerDidAuthor absent) — cockpit auto dead-ends at every clarification gate

**Branch**: `910-found-during-cockpit-v1` | **Date**: 2026-07-10 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #52 — first clarification gate on the fresh snappoll cluster (christrudelpw/snappoll, App-auth scaffold). Companion to finding #51 (answer-scanner ingests the engine's own questions comments); **the two mask each other — land #51's marker exclusion first.**

## Observed

On App-identity clusters, the clarification answer-scanner can never trust the cluster's own comments — every cluster-authored comment evaluates at author-association tier `NONE` (GitHub Apps are not OWNER/MEMBER/COLLABORATOR) and is rejected as untrusted. Verified on the snappoll cluster:

- `resolveBotLoginFromEnv()` (clarification-poster.ts) reads `CLUSTER_GITHUB_USERNAME` ?? `GH_USERNAME`. **Neither is set in any snappoll container** (worker + orchestrator env checked). Its own code comment says the `gh api /user` fallback is intentionally skipped because it fails on App tokens and "env vars are the load-bearing tier in-cluster" — but no scaffolder or entrypoint path writes those vars on App-auth clusters. The only writers are the legacy personal-auth setup (`setup/auth.ts`). In-cluster `gh auth status`: "not logged into any GitHub hosts" (the wrapper injects installation tokens per call), so there is no gh-config identity either.
- Comment-trust rule 1.5 (`viewerDidAuthor === true` → self-authored, trusted) never fires on this surface: the answer-scanner fetches comments via REST, which doesn't populate the field — #878's fix was scoped to the pr-feedback surface (`getPRReviewThreads()`) only.
- Net: rules 1 and 1.5 are both structurally inert → tier evaluation → `NONE` → untrusted.

**Consequence**: cockpit auto's D.1 contract — the session posts operator-approved answers via its own `gh` (cluster identity) and the engine ingests them — is impossible on App-auth clusters. The operator must hand-post every answer batch from a personal account, defeating auto-transport at the highest-frequency gate. Personal-auth clusters never surface this (`GH_USERNAME` is written by the legacy path, and the author is OWNER anyway), which is why generacy-ai-org clusters and the earlier sniplink-era engine never hit it.

This is the third occurrence of the same defect class on a third surface: #869 (pr-feedback distrusts cluster's own reviews) → #874 ("acting identity never provisioned — cluster-identity trust rule is inert on scaffolded clusters") → #878 (fix: `viewerDidAuthor`, no configured identity needed — but pr-feedback only). The answer-scanner and clarify-resume surfaces kept the env mechanism #874 already proved is never provisioned.

## Fix (recommended)

Extend #878's mechanism to the remaining surfaces: fetch issue comments for the answer-scanner (and clarify-resume) via GraphQL with `viewerDidAuthor`, so self-recognition needs no configured identity and survives installation-token rotation. The env chain stays as a secondary tier for operators who set it.

Alternative (band-aid, not preferred): scaffolder/entrypoint provisions `CLUSTER_GITHUB_USERNAME=<app-slug>[bot]` into cluster env — but this resurrects #874's provisioning-drift problem across scaffolder + cloud-deploy and still breaks on App rename.

## Ordering warning

Whichever fix ships, **do not make the cluster identity trusted on the answer-scanner surface before #51's marker exclusion lands** — trusted bot + marker-blind scanning means the engine ingests its own questions comment as answers and self-advances clarification gates with garbage.

## Regression tests

- App-auth fixture (no identity env, REST-shaped comments upgraded to GraphQL fetch): cluster-authored answers comment → trusted via `viewerDidAuthor`; question-marker comments excluded regardless (per #51).
- Personal-auth fixture: unchanged behavior.
- Untrusted third-party `Q1: A` comment → still rejected with explainer.

## User Stories

### US1: Cluster self-recognition on the clarification answer-scanner surface

**As a** cluster operator running the cockpit auto-mode clarification gate on an App-identity cluster,
**I want** the answer-scanner to recognize the cluster's own answer comment as self-authored via GitHub's `viewerDidAuthor` primitive,
**So that** cockpit auto's D.1 contract works: the session posts operator-approved answers via its own `gh` (cluster identity) and the engine ingests them without requiring a hand-posted comment from a personal account.

**Acceptance Criteria**:
- [ ] The answer-scanner (`integrateClarificationAnswers`) fetches issue comments via a code path that populates `viewerDidAuthor` (GraphQL, mirroring `getPRReviewThreads()` from #878).
- [ ] On an App-identity fixture with no `CLUSTER_GITHUB_USERNAME` / `GH_USERNAME` env and no widen-config, a cluster-authored `Q1: A` comment evaluates as `trusted` with reason `'self-authored'`.
- [ ] Existing personal-auth clusters continue to work: the answer trust decision is unchanged where the comment was already trusted by tier or bot-login.
- [ ] Question-marker comments (bot's own questions) continue to be excluded by `isQuestionComment()` before answer parsing runs (companion to #51).

### US2: Cluster self-recognition on the clarify-resume prompt surface

**As a** cluster operator running the clarify operation itself (via `buildTrustedIssueCommentsBlock` in `clarify.ts`),
**I want** the clarify-resume prompt to include the cluster's own prior comments as trusted context via `viewerDidAuthor`,
**So that** clarification resumption on App-identity clusters no longer silently drops the cluster's own prior comments from the trusted-context block presented to the agent.

**Acceptance Criteria**:
- [ ] `buildTrustedIssueCommentsBlock` fetches issue comments via a code path that populates `viewerDidAuthor`.
- [ ] On an App-identity fixture, a cluster-authored comment is included in the trusted block with reason `'self-authored'`.
- [ ] Untrusted third-party comments continue to be excluded and skip-logged.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add a sibling client method `getIssueCommentsWithViewerAuth()` that populates `Comment.viewerDidAuthor` via GraphQL. Answer-scanner and clarify-resume migrate to it; unrelated callers (`epic/update-status.ts`, `workflow/update-stage.ts`) keep the REST `getIssueComments()` unchanged. Mirrors #878's `getPRReviewThreads()` sibling-method precedent — keeps the trust dependency visible at every call site, avoids conditional return-type complexity of an options flag, and constrains blast radius vs. mutating the shared method. | P1 | Resolved by /clarify Q2 → A. |
| FR-002 | The answer-scanner (`integrateClarificationAnswers` in `clarification-poster.ts`) uses the new client path so `isTrustedCommentAuthor(..., 'answer-scanner', ...)` sees `viewerDidAuthor`. Self-authored cluster comments evaluate as `trusted` with reason `'self-authored'`. | P1 | |
| FR-003 | The clarify-resume prompt (`buildTrustedIssueCommentsBlock` in `clarify.ts`) uses the new client path so `isTrustedCommentAuthor(..., 'clarify-resume', ...)` sees `viewerDidAuthor`. Self-authored cluster comments enter the trusted block. | P1 | |
| FR-004 | Extend the "viewerDidAuthor absent" warn in `comment-trust.ts:111` to both migrated surfaces (`answer-scanner`, `clarify-resume`). On these fetch paths the field is structurally required post-migration, so absence is by-definition a broken migration / shape drift — the warn is the visibility signal for that class of defect. #878's carve-out (by-design REST absence on `pr-feedback`) stops applying once these surfaces migrate to GraphQL. In healthy steady state the warn never fires. | P1 | Resolved by /clarify Q1 → A. |
| FR-005 | The untrusted-answer explainer path in `postUntrustedAnswerExplainers` continues to fire on drive-by third-party `Q<N>:` comments (unchanged). The idempotence marker (`<!-- generacy-untrusted-answer:<id> -->`) is unaffected. | P1 | |
| FR-006 | The `resolveBotLoginFromEnv()` env chain stays as a secondary trust tier for operators who set it — do not delete it. `CLUSTER_GITHUB_USERNAME` and `GH_USERNAME` continue to work when present. | P1 | Env fallback is defensive; deletion is out of scope. |
| FR-007 | Enforce #51's (question-marker exclusion, `isQuestionComment`) precedence via a PR-level check *plus* a permanent integration test. PR-level check: tasks include verifying that `isQuestionComment()` exists and is invoked before answer parsing on the migrated fetch path; absence fails the implement phase. Permanent regression test: a trusted (self-authored) comment carrying the question marker → zero answers ingested. This test makes both merge-order violations and post-merge #51 reverts fail CI forever — strictly stronger than a runtime presence guard, which is illusory in compiled TypeScript (a revert removes the import and any guard's referent together). | P1 | Resolved by /clarify Q3 → B. |
| FR-008 | Grep-audit for other `getIssueComments()` callers on surfaces that pass through `isTrustedCommentAuthor` before implementation. Expected: `epic/update-status.ts` and `workflow/update-stage.ts` do not self-trust-evaluate — no surface changes required. If the audit surfaces additional self-trust-evaluating callers beyond the two named surfaces, do NOT bundle them into this PR: file per-surface follow-up issues with call-site evidence + regression fixtures, cross-linked to the #869 → #874 → #878 → this-issue defect-class lineage. Keeps this PR bounded and reviewable; each surface's edge cases (dedupe wedging, `[bot]` normalization, by-design field absence) get examined on their own merits. | P1 | Resolved by /clarify Q5 → B. |
| FR-009 | Ship as a single atomic PR: (i) `getIssueCommentsWithViewerAuth()` GraphQL client method, (ii) migrate answer-scanner, (iii) migrate clarify-resume prompt, (iv) regression fixtures for App-auth + personal-auth + third-party + FR-007 marker-priority test. #51 lands first (dependency, not bundled). | P1 | |
| FR-010 | On transient GraphQL failure while fetching issue comments on the migrated surfaces (`answer-scanner`, `clarify-resume`): retry once against GraphQL to absorb transient blips (secondary rate limits, network flap), then fail closed on second failure — no comments treated as trusted this cycle, log a warn with the GraphQL error, gate stays paused until the next successful fetch. Do NOT silently fall back to REST: REST loses `viewerDidAuthor` and reproduces the exact pre-fix defect on the degraded cycles (compounded under FR-004, which would additionally fire the absent-field warn). Fail-closed matches `comment-trust`'s existing posture (unset association → untrusted, rule 2) and is self-healing across poll cycles. | P1 | Resolved by /clarify Q4 → B. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | App-auth cluster cockpit-auto clarification gate transports operator-approved answers end-to-end | Cluster-posted answer comment ingested by the answer-scanner without an operator hand-post from a personal account | On the snappoll fixture (App-auth, no `CLUSTER_GITHUB_USERNAME`/`GH_USERNAME`), `integrateClarificationAnswers` returns `integrated >= 1` after the cluster posts its answers. |
| SC-002 | Trust decision on a cluster-self-authored answer comment | `{ trusted: true, reason: 'self-authored' }` on both `answer-scanner` and `clarify-resume` surfaces | Fixture comment with `viewerDidAuthor: true`, `author_association: 'NONE'`, no bot-login env → decision matches. |
| SC-003 | Trust decision on a third-party stranger's `Q1: A` comment | Still `{ trusted: false }` with an `untrusted` reason | Fixture comment with `viewerDidAuthor: false`, `author_association: 'NONE'` → decision unchanged from today. |
| SC-004 | Personal-auth cluster regression | Unchanged behavior | Fixture with `GH_USERNAME` set + REST-shape comment where author matches bot login → still trusted via `reason: 'bot'`, no new warns. |
| SC-005 | Question-comment exclusion still runs before answer parsing | Bot's own `### Q<n>:` comments never surface as answers | Fixture where the trusted comment set includes both the bot's questions comment and its own answers comment → only the answers comment is passed to `parseAnswersFromComments`. |
| SC-006 | Extended warn fires on shape drift, silent on healthy fetches (FR-004) | Warn count 0 in the healthy-fixture case; warn count ≥ 1 in a synthetic drift-fixture where `viewerDidAuthor` is absent on the migrated surface | Log audit on a mixed-fixture run: `answer-scanner` + `clarify-resume` warn count is 0 with all-populated `viewerDidAuthor`; injected-drift fixture produces the warn on both surfaces. |
| SC-007 | No `CLUSTER_GITHUB_USERNAME` re-provisioning required | Zero scaffolder / cloud-deploy / wizard changes | Redeploying the orchestrator image on an existing App-auth cluster (no env changes) exits the SC-001 dead-end. |
| SC-008 | GraphQL failure fails closed with one retry, never falls back to REST (FR-010) | Second consecutive GraphQL failure → `integrated == 0` this cycle, warn logged with GraphQL error, gate remains paused; single transient failure absorbed by retry with no operator-visible pause | Fixture: mock GraphQL fetch to fail once then succeed → answers still ingested on the retry; fail twice → no answers ingested, warn present, no REST call issued. |
| SC-009 | Question-marker regression test enforces FR-007 ordering | Trusted self-authored comment carrying the `<!-- generacy-clarifications:<id> -->` marker → `integrated == 0` and no `Q<N>: A` string parsed from it | Regression fixture (permanent): cluster-authored questions comment + cluster-authored answers comment → only the answers comment is parsed; test fails if `isQuestionComment()` is removed or moved after answer parsing. |

## Assumptions

- The clarify-resume prompt's `buildTrustedIssueCommentsBlock` in `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` is the second self-recognition consumer that shares the defect. FR-008's grep-audit confirms whether there is a third.
- Installation tokens rotate hourly; `viewerDidAuthor` keys on the authenticated App identity, not the token string, so the check is stable across mints (same reasoning as #878).
- `viewerDidAuthor` is available on the REST issue-comment endpoint via a GraphQL upgrade equivalent to the review-thread client from #878. Cost is one additional GraphQL call per fetch; call frequency is bounded by the phase loop (one fetch per gate check, not per comment).
- #51's question-marker exclusion is either already merged or lands before this PR (FR-007). If #51 slips, this PR blocks.
- The `epic/update-status.ts` and `workflow/update-stage.ts` callers of `getIssueComments()` do not perform self-trust evaluation, so they can continue to use the REST path. FR-008's grep-audit confirms before implementation; any surprise self-trust-evaluating surface is spun out to its own issue rather than folded into this PR (per FR-008 / Q5 → B).

## Out of Scope

- Deleting `resolveBotLoginFromEnv()` and its `CLUSTER_GITHUB_USERNAME` / `GH_USERNAME` env chain — kept as a secondary tier (FR-006). #878 already justified why removing it entirely is a separate call.
- Scaffolder / cloud-deploy / wizard provisioning changes to write `CLUSTER_GITHUB_USERNAME=<app-slug>[bot]` — the band-aid alternative; explicitly rejected in the issue.
- Association-tier trust semantics for human comments (OWNER / MEMBER / COLLABORATOR) — unchanged.
- The widen-config carve-out (`answer-scanner` ignoring widen-config from #842 FR-008) — unchanged.
- Non-clarify surfaces of `getIssueComments()` (`epic/update-status.ts`, `workflow/update-stage.ts`) — do not self-trust-evaluate, kept on REST unless FR-008's audit surfaces a reason to migrate them.
- #51's question-marker exclusion — a hard dependency (FR-007), not part of this PR.

---

*Generated by speckit*
