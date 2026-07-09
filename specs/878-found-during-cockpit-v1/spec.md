# Feature Specification: Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #35 — a design correction prompted by an operator question that #874's clarification menu should have contained

**Branch**: `878-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #35 — a design correction prompted by an operator question that #874's clarification menu should have contained. Supersedes the `CLUSTER_ACTING_LOGIN` mechanism from #874 (FR-001/FR-002/FR-003/FR-004) and most of #877.

## The operator's question

> "During the cluster setup wizard the user selects the GitHub account the cluster runs as, which label monitoring filters before queuing, and that works fine. What is CLUSTER_ACTING_LOGIN for and why does it need to be set to `generacy-ai`? If something like that truly needs to be hardcoded, it seems silly to need an environment variable in the first place."

He's right. The underlying *requirement* is real — the trust predicate must recognize comments the cluster itself authored (via its App token, appearing as `generacy-ai[bot]` / `author_association: NONE`), or the cockpit's request-changes loop deadlocks (#869's original finding). But the *mechanism* — resolving a configured login and string-comparing author names — makes a platform constant into distributed configuration: an env var threaded through the scaffolder (#874), cloud-deploy (#874 FR-004 follow-up), and the wizard credential file (#877), each a provisioning surface that can silently miss (as #877's live repro proved), plus a normalization pipeline (`[bot]` strip + lowercase + trim) to survive format drift.

## The primitive that dissolves it

GraphQL comments expose **`viewerDidAuthor: Boolean`** — true iff the comment was authored by the credential making the query. The monitor and handler already read review threads via GraphQL (#861's thread-shaped `getPRReviewThreads`). One field added to that query replaces the entire identity-resolution chain:

- Trust rule: `comment.viewerDidAuthor === true` → trusted, reason `'self-authored'` (replacing the `'cluster-identity'` rule on the `pr-feedback` surface).
- Semantically stronger than login comparison: "authored by the same credential this cluster operates with" is the exact property the trust rule wants, answered authoritatively by GitHub — immune to login-format drift, account renames, and misprovisioning.
- App-token nuance: installation tokens rotate hourly, but `viewerDidAuthor` keys on the authenticated App identity, not the token string — stable across mints.

## What this deletes

- `CLUSTER_ACTING_LOGIN` env var + its resolution link and FR-006 startup error line (#874) — nothing left to resolve.
- The `[bot]`-suffix/lowercase/trim normalization pipeline and its 16 fixture pairs (#874 FR-002) — no string comparison remains.
- Scaffolder writing of the var (#874 FR-003), the cloud-deploy mirror obligation (FR-004), and #877's wizard-env-writer scope — **#877 reduces to its trailing-newline fix** (still worth landing; the file-append corruption is real regardless).
- The `clusterIdentity` / `normalizedClusterIdentity` fields in skip-warn context — replace with a per-comment `viewerDidAuthor` in `untrustedCommentSkips` evidence.

## Scope boundary

- This changes the **pr-feedback surface only** (where #869 added the cluster-identity rule). The clarify surfaces' `botLogin` rules (#842, #818's self-answer exclusion) are a different mechanism serving the opposite goal (the bot's own comments must NOT count as answers) and are untouched.
- Association-tier trust for human comments (OWNER/MEMBER/COLLABORATOR) is unchanged; `viewerDidAuthor` only replaces the self-recognition rule.
- If a non-GraphQL consumer ever needs self-recognition, that consumer should migrate to the thread-shaped client rather than resurrect login comparison.

## Migration

1. Add `viewerDidAuthor` to the review-thread GraphQL query; thread it through the `ReviewThread`/`Comment` shape.
2. Predicate: replace the `clusterIdentity` context field + comparison with the boolean check; keep the `TrustReason` union tidy (`'cluster-identity'` → `'self-authored'`).
3. Remove the env var from `identity.ts` resolution, scaffolder output, and docs; drop the FR-006 boot line.
4. Live clusters need no provisioning change at all — the fix works on existing clusters at next deploy, which is precisely the point.

## Regression tests

- Fixture thread where the only unresolved comment has `viewerDidAuthor: true`, `author_association: NONE` → trusted, enqueued, handler proceeds (the #869 live scenario, minus the env var).
- `viewerDidAuthor: false` + `NONE` → untrusted (stranger comments unchanged).
- Skip-warn evidence includes per-comment `viewerDidAuthor`.
- Grep-audit: no reference to `CLUSTER_ACTING_LOGIN` remains in src/ after migration.


## User Stories

### US1: Self-recognition works on every cluster without provisioning

**As an** operator of any cluster (local-scaffolded, cloud-deployed, or long-lived),
**I want** the pr-feedback trust predicate to recognize the cluster's own PR comments via GitHub's authoritative `viewerDidAuthor` field, not a string comparison against a provisioned env var,
**So that** the request-changes loop proceeds on the next deploy without any provisioning surface (scaffolder, cloud-deploy, wizard-env-writer) needing to be touched or diffed.

**Acceptance Criteria**:
- [ ] On a pr-feedback review-thread poll, a comment with `viewerDidAuthor: true` and `author_association: NONE` is trusted with `reason: 'self-authored'`, and the enqueue fires.
- [ ] The behaviour is invariant across bot-login format drift, App account rename, and installation-token rotation — nothing about the comment's `author.login` is consulted for self-recognition.
- [ ] Existing clusters need no `.env` regeneration, no compose rewrite, and no wizard credentials re-push to gain the fix — only a redeploy of the orchestrator image.

### US2: Stranger comments stay untrusted

**As an** operator relying on the association-tier trust rules for human reviewers,
**I want** `viewerDidAuthor: false` comments to fall through to the existing `author_association` checks (OWNER/MEMBER/COLLABORATOR trusted; NONE untrusted),
**So that** the self-authored rule replaces only the `cluster-identity` self-recognition rule and does not widen (or narrow) trust for anyone else.

**Acceptance Criteria**:
- [ ] `viewerDidAuthor: false` + `author_association: NONE` → untrusted (same outcome as today's `none-untrusted`).
- [ ] `viewerDidAuthor: false` + `author_association: OWNER|MEMBER|COLLABORATOR` → trusted via association rules (unchanged).
- [ ] The clarify surfaces' `botLogin` self-answer-exclusion rules (#842, #818) are not touched by this change.

### US3: Skip-warn evidence stays diagnosable

**As an** operator investigating a `PR has unresolved threads but every comment author is untrusted` warn,
**I want** each entry in `untrustedCommentSkips` to include the per-comment `viewerDidAuthor` boolean instead of the now-removed `clusterIdentity` / `normalizedClusterIdentity` context fields,
**So that** I can tell at a glance whether the self-authored rule was consulted and returned false, without needing to reproduce boot logs or cross-reference env vars.

**Acceptance Criteria**:
- [ ] Every entry in `untrustedCommentSkips` includes `viewerDidAuthor: boolean`.
- [ ] The `clusterIdentity` and `normalizedClusterIdentity` context fields are removed from skip-warn evidence.
- [ ] No `error`-level identity-resolution-failure line is emitted at process startup (nothing to resolve).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Extend the review-thread GraphQL query (`getPRReviewThreads`, #861) to select `viewerDidAuthor` on each comment. Thread the field through the `ReviewThread` / `Comment` TypeScript shape so it is available to the trust predicate. | P1 | Single-field query addition; no new API call. |
| FR-002 | Replace the `cluster-identity` self-recognition rule in the pr-feedback trust predicate with a `viewerDidAuthor === true` check. Rename the `TrustReason` union entry `'cluster-identity'` → `'self-authored'`. Association-tier rules for human comments are unchanged. | P1 | Scope: pr-feedback surface only. |
| FR-003 | Delete the `CLUSTER_ACTING_LOGIN` env var and its `resolveActingLogin()` chain from `identity.ts` (added in #874). Delete the `[bot]`-suffix / lowercase / trim normalization pipeline and its 16-fixture regression matrix (#874 FR-002 / SC-002). | P1 | Nothing left to resolve or normalize. |
| FR-004 | Delete the scaffolder write of `CLUSTER_ACTING_LOGIN` into `.env` and `docker-compose.yml` (#874 FR-003 in `packages/generacy/src/cli/commands/cluster/scaffolder.ts`). No cloud-deploy mirror obligation remains (#874 FR-004 tracking issue closes as won't-do). | P1 | Zero provisioning surfaces after this. |
| FR-005 | Delete the FR-006 startup `error` line and its "chain link tried" enumeration (#874). Delete the `clusterIdentity` / `normalizedClusterIdentity` context fields from `untrustedCommentSkips` warn evidence. | P1 | No degraded-mode diagnostic needed. |
| FR-006 | Add a per-comment `viewerDidAuthor: boolean` field to each entry in `untrustedCommentSkips` warn evidence, so the skip line documents whether the self-authored rule was consulted. | P1 | Replaces the removed `clusterIdentity` field. |
| FR-007 | Scope constraint: this change touches the pr-feedback surface only. The clarify surfaces' `botLogin` rules (#842, #818's self-answer exclusion) MUST NOT be modified — they serve the opposite goal (the bot's own comments must NOT count as answers) and are a different mechanism. | P1 | Explicit non-goal to prevent accidental scope creep. |
| FR-008 | Grep-audit gate: no reference to `CLUSTER_ACTING_LOGIN` remains in `src/` (or `packages/**/src/`) after the migration. Docs may retain a historical mention with an explanatory note. | P1 | Verifies #874's FR-001/002/003/004 are fully unwound on the pr-feedback surface. |
| FR-009 | #877 reduces to its trailing-newline / append-corruption fix in `wizard-env-writer.ts`. The `CLUSTER_ACTING_LOGIN` provisioning scope of #877 disappears; the file-append safety fix stays in scope regardless. | P2 | Tracked as scope reduction on #877, not this issue's deliverable. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Trust rule fires on any cluster without provisioning | 100% | Fixture test: `viewerDidAuthor: true` + `author_association: NONE` → trusted, `reason: 'self-authored'`, enqueue fires. Verified live on the #869 repro scenario, minus the env var. |
| SC-002 | Stranger comments unchanged | 100% | Fixture matrix: `viewerDidAuthor: false` × `{NONE, OWNER, MEMBER, COLLABORATOR}` → trust outcome matches today's association-tier rules. |
| SC-003 | Skip-warn evidence carries the new field | Every skip includes `viewerDidAuthor` | Log-window inspection: any 10-minute window with at least one skip contains `viewerDidAuthor: <bool>` in every entry; no `clusterIdentity` or `normalizedClusterIdentity` fields remain. |
| SC-004 | No `CLUSTER_ACTING_LOGIN` remains in the source tree | Zero occurrences | `grep -R 'CLUSTER_ACTING_LOGIN' packages/**/src/` returns no matches after migration. |
| SC-005 | No provisioning surface change required for existing clusters | Zero `.env` / compose / wizard-creds file changes needed | Verification: redeploy orchestrator image on a #869-repro cluster with no other change; assert the trust rule fires on the next PR-feedback poll. |
| SC-006 | Clarify surfaces untouched | Zero diffs on `botLogin` predicate code | Code review: no changes to the clarify-surface trust logic or `botLogin` normalization added in #842 / #818. |

## Assumptions

- The pr-feedback monitor and handler already query review threads via the thread-shaped GraphQL client (#861); adding `viewerDidAuthor` is a single-field extension with no additional API surface.
- `viewerDidAuthor` is stable across GitHub App installation-token rotations (hourly mints) because it keys on the authenticated App identity, not the token string.
- REST-only consumers of comment authorship do not exist on the pr-feedback surface; if one appears in the future, it should migrate to the thread-shaped client rather than resurrect login comparison.
- The #874 code being deleted has not been consumed by other surfaces — `resolveActingLogin()` and the normalization pipeline are exclusive to the pr-feedback trust predicate.

## Out of Scope

- Clarify-surface changes: `botLogin` rules (#842, #818's self-answer exclusion) serve the opposite goal (excluding the bot's own comments from answering clarifications) and are untouched.
- Association-tier trust for human comments (OWNER/MEMBER/COLLABORATOR): unchanged; `viewerDidAuthor` replaces only the self-recognition rule.
- #877's trailing-newline / append-corruption fix in `wizard-env-writer.ts`: still in scope on #877 (the file-append corruption is real regardless of what env vars are being written); tracked separately.
- Migration path for non-GraphQL consumers of self-recognition: none exist today. If one appears, it migrates to the thread-shaped client — not addressed here.
- Retention of `CLUSTER_ACTING_LOGIN` as a hidden fallback for operator override: no such fallback ships; the env var is fully removed.

---

*Generated by speckit*
