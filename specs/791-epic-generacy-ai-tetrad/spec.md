# Feature Specification: Epic: generacy-ai/tetrad-development#85 | Phase: P3 | Tier: v2-pipeline | Issue: G3

**Branch**: `791-epic-generacy-ai-tetrad` | **Date**: 2026-06-26 | **Status**: Draft

## Summary

Epic: generacy-ai/tetrad-development#85 | Phase: P3 | Tier: v2-pipeline | Issue: G3.2

Add 'generacy cockpit queue <phase>': assign the phase's issues to the cluster account and add process:speckit-feature (confirm-gated).

Owns (isolation): packages/generacy/src/cli/commands/cockpit/queue.ts

Acceptance: Queues exactly the named phase's issues.

Depends on: G0.1, G3.1 (see the epic checklist for issue numbers)

---
Part of the Epic Cockpit. Plan: docs/epic-cockpit-plan.md in tetrad-development (P3 / G3.2).


## User Stories

### US1: Queue a whole phase in one command

**As a** cockpit operator driving an epic through phases,
**I want** to assign every open issue in a named phase to the cluster account and apply `process:speckit-feature` in a single confirm-gated command,
**So that** I can hand a phase off to the cluster pipeline without manually touching each issue.

**Acceptance Criteria**:
- [ ] `generacy cockpit queue <phase>` enumerates exactly the issues belonging to the named phase (no siblings from other phases), reading from the committed epic manifest.
- [ ] Before any mutation, the operator sees the resolved list of issues — eligible ones plus `[SKIP: …]`-marked entries — and confirms (skippable with `--yes`).
- [ ] On confirm, each eligible issue is assigned to the cluster account and labelled with its per-issue workflow label (`process:speckit-bugfix` for `type:bug`, otherwise `process:speckit-feature`).
- [ ] Already-assigned or already-labelled issues are idempotent (no-op, no error).
- [ ] No mutation occurs if confirmation is declined or `<phase>` resolves to zero eligible issues.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Accept a phase name as the positional `<phase>` argument and resolve it to the set of open epic issues belonging to that phase by reading the committed epic manifest (`.generacy/epics/*.yaml`) via G0.1's `readManifest`. Match the phase by its `P<n>` index or its full name. | P1 | Manifest is the sole source of truth for phase→issues grouping. Hard error with a "run `cockpit manifest init` first" hint if no manifest is found. |
| FR-002 | Print the resolved issue set (issue numbers + titles) to stdout before any mutation. Include ineligible issues marked `[SKIP: closed]` or `[SKIP: no phase]` in the preview, plus any cross-repo refs marked `[SKIP: cross-repo]`. | P1 | Operator-visible preview; ineligible entries are visible but non-blocking. |
| FR-003 | Require interactive confirmation before assigning/labelling; support `--yes` to skip the prompt. | P1 | "Confirm-gated" per issue body. The `/cockpit:queue` slash command (#359) owns the interactive UX and calls this verb with `--yes`. |
| FR-004 | Assign each eligible issue to the cluster account. Default the assignee to `gh api user --jq .login` (the in-container `gh` identity); accept a `--assignee <login>` CLI override. | P1 | No new config schema field in this issue; do not error when "unset" — the `gh` login is the correct default. |
| FR-005 | Add the appropriate workflow label to each eligible issue, derived per issue from its `type:` label: `type:bug` → `process:speckit-bugfix`, otherwise `process:speckit-feature`. | P1 | Label add is idempotent. Generalizes the original hard-coded `process:speckit-feature` so mixed-type phases queue correctly. |
| FR-006 | Process every eligible issue best-effort (do not stop on first failure). After processing, exit non-zero if any assign or label call failed; emit a structured per-issue summary showing each issue's assign result and label result. | P1 | Best-effort across issues; idempotency (SC-003) makes a rerun trivial. |
| FR-007 | Register the command via the cockpit auto-register pattern from G0.1. | P1 | No manual wiring in `cockpit/index.ts`. |
| FR-008 | Restrict each invocation to a single repo. If the phase's `issues` span multiple repos, require a `--repo <owner>/<repo>` flag; if the phase is single-repo, default to that repo. Error (no silent filtering) when multi-repo and no flag is given. | P1 | Cross-repo refs in a single-repo invocation are previewed as `[SKIP: cross-repo]` and untouched. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Phase-scoping precision | 100% of queued issues belong to the named phase; 0 issues from other phases are touched. | Run against a multi-phase epic; inspect resulting assignees/labels. |
| SC-002 | Confirm-gate effectiveness | 0 mutations occur when the operator declines the prompt. | Decline-prompt smoke test verifies no `gh` write calls were issued. |
| SC-003 | Idempotency | Re-running `queue <phase>` on an already-queued phase produces no errors and no duplicate label/assignee state. | Run the command twice; second run reports all issues as already-queued. |
| SC-004 | Per-issue label correctness | A phase mixing `type:bug` and feature issues queues each with its correct workflow label (bugfix vs. feature). | Inspect resulting labels on a mixed-type phase. |

## Assumptions

- The epic manifest (`.generacy/epics/<slug>.yaml`) is the source of truth for phase→issues grouping; the reader exists today via G0.1 (#786). The `cockpit manifest init` writer (G3.1 / #790) is the eventual author of new manifests but is not a runtime prereq because a manifest is already committed at `.generacy/epics/epic-cockpit.yaml`.
- The cluster account login equals the in-container `gh` identity (`gh api user --jq .login`); `--assignee` overrides per-invocation.
- The `process:speckit-feature` and `process:speckit-bugfix` labels already exist in the target repo (label provisioning is outside this issue's scope).

## Out of Scope

- Dequeueing or un-assigning issues (no `cockpit dequeue` verb in this issue).
- Cross-repo fan-out in a single invocation — each invocation targets exactly one repo (use `--repo` to disambiguate when the phase spans repos).
- Queueing closed issues, draft issues, or issues without a resolvable phase classification — these appear in the preview as `[SKIP: …]` but are never mutated.
- Bulk re-labelling beyond the per-issue workflow label derived in FR-005.
- Adding a `cockpit.clusterAccount` field to `CockpitConfigSchema` — deferred until dev identity diverges from cluster identity in a real scenario.

## Clarifications

See [clarifications.md](./clarifications.md) for the full Q&A. Summary of decisions integrated above:

- **Q1 (phase enumeration source) → A**: Manifest only; hard error if absent.
- **Q2 (cluster account login) → B+C**: Default to `gh` login; `--assignee` override; no schema change.
- **Q3 (cross-repo phases) → A+B guard**: Single repo per invocation; require `--repo` when phase is multi-repo.
- **Q4 (partial-failure semantics) → A**: Best-effort across issues; structured per-issue summary; non-zero exit on any failure.
- **Q5 (ineligible-issue handling) → B**: Visible-but-skipped in the preview; never mutated.
- **Additional**: Per-issue workflow label is derived from `type:` (`type:bug` → `process:speckit-bugfix`, else `process:speckit-feature`).

---

*Generated by speckit*
