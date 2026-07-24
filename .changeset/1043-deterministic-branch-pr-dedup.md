---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
---

Deterministic branch/spec-slug + PR dedup on speckit workflow re-entry (#1043).

Speckit workflows re-entering `implement` (e.g., after
`cockpit_advance(implementation-review)`) could re-derive a different branch
slug from a mutated description, miss the existing `specs/<N>-*` idempotency
check in `createFeature()`, and open a duplicate PR alongside the real one
(as observed in generacy-cloud#850 / #1038 → PR #1041 orphaning PR #1039).

Fix: new pure resolver `resolveIssueBranch()` in
`@generacy-ai/workflow-engine` that returns the canonical `<N>-<slug>`
branch for an issue by querying remote state only (open PRs on `<N>-*`
branches first, oldest `<N>-*` remote branch as fallback). Two callers:
`CreateFeatureInput` gains an optional `resolveExistingBranch` callback
that lets `createFeature()` skip slug re-derivation when a canonical
branch already exists; `PrManager.ensureDraftPr()` runs the resolver as
defense-in-depth and adopts the canonical PR instead of opening a
duplicate on mismatch. Slug-generation logic is unchanged — the callback
returning `null` falls back to the existing derivation path.

Emits structured events for observability: `workflow-reentry-branch-reused`
(happy path, SC-003) and `workflow-reentry-branch-mismatch` (defensive
path, FR-005).
