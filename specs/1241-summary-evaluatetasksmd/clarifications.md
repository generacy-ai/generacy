# Clarification Questions

## Status: Pending

## Batch 1 — 2026-11-27

### Q1: Fix scope across duplicate match sites
**Context**: The identical `startsWith(\`${issueNumber}-\`)` prefix-match bug exists at five other call sites: `packages/orchestrator/src/worker/epic-post-tasks.ts:302`, `packages/workflow-engine/src/actions/github/preflight.ts:298`, `packages/workflow-engine/src/actions/github/get-context.ts:123`, `packages/workflow-engine/src/actions/epic/post-tasks-summary.ts:55`, and `packages/generacy/src/cli/commands/cockpit/context.ts:408`. All of them fail to resolve zero-padded spec dirs for issues below 100, while `clarification-poster.ts:218` already uses the numeric `^(\d+)-` match the spec mandates. The spec currently scopes all FRs to `tasks-md-fallback.ts` only, so without a decision the same defect ships unfixed in the phase-loop's neighbouring resolvers.
**Question**: Should this change fix only `tasks-md-fallback.ts` as specified, or also convert the other five prefix-match sites to numeric matching?
**Options**:
- A) Safety net only: patch `tasks-md-fallback.ts` per the current spec and file a follow-up issue enumerating the other five sites.
- B) All sites: extract one shared numeric spec-dir matcher and use it at all six sites (plus `clarification-poster.ts`) in this change, accepting a three-package changeset.
- C) Orchestrator only: fix `tasks-md-fallback.ts` and `epic-post-tasks.ts` now (single package, single changeset); follow-up issue for the workflow-engine and CLI sites.
**Answer**: *Pending*

### Q2: Numeric collision with legacy sequence-numbered dirs
**Context**: Numeric matching makes issue 6 resolve `specs/006-…` even when that directory's number comes from spec-kit's sequential feature counter rather than an issue number — e.g. this repo's own `specs/006-job-scheduler-queue-system` predates issue-number-keyed naming. Under the current string match, issue 6 gets `unreadable` (fail-open advance); under the numeric match it would read an unrelated `tasks.md` and could synthesize a spurious re-entry. The no-progress guard bounds the damage to roughly one wasted implement cycle, but it is a new false-positive mode the spec does not currently acknowledge.
**Question**: Is the false-positive risk from legacy sequence-numbered directories acceptable as-is, or should the resolver prefer an exact (non-padded) match when one exists?
**Options**:
- A) Accept as-is: numeric match treats any `^(\d+)-` dir with the same numeric value as the issue's spec dir; document the collision risk in the spec's Assumptions.
- B) Exact-match preference: when a dir named exactly `${issueNumber}-…` (non-padded) exists, it wins outright; padded variants are only consulted when no exact match exists, and the both-exist→`unreadable` ambiguity guard in US2 is replaced by this precedence rule.
**Answer**: *Pending*
