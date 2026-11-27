# Clarification Questions

## Status: Complete

## Batch 1 — 2026-11-27

### Q1: Fix scope across duplicate match sites
**Context**: The identical `startsWith(\`${issueNumber}-\`)` prefix-match bug exists at five other call sites: `packages/orchestrator/src/worker/epic-post-tasks.ts:302`, `packages/workflow-engine/src/actions/github/preflight.ts:298`, `packages/workflow-engine/src/actions/github/get-context.ts:123`, `packages/workflow-engine/src/actions/epic/post-tasks-summary.ts:55`, and `packages/generacy/src/cli/commands/cockpit/context.ts:408`. All of them fail to resolve zero-padded spec dirs for issues below 100, while `clarification-poster.ts:218` already uses the numeric `^(\d+)-` match the spec mandates. The spec currently scopes all FRs to `tasks-md-fallback.ts` only, so without a decision the same defect ships unfixed in the phase-loop's neighbouring resolvers.
**Question**: Should this change fix only `tasks-md-fallback.ts` as specified, or also convert the other five prefix-match sites to numeric matching?
**Options**:
- A) Safety net only: patch `tasks-md-fallback.ts` per the current spec and file a follow-up issue enumerating the other five sites.
- B) All sites: extract one shared numeric spec-dir matcher and use it at all six sites (plus `clarification-poster.ts`) in this change, accepting a three-package changeset.
- C) Orchestrator only: fix `tasks-md-fallback.ts` and `epic-post-tasks.ts` now (single package, single changeset); follow-up issue for the workflow-engine and CLI sites.
**Answer**: B — All sites: extract one shared numeric spec-dir resolver into `@generacy-ai/workflow-engine` and use it at all six prefix-match sites (`tasks-md-fallback.ts`, `epic-post-tasks.ts:302`, `preflight.ts:298`, `get-context.ts:123`, `post-tasks-summary.ts:55`, `cockpit/context.ts:408`) plus `clarification-poster.ts`; leave the branch-name `startsWith` checks (`preflight.ts:199/344`, `epic-post-tasks.ts:330`) unchanged since they match branches, not spec dirs. Rationale: workflow-engine has no internal deps and both orchestrator and the generacy CLI already depend on it, so the shared helper adds no build cycle, and the Q2 precedence rule then lives in one place instead of seven drifting copies. *(Answered by @christrudelpw on GitHub, 2026-11-27)*

### Q2: Numeric collision with legacy sequence-numbered dirs
**Context**: Numeric matching makes issue 6 resolve `specs/006-…` even when that directory's number comes from spec-kit's sequential feature counter rather than an issue number — e.g. this repo's own `specs/006-job-scheduler-queue-system` predates issue-number-keyed naming. Under the current string match, issue 6 gets `unreadable` (fail-open advance); under the numeric match it would read an unrelated `tasks.md` and could synthesize a spurious re-entry. The no-progress guard bounds the damage to roughly one wasted implement cycle, but it is a new false-positive mode the spec does not currently acknowledge.
**Question**: Is the false-positive risk from legacy sequence-numbered directories acceptable as-is, or should the resolver prefer an exact (non-padded) match when one exists?
**Options**:
- A) Accept as-is: numeric match treats any `^(\d+)-` dir with the same numeric value as the issue's spec dir; document the collision risk in the spec's Assumptions.
- B) Exact-match preference: when a dir named exactly `${issueNumber}-…` (non-padded) exists, it wins outright; padded variants are only consulted when no exact match exists, and the both-exist→`unreadable` ambiguity guard in US2 is replaced by this precedence rule.
**Answer**: B — Exact-match preference: a dir named exactly `${issueNumber}-…` (non-padded) wins outright; zero-padded variants are consulted only when no exact match exists, replacing the US2 both-exist→`unreadable` guard. Also add to Assumptions the residual risk: when only a legacy sequence-numbered padded dir exists (e.g. `specs/006-job-scheduler-queue-system`), it can still be read for a low-numbered issue — bounded by the no-progress guard; branch-name resolution stays out of scope. Rationale: issue-keyed dirs in this repo are non-padded, so when both `6-foo` and a legacy `006-…` exist B resolves the right one where A would fail open as `unreadable` (the exact miss this bug fixes); B is identical to A in every other case. *(Answered by @christrudelpw on GitHub, 2026-11-27)*
