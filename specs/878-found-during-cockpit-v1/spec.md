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

### US1: Cluster self-recognition without configured identity

**As a** cluster operator running the cockpit's request-changes loop,
**I want** the pr-feedback trust predicate to recognize comments the cluster itself authored via GitHub's `viewerDidAuthor` primitive,
**So that** the loop no longer deadlocks on cluster-authored comments and no per-cluster identity provisioning (env var, scaffolder mirror, wizard credential) is required.

**Acceptance Criteria**:
- [ ] Trust rule fires on `comment.viewerDidAuthor === true` with reason `'self-authored'` on the pr-feedback surface.
- [ ] `CLUSTER_ACTING_LOGIN` env var + resolution link + FR-006 startup error line are removed from `identity.ts`, scaffolder output, and docs.
- [ ] `[bot]`-suffix / lowercase / trim normalization pipeline and its 16 fixture pairs are removed.
- [ ] Skip-warn evidence records per-comment `viewerDidAuthor` in `untrustedCommentSkips` (replacing `clusterIdentity` / `normalizedClusterIdentity` fields).
- [ ] Existing clusters need no `.env` regeneration, no compose rewrite, and no wizard credentials re-push to gain the fix — only a redeploy of the orchestrator image.
- [ ] The clarify surfaces' `botLogin` rules (#842, #818) are left untouched.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `viewerDidAuthor` to `getPRReviewThreads` GraphQL query; thread it through the `ReviewThread` / `Comment` shape. | P1 | |
| FR-002 | pr-feedback trust predicate treats `comment.viewerDidAuthor === true` as trusted with `TrustReason === 'self-authored'`. `null` / `undefined` / missing `viewerDidAuthor` → treat as `false` **and** log at `warn` with the comment id and the observed value. | P1 | Clarified Q3 — degrade safely but loudly. |
| FR-003 | Hard-rename `TrustReason` union entry `'cluster-identity'` → `'self-authored'`. Emit only `'self-authored'` going forward; do not dual-emit. | P1 | Clarified Q1. |
| FR-004 | Publish a one-line breaking-change note in the changeset calling out the `TrustReason` string rename. | P1 | Clarified Q1. |
| FR-005 | Publish a one-line changelog note stating that `CLUSTER_ACTING_LOGIN` is unused and safe to delete from existing `.env` / `docker-compose.yml`. No startup compat log line, no auto-edit of operator files. | P2 | Clarified Q4. |
| FR-006 | Remove `CLUSTER_ACTING_LOGIN` env var, its resolution in `identity.ts`, the scaffolder writer, the `[bot]`-strip / lowercase / trim normalization pipeline (+16 fixture pairs), and the FR-006 startup error line. Replace `clusterIdentity` / `normalizedClusterIdentity` skip-warn fields with per-comment `viewerDidAuthor`. | P1 | |
| FR-007 | Before implementation, run a grep-audit for self-recognition consumers outside the review-thread GraphQL client on the pr-feedback surface. Expected result: absent. If a consumer is discovered, migrate it to the thread-shaped GraphQL client rather than halting to re-plan or downgrading the surface's trust. | P1 | Clarified Q2 — D-verify, B-remedy. |
| FR-008 | Ship as a single atomic PR: (i) add `viewerDidAuthor` to `getPRReviewThreads`, (ii) replace the trust predicate, (iii) delete `CLUSTER_ACTING_LOGIN` from `identity.ts` + scaffolder + docs, (iv) update skip-warn evidence. #877 is already retitled and rescoped to its trailing-newline fix and is not ordered against this PR. | P1 | Clarified Q5. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | pr-feedback trust decision on a self-authored comment | Trusted with reason `'self-authored'` | Fixture thread where the only unresolved comment has `viewerDidAuthor: true`, `author_association: NONE` → enqueued, handler proceeds (the #869 live scenario, minus the env var). |
| SC-002 | Non-self-authored stranger comments | Still untrusted | Fixture with `viewerDidAuthor: false` + `author_association: NONE` → untrusted, unchanged behavior. |
| SC-003 | No residual `CLUSTER_ACTING_LOGIN` references | Zero matches | Grep-audit `src/` for `CLUSTER_ACTING_LOGIN` after migration; result must be empty. |
| SC-004 | Skip-warn evidence shape | Per-comment `viewerDidAuthor` present | `untrustedCommentSkips` payloads emitted from the pr-feedback surface include a per-comment `viewerDidAuthor` field. |
| SC-005 | Existing-cluster upgrade path | Zero provisioning changes required | Redeploying the orchestrator image on a cluster that never had `CLUSTER_ACTING_LOGIN` set exits the #869 deadlock. |
| SC-006 | Behavior on missing `viewerDidAuthor` | Untrusted + one `warn` log per occurrence | Fixture with `viewerDidAuthor: null` / absent → predicate returns not-self-authored, `warn` log emitted carrying the comment id and observed value. |

## Assumptions

- The review-thread GraphQL client (`getPRReviewThreads`, post-#861) is the sole self-recognition consumer on the pr-feedback surface. To be confirmed by FR-007's grep-audit before implementation.
- `resolveActingLogin()` and its normalization pipeline are exclusive to the pr-feedback trust predicate; no other surface consumes them.
- The `'cluster-identity'` `TrustReason` string has only shipped on the preview channel (two days) and is not keyed on by any external dashboard, alert, or runbook.
- Installation tokens rotate hourly, but `viewerDidAuthor` keys on the authenticated App identity, so the check is stable across token mints.

## Out of Scope

- The clarify surfaces' `botLogin` rules (#842, #818 self-answer exclusion) — different mechanism, opposite goal, untouched.
- Association-tier trust for human comments (OWNER / MEMBER / COLLABORATOR) — unchanged.
- Auto-cleanup of stale `CLUSTER_ACTING_LOGIN=…` lines in existing `.env` / `docker-compose.yml` files. A one-line changelog note (FR-005) is the only operator-facing signal.
- #877's file-append trailing-newline fix. #877 is already retitled and rescoped and lands independently.
- Migrating any non-thread-shaped consumer of comment authorship pre-emptively. Only performed reactively if FR-007's grep-audit surfaces one.

---

*Generated by speckit*
