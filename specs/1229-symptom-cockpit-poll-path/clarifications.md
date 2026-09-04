# Clarifications: Scope cockpit poll events to the epic's resolved ref set

## Batch 1 — 2026-09-04

### Q1: PR-ref resolution on the poll path
**Context**: FR-003 defers this decision to clarify. The poll path's PR branch (`buildPrSnapshot`, `derivePrLifecycle`, `derivePrChecksNeeded`) is dead because `gh search issues` implies `is:issue`. The poll source is the fallback when smee is unavailable — if the PR branch is removed, poll-only runs get **no PR lifecycle/checks events at all**, and merge-gating in `/cockpit:auto` would depend entirely on smee availability.
**Question**: Should PR refs from the epic body be polled through a path that actually returns PRs, or should the dead PR branch be removed with smee-only PR sourcing documented?
**Options**:
- A: Poll PRs properly — query in a form that returns both issues and PRs (e.g. raw `search/issues` without the implied `is:issue`, or exact-lookup by number), keeping the existing PR branch alive.
- B: Remove the PR branch from the poll path; document that PR lifecycle/checks events are smee-sourced only (accepting no PR events in poll-fallback mode).

**Answer**: *Pending*

### Q2: Scope-enforcement mechanism
**Context**: FR-001 allows post-filtering `curr`, a non-free-text query form, or both. GitHub search has no exact issue-number qualifier, so a "query that cannot match free text" means switching to exact lookups (e.g. one batched GraphQL call per repo via aliased `issueOrPullRequest(number:)` — which would also return PRs, interacting with Q1). Post-filtering the existing search results against `deps.refs` is minimal and adds zero API calls, but keeps over-fetching from search.
**Question**: Which enforcement mechanism should the fix use?
**Options**:
- A: Post-filter only — keep the current search query, drop any result whose `repo#number` is not in the resolved ref set before snapshotting.
- B: Exact-lookup query — replace search with batched exact-number lookups (structurally cannot match free text; also returns PRs).
- C: Both — exact-lookup (or fixed query) plus a defensive post-filter against the ref set.

**Answer**: *Pending*

### Q3: Strictness of the API-budget freeze (FR-004)
**Context**: FR-004 says the fix must not increase GitHub API calls per poll cycle. But if Q1 resolves to polling PRs properly, the currently-dead PR branch comes alive: `derivePrLifecycle` and the gated check-runs fetch will make per-PR calls that today never happen. That is an increase relative to the (buggy) baseline, though it is the intended cost of working PR polling and is already rate-gated by `derivePrChecksNeeded`.
**Question**: Does FR-004's "no increase" apply strictly to total calls (which would force removing the PR branch), or only to the per-repo search/list calls, with gated per-PR calls accepted as the cost of correct PR polling?
**Options**:
- A: Search/list calls only — per-PR calls gated by `derivePrChecksNeeded` are acceptable when PR polling is enabled.
- B: Strict total freeze — no new calls of any kind, effectively deciding Q1 toward removing the PR branch.

**Answer**: *Pending*
