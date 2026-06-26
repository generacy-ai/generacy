# Feature Specification: Epic: generacy-ai/tetrad-development#85 | Phase: P1 | Tier: v1-core | Issue: G1.3

**Branch**: `789-epic-generacy-ai-tetrad` | **Date**: 2026-06-26 | **Status**: Draft

## Summary

Epic: generacy-ai/tetrad-development#85 | Phase: P1 | Tier: v1-core | Issue: G1.3

Add `generacy cockpit merge <issue>` (completed:validate + green checks -> squash-merge to develop; red -> exit nonzero with failing-check JSON; never merges on red) and `generacy cockpit review-context <issue>` (gather PR diff + checks for the review skill).

Owns (isolation): `packages/generacy/src/cli/commands/cockpit/{merge,review-context}.ts`

Acceptance: Merges a green PR; on red exits nonzero with failing checks; review-context emits PR summary data.

Depends on: G0.1 (#786 — @generacy-ai/cockpit engine foundation package)

---
Part of the Epic Cockpit. Plan: docs/epic-cockpit-plan.md in tetrad-development (P1 / G1.3).


## Clarifications

### Batch 1 — 2026-06-26

- **Q1 — Engine API surface**: Extend the cockpit engine's `GhCliWrapper` in this PR with `resolveIssueToPR(repo, issue)`, `getPullRequest(repo, pr)` (metadata + diff), and `mergePullRequest(repo, pr, { squash })`. SC-005 (no `gh` shell-outs outside the engine) is preserved. Coordinate `resolveIssueToPR` / `getPullRequest` with #787 — define once, reuse.
- **Q2 — Failing-check JSON shape**: `{ status: "red", reason: "checks-failing" | "missing-label" | "unresolved", pr: { number, url }, failingChecks: [{ name, state, url? }] }`. The `reason` discriminator routes downstream callers (fixer vs. "not ready / missing `completed:validate`" vs. unresolved threads).
- **Q3 — Required-check set**: Derive "required" from `develop`'s branch protection (`gh api repos/{owner}/{repo}/branches/develop/protection`); "missing" = a protected check absent on the PR. On 403 (token can't read branch protection), fall back to "every check present on the PR must be green" and emit a warning.
- **Q4 — Pending-check behavior**: Fail-fast. Any pending / in-progress / queued check → exit red immediately with the failing-check JSON. No blocking poll in `cockpit merge`; `watch` (#787) is responsible for re-triggering once green.
- **Q5 — `review-context` payload**: Single JSON object on stdout: `{ pr: { number, title, url, base, head, body, author, state, draft }, diff: "<unified diff text>", checks: [{ name, state, conclusion?, url? }] }`. Diff is a text blob with a max-bytes cap. `reviewComments` / `commits` deferred.

## User Stories

### US1: Safe one-shot squash-merge of a completed issue's PR

**As a** human operator (or supervising automation) closing out an issue,
**I want** to run `generacy cockpit merge <issue>` and have it squash-merge the issue's PR to `develop` only when the PR is on `completed:validate` and every required check is green,
**So that** I can confidently merge without manually inspecting labels, checks, and PR state — and so that a red build cannot slip through.

**Acceptance Criteria**:
- [ ] Resolves the PR associated with `<issue>` via the cockpit engine (#786).
- [ ] Refuses to merge unless the PR carries the `completed:validate` workflow label.
- [ ] Refuses to merge when any required check is failing, pending, or missing; exits non-zero and emits a JSON object describing the failing checks on stdout.
- [ ] On green + `completed:validate`, performs a squash-merge into `develop` and exits 0.
- [ ] Never performs a merge on a red PR under any circumstance (no `--force` escape hatch in this scope).

### US2: Structured review context for the review skill

**As a** review skill (or a developer invoking it),
**I want** to run `generacy cockpit review-context <issue>` and receive a single structured payload of PR diff + check results,
**So that** the review skill can consume one canonical source instead of re-discovering the PR, fetching diffs, and stitching together check results itself.

**Acceptance Criteria**:
- [ ] Resolves the PR associated with `<issue>` via the cockpit engine (#786).
- [ ] Emits a machine-readable summary payload to stdout including (at minimum) PR metadata, diff, and check results.
- [ ] Exits 0 when the payload is successfully gathered, even when checks are failing (this verb is descriptive, not gating).
- [ ] Exits non-zero with a clear error when the issue / PR cannot be resolved.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `cockpit merge <issue>` subcommand under `packages/generacy/src/cli/commands/cockpit/merge.ts`. | P1 | Wired via the existing cockpit command group registration. |
| FR-002 | `merge` must look up the PR for `<issue>` via the cockpit engine API (issue→PR resolution from G0.1). | P1 | Per Q1: extend `GhCliWrapper` with `resolveIssueToPR(repo, issue)`. Coordinate with #787. |
| FR-003 | `merge` must verify the PR carries the `completed:validate` workflow label before doing anything else. | P1 | Label name comes from `WORKFLOW_LABELS` (workflow-engine), not a hardcoded string. Missing label → red with `reason: "missing-label"` (Q2). |
| FR-004 | `merge` must fetch PR check results and treat any non-success state (failure, pending, missing required) as red. Pending/in-progress/queued checks are red — fail-fast, no polling (Q4). | P1 | Required-check set derived from `develop`'s branch protection (Q3); on 403 fall back to "every check present must be green" + warn. |
| FR-005 | On red, `merge` must exit non-zero and write a JSON object to stdout of the shape `{ status: "red", reason: "checks-failing" \| "missing-label" \| "unresolved", pr: { number, url }, failingChecks: [{ name, state, url? }] }` (Q2). | P1 | The `reason` discriminator routes downstream callers. |
| FR-006 | On green + `completed:validate`, `merge` must perform a squash-merge into `develop` and exit 0. | P1 | Per Q1: extend `GhCliWrapper` with `mergePullRequest(repo, pr, { squash })`. |
| FR-007 | `merge` must never perform a merge when the red path is taken — no override flag in this scope. | P1 | Safety property; covered by tests. |
| FR-008 | Add `cockpit review-context <issue>` subcommand under `packages/generacy/src/cli/commands/cockpit/review-context.ts`. | P1 | Wired via the existing cockpit command group registration. |
| FR-009 | `review-context` must emit a single JSON object to stdout of the shape `{ pr: { number, title, url, base, head, body, author, state, draft }, diff: "<unified diff text>", checks: [{ name, state, conclusion?, url? }] }`. `diff` is a text blob capped at a configurable max-bytes limit (Q5). | P1 | Per Q1: PR metadata + diff come from `GhCliWrapper.getPullRequest(repo, pr)`. `reviewComments` / `commits` deferred. |
| FR-010 | Both commands must exit non-zero with a clear error message when the issue or PR cannot be resolved. | P1 | Don't silently emit empty output. |
| FR-011 | Isolate all new files under `packages/generacy/src/cli/commands/cockpit/` per the epic's ownership rule. | P1 | Avoid touching other packages outside the engine API surface from G0.1. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Squash-merge of a green `completed:validate` PR succeeds end-to-end. | 100% in test scenario | Run `cockpit merge <issue>` against a fixture / live PR; verify merge commit on `develop` and exit code 0. |
| SC-002 | Red PR is never merged. | 0 merges on red across all tests | Run `cockpit merge` against PRs with failing/pending/missing checks; assert no merge and exit code != 0. |
| SC-003 | Failing-check JSON is parseable and lists every non-green check. | Schema-valid for all red cases | Parse stdout with the published schema and diff against expected check set. |
| SC-004 | `review-context` payload contains diff + checks for a known PR. | Required fields present | Snapshot test against a fixture PR; assert PR metadata, diff, and checks are non-empty. |
| SC-005 | Both verbs reuse the cockpit engine API (no duplicated gh/PR logic). | 0 direct `gh` calls outside engine layer | Grep new files for `gh ` shell-outs; only engine-mediated calls allowed. |

## Assumptions

- The cockpit engine package (#786, G0.1) is available and exposes: label-state classification (`WORKFLOW_LABELS`) and PR-checks fetching. Issue→PR resolution, PR metadata/diff, and squash-merge are added to `GhCliWrapper` in this PR (Q1) and coordinated with #787.
- `develop` is the merge target; this is not configurable in this scope.
- `gh` CLI auth is already established in the environment running the command (per cockpit engine defaults from G0.1). When the token cannot read `develop`'s branch protection (HTTP 403), `merge` falls back to "every check present on the PR must be green" with a warning (Q3).
- The PR has a single associated issue (`<issue>`); multi-issue PRs are out of scope.
- `completed:validate` is the canonical "ready to merge" label — gating on it is sufficient; we do not additionally check reviewer approval state here.
- Pending/in-progress/queued checks are treated as red without polling. Re-triggering `merge` once checks turn green is the responsibility of `watch` (#787), not this verb (Q4).

## Out of Scope

- A `--force` / override flag for merging red PRs.
- Configurable merge targets other than `develop`.
- Configurable merge strategies other than squash.
- Multi-issue / multi-PR batch merging.
- Posting the failing-check JSON back to the PR as a comment.
- The review skill itself (this issue produces its input; the skill is consumed elsewhere).
- Any UI surface — these are CLI verbs only.

---

*Generated by speckit*
