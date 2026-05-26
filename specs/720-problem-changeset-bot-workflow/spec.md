# Feature Specification: Make Changeset Bot a Required, Blocking Check

**Branch**: `720-problem-changeset-bot-workflow` | **Date**: 2026-05-26 | **Status**: Draft
**Issue**: [#720](https://github.com/generacy-ai/generacy/issues/720)
**Workflow**: speckit-bugfix

## Summary

The `Changeset Bot` workflow ([`.github/workflows/changeset-bot.yml`](https://github.com/generacy-ai/generacy/blob/develop/.github/workflows/changeset-bot.yml)) currently emits a `::warning::` and exits 0 when a PR has no changeset. Because the check always passes, it cannot be configured as a required status check, and missing changesets routinely slip through. Convert the check into a hard failure (exit 1) when a PR modifies publishable-package source files (`packages/*/src/`) without including a changeset, then add it as a required status check on `develop`.

## Problem

- The workflow's "Check for changesets" step prints `::warning::No changeset found …` but always exits 0.
- The check appears in PR "Checks" as **passing** regardless of changeset presence, so it cannot meaningfully be required in branch protection.
- **Impact**: ~10 feature PRs from #707 to #717 (the worker-scale architecture) landed without changesets. Every relevant `@generacy-ai/*` package stayed frozen on `stable` for ~6 days while `preview` advanced. The drift was only caught when an end user reported `npx -y @generacy-ai/generacy@stable launch …` did not prompt for workers, requiring [PR #719](https://github.com/generacy-ai/generacy/pull/719) as a bulk catch-up changeset.
- This is the second recurrence; precedent: [`69989cd`](https://github.com/generacy-ai/generacy/commit/69989cd) on 2026-05-19 was also a bulk catch-up. With the check advisory-only, drift is structurally inevitable on any multi-PR feature batch.

## Fix Overview

Replace the always-pass check with a path-scoped, blocking check:

1. Compute the diff between `base.sha` and `head.sha`.
2. If no files match `^packages/[^/]+/src/`, exit 0 (no changeset required).
3. Otherwise, search `.changeset/*.md` (excluding `README.md`). If empty, `::error::` + exit 1 with guidance pointing at `pnpm changeset`.
4. Empty changesets (`pnpm changeset --empty`) satisfy the check for source changes that genuinely warrant no version bump.
5. Manually add `Changeset Bot / Changeset Check` as a required status check on the `develop` branch protection rule.

### Why path-scoped, not blanket

Spec-driven PRs typically include large `specs/<n>-*/` directories alongside code changes. A blanket "every PR needs a changeset" rule would force changesets onto pure docs / spec / CI / dependabot PRs. Scoping to `packages/*/src/` keeps the signal high while leaving the gate strict where it matters.

## User Stories

### US1: PR author modifying publishable code is blocked without a changeset

**As a** contributor opening a PR that modifies `packages/*/src/*`,
**I want** the Changeset Bot check to fail with a clear, actionable error when I forget to include a changeset,
**So that** I cannot accidentally merge a code change that leaves the `stable` channel behind `preview`.

**Acceptance Criteria**:
- [ ] When the PR diff touches at least one file under `packages/*/src/` and `.changeset/` contains no non-README markdown file, the workflow exits with code 1.
- [ ] The error message tells the author to run `pnpm changeset` and mentions the `--empty` escape hatch.
- [ ] Branch protection on `develop` lists `Changeset Bot / Changeset Check` as a required status check, blocking merge until the check passes.

### US2: PR author of a docs/spec/CI-only PR is not blocked

**As a** contributor opening a PR that touches only `specs/`, `docs/`, `.github/`, `README.md`, or other non-publishable paths,
**I want** the Changeset Bot check to pass automatically,
**So that** I am not forced to add a noise changeset for a change that does not affect any published package.

**Acceptance Criteria**:
- [ ] When the PR diff contains no files matching `^packages/[^/]+/src/`, the workflow exits 0 with a message indicating no changeset is required.
- [ ] No `::error::` annotation is emitted in this case.

### US3: PR author can intentionally opt out via an empty changeset

**As a** contributor making a source change that should not bump any package version (comment-only fix, internal refactor, etc.),
**I want** to satisfy the check by adding an empty changeset via `pnpm changeset --empty`,
**So that** the gate stays strict without preventing legitimate no-op-version changes.

**Acceptance Criteria**:
- [ ] A PR that modifies `packages/*/src/*` and contains an empty changeset file under `.changeset/` exits 0.
- [ ] The release workflow downstream consumes the empty changeset without producing a version bump (existing behavior; verified, not changed).

## Functional Requirements

| ID     | Requirement                                                                                                                                                  | Priority | Notes                                                                                  |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|----------------------------------------------------------------------------------------|
| FR-001 | The "Check for changesets" step MUST compute the file diff between `pull_request.base.sha` and `pull_request.head.sha`.                                       | P1       | Requires `fetch-depth: 0` (already in workflow) so both SHAs are reachable.            |
| FR-002 | If no diff file matches the regex `^packages/[^/]+/src/`, the step MUST exit 0 with a log line indicating the check was skipped.                              | P1       | Path scope keeps the gate signal-rich.                                                 |
| FR-003 | If at least one diff file matches `^packages/[^/]+/src/` and `.changeset/` contains no `*.md` file other than `README.md`, the step MUST exit 1.              | P1       | This is the new blocking behavior.                                                     |
| FR-004 | The failure message MUST be emitted as `::error::` and reference both `pnpm changeset` and the `pnpm changeset --empty` escape hatch.                          | P1       | Surfaces in the PR's Checks UI and review summary.                                     |
| FR-005 | The success case (changeset present, source changed) MUST log `Changeset found — ready for release.` and exit 0.                                              | P2       | Preserves existing success log line.                                                   |
| FR-006 | The `develop` branch protection rule MUST be updated (manually, via repo settings) to require `Changeset Bot / Changeset Check`.                              | P1       | Out-of-code action; PR description calls this out for the merger.                      |
| FR-007 | The workflow MUST continue to trigger on `pull_request` events targeting `develop` (or any branch already configured).                                         | P2       | No regression in trigger surface.                                                      |

## Success Criteria

| ID     | Metric                                                                                                                                                       | Target               | Measurement                                                                                          |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------|------------------------------------------------------------------------------------------------------|
| SC-001 | A PR modifying `packages/orchestrator/src/foo.ts` without a changeset cannot be merged into `develop`.                                                       | 100% blocked         | Open a test PR matching this shape; verify the Changeset Bot check fails and "Merge" is disabled.    |
| SC-002 | A PR modifying only `specs/`, `docs/`, `.github/`, `README.md`, or other non-publishable paths passes the check without a changeset.                          | 100% pass            | Open a test PR matching this shape; verify the Changeset Bot check passes with the skip log line.    |
| SC-003 | A PR with a `pnpm changeset --empty` file plus a `packages/*/src/` change passes the check and produces no version bump on release.                           | Pass + no bump       | Stage an empty changeset; verify check passes; verify next release-please run does not bump versions.|
| SC-004 | The next multi-PR feature batch lands with one changeset per PR (or an intentional empty changeset).                                                          | Zero bulk catch-ups  | Inspect commit history of the next feature batch; no follow-up "bulk changeset" commits.             |

## Assumptions

- The existing `.github/workflows/changeset-bot.yml` runs on `pull_request` and the checkout step uses `fetch-depth: 0` so the base SHA is reachable for `git diff`. (Verify during implementation; add `fetch-depth: 0` if missing.)
- The repository continues to use `@changesets/cli` with `pnpm changeset` and `pnpm changeset --empty`. No migration to a different release tool is planned.
- Branch protection on `develop` is configured via GitHub repo settings by a maintainer with admin rights; this is a manual step outside the code change.
- All currently in-flight PRs will rebase onto `develop` after this lands; the new check will apply on their next sync.

## Out of Scope

- Enforcing changeset content quality (e.g. rejecting one-liner changesets, requiring a specific bump type). Content quality remains a human-review concern.
- Backfilling changesets for PRs #707–#717 (already addressed by [#719](https://github.com/generacy-ai/generacy/pull/719)).
- Applying the same gate to the `generacy-cloud` repository — separate repo, file separately if the same problem exists there.
- Any change to release workflows downstream of the changeset check (release-please, publish jobs, channel routing).
- Automating the branch-protection update via GitHub API or Terraform — manual UI step is acceptable for a one-off.

## Files Touched

- `.github/workflows/changeset-bot.yml` — replace the existing "Check for changesets" step with the path-scoped, exit-1-on-missing variant; ensure `actions/checkout` uses `fetch-depth: 0`.
- Repo Settings → Branches → `develop` branch protection — add `Changeset Bot / Changeset Check` as a required status check (manual; call out in the PR description).

---

*Generated by speckit*
