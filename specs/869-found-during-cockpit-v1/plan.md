# Implementation Plan: Cluster-identity trust + zero-trusted loud retention + dedupe-on-exit for PR-feedback loop

**Feature**: Fix the four sub-defects that let the #861 PR-feedback loop defeat itself when the request-changes review is authored by the cluster's own GitHub identity (spec `#869`).
**Branch**: `869-found-during-cockpit-v1`
**Status**: Complete
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md) (Q1 → A shared predicate · Q2 → A marker+grep · Q3 → A clear-on-all · Q4 → A loud degradation · Q5 → A top-level PR comment)

## Summary

Live smoke test christrudelpw/sniplink#4 / PR #14 showed the request-changes → PR-feedback loop wedging itself: the cockpit posts an inline review authored by the cluster's own GitHub App identity (`author_association: NONE`), the #842 trust filter classifies it as prompt-injection, the handler logs `"No unresolved threads found"` while its own preceding line reports `unresolvedThreads: 1`, strips the `waiting-for:address-pr-feedback` label, exits success, and leaves the `phase-tracker:*:address-pr-feedback` dedupe key marked — so every subsequent poll skips as duplicate until 24h TTL.

Four coordinated changes (per Q1-Q5) close it:

1. **FR-001 / Q1**: Extend `isTrustedCommentAuthor` to accept a `clusterIdentity` context field; the bot-login match already exists, this generalises it into the trust predicate proper. Both monitor and handler call the same function.
2. **FR-005 / Q1**: Monitor moves the trust filter *before* enqueue. `PrFeedbackMonitorService.processPrReviewEvent()` extends its GraphQL projection to pull `author.login` + `authorAssociation` per unresolved-thread comment (already exposed by `getPRReviewThreads`), calls the shared predicate, and skips enqueue when every comment is untrusted.
3. **FR-002 / FR-003 / FR-004 / Q2 / Q5**: On the monitor's zero-trusted transition, emit a `warn` log naming the skipped authors, and post a single top-level PR comment via `gh pr comment` marked with `<!-- generacy:pr-feedback-untrusted-notice -->`. Idempotency by grep against `gh pr view --json comments` for the marker; one notice per episode; old notices left as audit trail.
4. **FR-006 / Q3**: Handler clears the `phase-tracker:*:address-pr-feedback` key on every terminal exit path (success, zero-trusted retention that survives race-window mismatch, and every caught exception). Uses `PhaseTracker.clear()` already in the interface.
5. **FR-007 / Q4**: Cluster-identity resolution failure at handler runtime → `error`-level log naming each chain link tried (`config → CLUSTER_GITHUB_USERNAME → GH_USERNAME → gh api user`), then handler continues to apply FR-002/FR-003/FR-004 unconditionally. Association-trusted comments still process. No new error class; worker not marked failed.

The handler's zero-trusted retention (FR-002/FR-003) stays wired as defense-in-depth for the race window where a comment is edited/deleted between monitor poll and worker claim.

## Technical Context

**Language/Version**: TypeScript 5.x, Node ≥22 (ESM, matches existing packages)
**Primary Dependencies**:
- `@generacy-ai/workflow-engine` — `isTrustedCommentAuthor`, `getPRReviewThreads`, `GhCliGitHubClient`, `Comment`/`ReviewThread` types
- `@generacy-ai/orchestrator` — `PrFeedbackMonitorService`, `PrFeedbackHandler`, `PhaseTracker`, `resolveClusterIdentity`
- `zod` for the extended trust-config schema (no change expected — `CommentTrustContext` is a plain interface)
**Storage**:
- Redis (existing `PhaseTrackerService`) for `phase-tracker:<owner>:<repo>:<issue>:address-pr-feedback` clear-on-exit.
- GitHub PR comments carry the FR-004 idempotency marker in-body; no new store.
- `.agency/comment-trust.yaml` remains unchanged (widen-config is orthogonal to Q1's cluster-identity trust).
**Testing**: `vitest` (workspace-standard). New unit tests co-located under `packages/workflow-engine/src/security/__tests__/` and `packages/orchestrator/src/{worker,services}/__tests__/`.
**Target Platform**: Linux (orchestrator container, uid 1001).
**Project Type**: Monorepo — worker changes in `packages/orchestrator`, shared predicate in `packages/workflow-engine`.
**Performance Goals**: One additional GraphQL field per unresolved-thread comment (already returned; no extra round trip). Notice-posting adds at most one `gh pr view` + one `gh pr comment` per zero-trusted transition per PR (rate limit safe — 60s poll cadence, one PR per event).
**Constraints**:
- No new state stores (Q2-A rejects a Redis-backed notice key; would be dead code the moment #862 lands).
- No new error classes (Q4-A rules out `ClusterIdentityUnresolvedError`).
- Cannot resolve threads from the bot (Q5-C explicitly rejected — preserves operator's unresolved-conversations signal).
- FR-004 notice MUST be a top-level PR comment, not a review-thread reply (Q5-A prevents the self-trust loop that FR-001 would otherwise open).
**Scale/Scope**: One live PR (#14) plus fixture-driven regression; no fleet-scale rollout concerns. Live confirmation reruns christrudelpw/sniplink#4.

## Constitution Check

`.specify/memory/constitution.md` does not exist in this repo. No gates to check.

**Pre-Phase 0 gates (from repo conventions)**:
- **No new state stores**: PASS — clear-on-exit reuses `PhaseTracker.clear()`, notice idempotency reuses grep-against-PR-comments (existing pattern in codebase per Q2 answer).
- **Shared predicate**: PASS — Q1-A collapses monitor+handler to one call site of `isTrustedCommentAuthor`, matching the SC-005 grep audit.
- **Forward-compatible with #862**: PASS — FR-006's "clear on all terminal exits" translates directly to whatever #862 calls "settled" (the invariant is over exit paths, not over key layout).
- **No new error classes**: PASS — Q4-A explicitly rules out `ClusterIdentityUnresolvedError`.

**Post-Phase 1 re-check**: no violations introduced by the design in `data-model.md`. The `clusterIdentity` field on `CommentTrustContext` is an additive interface change; all existing callers continue to type-check.

## Project Structure

### Documentation (this feature)

```text
specs/869-found-during-cockpit-v1/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── trust-predicate.md          # isTrustedCommentAuthor extension
│   ├── monitor-decision.md         # PrFeedbackMonitorService trust-aware enqueue + notice-posting
│   └── handler-exit-paths.md       # PrFeedbackHandler dedupe-clear invariant + degraded-identity behavior
├── spec.md              # (read-only)
├── clarifications.md    # (read-only)
└── tasks.md             # /speckit:tasks output — NOT created here
```

### Source Code (repository root)

```text
packages/workflow-engine/src/
├── security/
│   ├── comment-trust.ts                # MODIFIED: CommentTrustContext.clusterIdentity + trust rule
│   └── __tests__/
│       └── comment-trust.test.ts       # MODIFIED: cluster-identity trust cases
└── actions/github/client/
    └── gh-cli.ts                       # UNCHANGED — GraphQL already returns author.login + authorAssociation

packages/orchestrator/src/
├── services/
│   ├── pr-feedback-monitor-service.ts  # MODIFIED: shared-predicate filter before enqueue; zero-trusted notice
│   ├── identity.ts                     # UNCHANGED — chain reused as-is
│   └── __tests__/
│       └── pr-feedback-monitor-service.test.ts   # NEW cases: trust-aware enqueue, notice idempotency
└── worker/
    ├── pr-feedback-handler.ts          # MODIFIED: dedupe-clear on all exit paths; degraded-identity FR-007
    └── __tests__/
        └── pr-feedback-handler.test.ts # NEW cases: all-exits-clear-key; identity-unresolvable path

packages/orchestrator/src/types/
└── monitor.ts                          # UNCHANGED — PhaseTracker.clear() already in interface

# Regression harness — replay of PR #14 scenario
packages/orchestrator/src/__tests__/
└── pr-feedback-integration.test.ts     # MODIFIED: add cluster-identity trusted comment case
```

**Structure Decision**: Existing monorepo layout, one-file surgery per package. No new packages, no new directories except the standard `__tests__/` co-location.

**Cross-repo scope note**: entirely in-tree in the `generacy` repo. No cockpit-web, cluster-base, generacy-cloud, or workflow-engine plugin work required.

## Complexity Tracking

No constitutional violations. No table to fill.

**Non-obvious design decisions (documented for future readers)**:

| Decision | Alternative rejected | Reason |
|----------|---------------------|--------|
| Extend `CommentTrustContext` with `clusterIdentity` field | Add `resolveClusterIdentity()` call inside the predicate | Predicate must stay pure; identity resolution is I/O and belongs to the caller. Field on the context is the only additive way. |
| Monitor posts the FR-004 notice, not the handler | Handler posts on zero-trusted retention path | Q1-A moves the trust filter to the monitor, so with the shared predicate the handler never sees a pure zero-trusted state (only race-window residues). The monitor already tracks `lastUnresolvedThreadCount` for state-transition logging — extending that one map to also track `lastZeroTrustedState` is cheaper than adding a second tracker in the handler. |
| Notice idempotency via body-marker grep, not Redis | Redis key `pr-feedback-untrusted-notice:<pr>` | Q2-A: minting new state-store keys with their own TTL/settlement is the class of machinery #862 is scheduled to delete. Marker-grep is the codebase's established pattern (`<!-- generacy-stage:… -->`, `<!-- cockpit -->`, #865). |
| Handler clears on **all** exception classes, not just transient | Distinguish transient vs. permanent by error shape | Q3-A: transient-vs-permanent classification is machinery #862 will delete; busy-loop risk on persistent failure is bounded (60s poll, diagnosable) and preferable to a TTL strand (silent, undiagnosable — #861's exact pathology). |
| No new error class for identity-unresolvable | `ClusterIdentityUnresolvedError` thrown from handler | Q4-A: identity-unresolvable is a *misconfiguration*, not a workflow failure. Throwing escalates it into the worker's error path and can mark the issue failed. Better to log at `error` level naming the failed chain and continue in degraded mode. |
| Notice as top-level PR comment, not thread reply | Reply on each thread + marker-based skip rule inside predicate | Q5-A: a thread-reply notice authored by the cluster identity, under FR-001's expanded trust set, would be re-picked up as trusted-unresolved feedback next poll → self-trust loop. Placement outside the review-thread scan sidesteps the loop by construction. |
