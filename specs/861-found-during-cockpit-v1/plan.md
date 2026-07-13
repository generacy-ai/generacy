# Implementation Plan: Fix address-pr-feedback loop (thread-shaped review API)

**Feature**: Replace `getPRComments`+`Comment.resolved` (always `undefined`) with a thread-shaped GraphQL review-threads API so PR-feedback monitor, preflight, and read-pr-feedback see real thread resolution state.
**Branch**: `861-found-during-cockpit-v1`
**Date**: 2026-07-08
**Status**: Complete
**Spec**: [spec.md](./spec.md)

## Summary

The address-pr-feedback loop has never functioned. `GhCliClient.getPRComments` calls REST `/repos/{owner}/{repo}/pulls/{n}/comments`, whose payload has no `resolved` field — so `Comment.resolved` is `undefined` on every comment, and three consumers silently no-op:

- `PrFeedbackMonitorService` filters `c.resolved === false && !c.in_reply_to_id` → matches nothing → no PR feedback is ever enqueued.
- `preflight.ts` counts `c.resolved === false` → `unresolved_comments` is permanently 0.
- `read-pr-feedback.ts` filters `c.resolved !== true` → passes everything → unresolved-only mode is a no-op.

Fix: introduce a thread-shaped client method `getPRReviewThreads(owner, repo, number): Promise<ReviewThread[]>` backed by a GraphQL query on `pullRequest.reviewThreads`. Deprecate `getPRComments()`; migrate all three consumers in the same PR. Rename `preflight.unresolved_comments` → `unresolved_threads` (no cross-repo readers found in-repo; only two in-code sites touch the field). Auth-shaped GraphQL failures (401/403) route through the existing `#762 GhAuthError` auth-health path; transient failures (5xx / rate-limit) log at `warn` and rely on the next poll cycle. The monitor's zero-unresolved decision fires at `info` only on state transitions; steady-state polls stay at `debug`.

Regression coverage: a captured JSON fixture at `packages/orchestrator/src/services/__tests__/fixtures/pr-comments-rest.json` (from live sniplink#15 payload, bodies trimmed to placeholders, header with source PR + capture date) drives the monitor regression test. Inline literals in `preflight` and `read-pr-feedback` unit tests.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >=22 (ESM).
**Primary Dependencies**:
- `@generacy-ai/workflow-engine` (`packages/workflow-engine/`) — owns `GhCliClient`, `Comment` / `ReviewThread` types, `preflight`, `read-pr-feedback`.
- `@generacy-ai/orchestrator` (`packages/orchestrator/`) — owns `PrFeedbackMonitorService`.
- `gh` CLI ≥ 2.x — `gh api graphql -f query=...` for the GraphQL query; already used elsewhere in `gh-cli.ts`.
- Existing `GhAuthError` + `parseGhStatusCode()` in `gh-cli.ts:30-48` — reused for 401/403 dispatch.
- Existing `AuthHealthSink` wiring (`GitHubAuthHealthService`, `#762`) — reused unchanged; monitor already threads it into 401 paths at `pr-feedback-monitor-service.ts:347,397`.
**Storage**: N/A (in-flight API refactor). No persisted state changes.
**Testing**: `vitest` (existing config in each package).
**Target Platform**: In-cluster orchestrator (Linux, Node 22 container).
**Project Type**: single (monorepo package refactor).
**Performance Goals**: Match today's poll cadence (~60s per monitored PR). GraphQL replaces one REST call with one GraphQL call — same round-trip budget.
**Constraints**: (a) No silent REST fallback on GraphQL failure (that reintroduces the bug). (b) `getPRComments()` deprecated but not deleted in this PR — leave with a `@deprecated` JSDoc tag so external callers (if any surface later) see the migration path; no in-repo callers after the PR. (c) State-transition info logging must be process-local — no Redis / persistent state.
**Scale/Scope**: 3 consumer sites, 1 new client method, 1 renamed field. ~200–300 LOC changed, ~150 LOC new tests.

## Constitution Check

*Gate: verified before writing artifacts, re-verified after.*

No `.specify/memory/constitution.md` exists — no explicit constitution to check against. Applying the implicit repo conventions the spec calls out:

- **No names that lie** — the rename `unresolved_comments` → `unresolved_threads` is load-bearing (Q2→C). ✅ satisfied by data-model.
- **No silent fallback to the always-`undefined` field** — GraphQL failure surface is defined explicitly by class (Q3→B). ✅ satisfied by research.md's failure-handling section.
- **Regression fixture must not encode the code's assumptions** — captured live payload with no `resolved` field for the monitor test; inline literals for the smaller unit tests (Q5→C). ✅ satisfied by contracts and quickstart.
- **Deprecate, don't delete, `getPRComments()`** — allows future external consumers to see the migration path; zero in-repo callers after the PR. ✅ documented in research.

Cross-repo reader verification (Q2→C fallback trigger): `unresolved_comments` grep across `packages/` shows exactly two sites — `packages/workflow-engine/src/actions/github/preflight.ts:255` and `packages/workflow-engine/src/types/github.ts:265`. No cross-repo consumers, no cross-package consumers. **No fallback to Q2→A needed.**

## Project Structure

### Documentation (this feature)

```text
specs/861-found-during-cockpit-v1/
├── spec.md                # Feature specification (read-only)
├── clarifications.md      # Q1–Q5 answers (read-only)
├── plan.md                # This file
├── research.md            # Phase 0: technology + failure-handling decisions
├── data-model.md          # Phase 1: ReviewThread / Comment / PreflightOutput shapes
├── quickstart.md          # Phase 1: migration walkthrough + repro steps
├── contracts/
│   ├── getPRReviewThreads.md   # Client method contract + GraphQL query
│   └── monitor-decision.md     # PrFeedbackMonitorService decision table
├── checklists/            # (empty — no /speckit.checklist run yet)
└── tasks.md               # Phase 2 output (/speckit.tasks — NOT this command)
```

### Source Code (repository root)

Files touched in this feature:

```text
packages/workflow-engine/src/
├── actions/github/
│   ├── client/
│   │   ├── gh-cli.ts          # ADD getPRReviewThreads(); @deprecate getPRComments()
│   │   └── interface.ts       # ADD getPRReviewThreads() to GitHubClient interface
│   ├── preflight.ts           # MIGRATE to getPRReviewThreads(); rename field
│   └── read-pr-feedback.ts    # MIGRATE to getPRReviewThreads(); use thread resolution
└── types/
    └── github.ts              # ADD ReviewThread; RENAME preflight.unresolved_comments;
                               # LEAVE Comment.resolved for now (@deprecated), consumers
                               # no longer read it — safe to remove in a follow-up

packages/workflow-engine/tests/actions/github/
├── read-pr-feedback.test.ts   # UPDATE — assert thread-based filtering (inline literals)
└── preflight.test.ts          # UPDATE — assert unresolved_threads output (inline literals)

packages/orchestrator/src/
└── services/
    └── pr-feedback-monitor-service.ts   # MIGRATE fetch call; state-transition info log

packages/orchestrator/src/services/__tests__/
├── pr-feedback-monitor-service.test.ts  # UPDATE — regression against fixture
└── fixtures/
    └── pr-comments-rest.json            # NEW — captured sniplink#15 payload
                                         # (header with source PR + capture date;
                                         # bodies trimmed to placeholders)
```

**Structure Decision**: Single monorepo — no new packages, no cross-cutting infra. All changes stay within `packages/workflow-engine/` (client, types, two consumers, two tests) and `packages/orchestrator/services/` (monitor + regression test + fixture). Existing package boundaries respected; no new dependencies added.

## Complexity Tracking

*No Constitution Check violations — table intentionally empty.*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_ | | |
