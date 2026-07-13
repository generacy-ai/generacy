# Implementation Plan: Self-authored comment trust via GraphQL `viewerDidAuthor`

**Feature**: Replace the `CLUSTER_ACTING_LOGIN` / login-comparison self-recognition mechanism (introduced in #869 and provisioned in #874/#877) with GitHub GraphQL's `viewerDidAuthor` primitive on the pr-feedback surface, dissolving the entire identity-resolution chain.
**Branch**: `878-found-during-cockpit-v1`
**Status**: Complete

## Summary

The `cluster-identity` trust rule (#869 / #874) currently asks *"was the comment author's login string, after `[bot]`-strip + lowercase + trim, equal to the value of `CLUSTER_ACTING_LOGIN` after the same pipeline?"*. That is a proxy for the property the rule actually wants: *"did this credential author this comment?"*. GraphQL exposes the direct answer via **`viewerDidAuthor: Boolean`** on the `PullRequestReviewComment` type.

This PR ships the direct-answer replacement as a single atomic change (Q5→D):

1. **Query** — add `viewerDidAuthor` to `getPRReviewThreads` and thread it through the `ReviewThread` / `Comment` shape as an optional boolean.
2. **Predicate** — replace decision 1.5 in `isTrustedCommentAuthor` with `comment.viewerDidAuthor === true` → `{ trusted: true, reason: 'self-authored' }`. `null` / `undefined` / missing → treat as `false` **and** log at `warn` naming the comment id and observed value (Q3→D).
3. **Rename** — `TrustReason` union entry `'cluster-identity'` → `'self-authored'`. Hard rename with a one-line breaking-change note in the changeset (Q1→D). No dual-emit.
4. **Deletion** — remove `CLUSTER_ACTING_LOGIN` env var + `resolveActingIdentity()` + its FR-006 startup error line + `normalizeLogin()` and its 16-fixture pair matrix + the scaffolder `actingLogin` writer (across `cluster/scaffolder.ts`, `launch/scaffolder.ts`, `deploy/scaffolder.ts`, `launch/types.ts`) + threading in `server.ts`, `PrFeedbackMonitorService`, `PrFeedbackHandler`. Skip-warn evidence swaps `clusterIdentity` / `normalizedClusterIdentity` for per-comment `viewerDidAuthor` inside `untrustedCommentSkips`.
5. **Changelog** — one-line note that `CLUSTER_ACTING_LOGIN` is unused and safe to delete from existing `.env` / `docker-compose.yml` (Q4→B). No startup compat log, no file auto-edit.
6. **Grep-audit gate** — before implementation, confirm no non-thread-shaped self-recognition consumer exists on the pr-feedback surface (Q2→D). If one is discovered, migrate it to the thread-shaped GraphQL client rather than halting (Q2→B remedy).

**Non-goals** (explicit):
- Clarify surfaces' `botLogin` rules (#842, #818 self-answer exclusion) are untouched — different mechanism, opposite goal.
- Association-tier trust for human comments (OWNER / MEMBER / COLLABORATOR) is unchanged.
- `filterByAssignee()` and its assignee-identity chain (`CLUSTER_GITHUB_USERNAME` / `GH_USERNAME` / `resolveClusterIdentity()`) are **untouched** — assignee filtering is a different concern from the trust rule.
- No auto-cleanup of stale `CLUSTER_ACTING_LOGIN=…` in existing `.env` / compose files. One changelog line only (Q4→B).
- No dual-emit `TrustReason` window (Q1→D — hard rename).
- #877's trailing-newline fix is retitled/rescoped separately and not ordered against this PR (Q5→D).

## Technical Context

**Language / runtime**: TypeScript, Node >=22. ESM.

**Repos / packages touched**:
- `packages/workflow-engine`
  - `src/actions/github/client/gh-cli.ts` — add `viewerDidAuthor` to the `getPRReviewThreads` GraphQL query, extend the parsed-response type, populate `comment.viewerDidAuthor` from the response.
  - `src/types/github.ts` — add `viewerDidAuthor?: boolean` to `Comment`.
  - `src/security/comment-trust.ts` — replace decision 1.5, rename union entry, delete `normalizeLogin()` if no other caller remains after audit, drop `clusterIdentity` from `CommentTrustContext`.
  - `src/security/__tests__/comment-trust.test.ts` — delete 16 positive + 4 negative `normalizeLogin` fixture pairs and the T1–T6 cluster-identity tests; add fixtures for the new `'self-authored'` decision + missing-field warn behavior.
- `packages/orchestrator`
  - Delete `src/services/acting-identity.ts` + `src/services/__tests__/acting-identity.test.ts`.
  - `src/server.ts` — delete `resolveActingIdentity` import + call site (line ~45, ~172) and its threading into `ClaudeCliWorker` (~line 347) and `PrFeedbackMonitorService` constructor (~line 416).
  - `src/services/pr-feedback-monitor-service.ts` — delete `actingIdentity` constructor arg + field; delete `clusterIdentity`/`normalizedClusterIdentity` from the zero-trusted skip-warn context; add per-comment `viewerDidAuthor` inside `untrustedCommentSkips`.
  - `src/worker/pr-feedback-handler.ts` — delete `clusterIdentity` constructor arg + field; delete the FR-006 degraded-mode error log block (lines ~123–131); delete `clusterIdentity`/`normalizedClusterIdentity` from the per-skip and zero-trusted log payloads; add per-comment `viewerDidAuthor` inside `untrustedSkips` payload objects.
  - `src/__tests__/pr-feedback-integration.test.ts` — update fixtures / assertions to the new reason string and evidence shape.
- `packages/generacy`
  - `src/cli/commands/cluster/scaffolder.ts` — delete `actingLogin?: string` field on `ScaffoldEnvInput`, the `actingLoginLines` computation, and the interpolation into `.env`.
  - `src/cli/commands/launch/scaffolder.ts` — delete `actingLogin: config.actingLogin` forwarding.
  - `src/cli/commands/deploy/scaffolder.ts` — delete `actingLogin: config.actingLogin` forwarding.
  - `src/cli/commands/launch/types.ts` — delete `actingLogin: z.string().min(1).optional()` on `LaunchConfigSchema`.
  - `src/cli/commands/cluster/__tests__/scaffolder.test.ts` — delete the 4 `CLUSTER_ACTING_LOGIN` tests (absent / present / whitespace / raw-value-written); add a negative test asserting `.env` never contains `CLUSTER_ACTING_LOGIN`.

**Dependencies**: none new. Uses existing GraphQL client, existing `zod` schemas, existing pino logger.

**GraphQL contract** (the pivot):
```graphql
comments(first: 100) {
  nodes {
    databaseId
    body
    path
    line
    createdAt
    updatedAt
    author { login }
    authorAssociation
    replyTo { databaseId }
    viewerDidAuthor           # NEW — Boolean on PullRequestReviewComment
  }
}
```
`viewerDidAuthor` is `Boolean!` on `PullRequestReviewComment`, so under a successful query it is always populated. The predicate defensively treats non-`true` values (`false` / `null` / `undefined` / missing) as *not* self-authored to survive shape drift, partial errors, and cached fixtures (Q3→D).

**Predicate contract** (post-rename):
```ts
// decision 1.5 — replaces the CLUSTER_ACTING_LOGIN / normalizeLogin path
if (comment.viewerDidAuthor === true) {
  return { trusted: true, reason: 'self-authored' };
}
if (comment.viewerDidAuthor !== false) {
  ctx.logger.warn(
    { commentId: comment.id, observedValue: comment.viewerDidAuthor },
    'viewerDidAuthor missing/non-boolean on comment; treating as not self-authored',
  );
}
```

**`TrustReason` union rename**:
```
'cluster-identity' → 'self-authored'
```
Hard rename (Q1→D). No dual-emit. Changeset carries a one-line breaking-change note. String is two days old and has only ever shipped on the preview channel (Assumption 3 in spec), so no external dashboard can plausibly key on it.

## Project Structure

```
specs/878-found-during-cockpit-v1/
├── spec.md                                    (existing; not modified)
├── clarifications.md                          (existing; not modified)
├── plan.md                                    (this file)
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    ├── review-thread-query.contract.md        (GraphQL delta)
    ├── trust-predicate.contract.md            (decision 1.5 replacement + missing-field behavior)
    └── skip-warn-shape.contract.md            (evidence shape delta)
```

**Files modified in implementation** (planning only — no changes here):
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` (~lines 480–575)
- `packages/workflow-engine/src/types/github.ts` (~lines 72–94)
- `packages/workflow-engine/src/security/comment-trust.ts` (~lines 15–159)
- `packages/workflow-engine/src/security/__tests__/comment-trust.test.ts`
- `packages/orchestrator/src/services/acting-identity.ts` **(deleted)**
- `packages/orchestrator/src/services/__tests__/acting-identity.test.ts` **(deleted)**
- `packages/orchestrator/src/server.ts` (~lines 45, 172, 347, 416)
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` (~lines 95, 103, 216–221, 298–314)
- `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts` (~lines 1677–1715)
- `packages/orchestrator/src/worker/pr-feedback-handler.ts` (~lines 79, 123–131, 192–227, 272–288)
- `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` (~line 1023)
- `packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts`
- `packages/generacy/src/cli/commands/cluster/scaffolder.ts` (~lines 54–60, 347–350, 358)
- `packages/generacy/src/cli/commands/launch/scaffolder.ts` (~line 114)
- `packages/generacy/src/cli/commands/deploy/scaffolder.ts` (~line 73)
- `packages/generacy/src/cli/commands/launch/types.ts` (~line 75)
- `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` (~lines 735–800)

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo — no project-level governance checks to apply. Two implicit invariants are load-bearing and enforced at review time:

- **Fail-safe on shape drift**: never widen trust when a schema field is missing (Q3→A/D — treat as `false`, log at `warn`).
- **Single mechanism per surface**: the pr-feedback surface has exactly one self-recognition rule after this PR (`viewerDidAuthor`). No parallel login-comparison path allowed to resurrect.

## Migration & Rollback

**Migration** (single atomic PR, Q5→D):
1. Add `viewerDidAuthor` to `getPRReviewThreads` query + parsed-response type + `Comment` shape.
2. Replace decision 1.5 in `isTrustedCommentAuthor`; rename union entry `'cluster-identity'` → `'self-authored'`.
3. Delete `resolveActingIdentity()`, all `actingLogin` scaffolder plumbing, `CLUSTER_ACTING_LOGIN` env read, `normalizeLogin()` (if no remaining caller after audit — the bot-login path in decision 1 still calls it), and threading in server + monitor + handler.
4. Update skip-warn evidence: replace `clusterIdentity` / `normalizedClusterIdentity` top-level fields with per-comment `viewerDidAuthor` inside `untrustedCommentSkips[]`.
5. Grep-audit `src/` for `CLUSTER_ACTING_LOGIN` — must be zero (SC-003).
6. Changelog note: `CLUSTER_ACTING_LOGIN` is unused; safe to remove from existing `.env` and `docker-compose.yml`; no auto-cleanup (Q4→B).

**Rollback**: revert the PR. Live clusters do not need any provisioning change to gain or lose this fix — the delta is entirely in-image. This is the same property that makes the fix *worth* shipping (SC-005).

## Risks & Mitigations

- **Risk**: GitHub returns `viewerDidAuthor: null` under partial-error paths, silently downgrading self-authored comments to untrusted.
  **Mitigation**: FR-002 → per-comment `warn` log with the observed value; alerts key on the log stream if this becomes non-transient.

- **Risk**: A non-thread-shaped self-recognition consumer exists somewhere on the pr-feedback surface and the audit misses it.
  **Mitigation**: FR-007 grep-audit runs before implementation. Assumption 1 is that the review-thread client is the sole consumer post-#861. If one is found, migrate it (Q2→B) — do not halt.

- **Risk**: A downstream consumer (dashboard, alert, runbook grep) keyed on the literal string `'cluster-identity'`.
  **Mitigation**: Assumption 3 — the string is two days old, preview-channel only. FR-004 publishes the one-line breaking-change note explicitly. Dual-emit (Q1→B) was rejected as machinery for hypothetical consumers.

- **Risk**: Removing `normalizeLogin()` breaks the bot-login path (decision 1 in `isTrustedCommentAuthor`).
  **Mitigation**: decision 1 still calls `normalizeLogin` for the bot-login comparison — the function is retained; only its cluster-identity call site is removed. This is a scope-boundary point: the `botLogin` rule (#842) is out of scope for this feature.

## Next Step

Run `/speckit:tasks` to generate the task list.

---

*Generated by speckit*
