# Implementation Plan: Make Changeset Bot a Required, Blocking Check

**Feature**: Convert the advisory `Changeset Bot` workflow into a required, blocking PR check scoped to publishable package source changes.
**Branch**: `720-problem-changeset-bot-workflow`
**Status**: Complete
**Date**: 2026-05-26
**Spec**: [spec.md](./spec.md)

## Summary

The `Changeset Bot` workflow currently emits a `::warning::` and exits 0 when a PR lacks a changeset. Because the check always passes, it cannot be made a required status check, and ~10 feature PRs (#707–#717) recently landed without changesets — freezing every `@generacy-ai/*` package on `stable` for ~6 days.

This change rewrites `.github/workflows/changeset-bot.yml` so the check:
1. **Skips** when the PR diff contains no `packages/*/src/` changes (path-scoped gate).
2. **Skips** when in-scope changes are entirely test files (`*.test.ts(x)`, `*.spec.ts(x)`, or paths under `/__tests__/`).
3. **Fails** with `::error::` and `exit 1` when in-scope non-test code changed and **no `.changeset/*.md` file was added in this PR's diff** (diff-based detection — closes the cross-PR leak that caused the original incident).
4. Runs for PRs targeting **both `develop` and `main`** (defense in depth against hotfix-to-main bypass).
5. Continues to skip drafts (status-quo).
6. Applies **uniformly to bots** (no exemption).

After merge, `Changeset Bot / Changeset Check` is added as a required status check in branch-protection rules for both `develop` and `main` (manual repo-settings step called out in the PR body).

## Technical Context

**Language/Version**: Bash (GitHub Actions `runs-on: ubuntu-latest`, default shell)
**Primary Dependencies**:
- `actions/checkout@v4` with `fetch-depth: 0` (already present — needed for `git diff base..head`)
- `git` (provided by runner)
- `grep` / shell built-ins for path matching
- `pnpm/action-setup@v4` + `actions/setup-node@v4` + `pnpm install --frozen-lockfile` — **not needed** by the new check (no `pnpm changeset status` invocation); will be removed to keep the job fast.
**Storage**: N/A (CI workflow — stateless).
**Testing**: Manual verification via PRs against this branch + a follow-up draft PR scenario. No unit-testable surface (single bash script in a workflow file).
**Target Platform**: GitHub Actions, `ubuntu-latest`.
**Project Type**: CI workflow change (single file).
**Performance Goals**: Job completes in <30s (no `pnpm install` after cleanup).
**Constraints**: Must work with `pull_request` event SHAs (`base.sha`, `head.sha`); requires `fetch-depth: 0` on checkout (already set). Must not break `develop → main` sync PRs or `changeset-release/main` bot PRs (compatibility analyzed in clarifications Q3).
**Scale/Scope**: One workflow file; ~30 LOC of bash; one manual branch-protection settings change per protected branch (`develop`, `main`).

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo. No constitutional gates to evaluate. Proceed.

## Project Structure

### Documentation (this feature)

```text
specs/720-problem-changeset-bot-workflow/
├── spec.md                 # Feature specification (read-only)
├── clarifications.md       # Resolved clarification questions (Q1–Q5)
├── plan.md                 # This file
├── research.md             # Phase 0 — technology decisions
├── data-model.md           # Phase 1 — entities (workflow inputs/outputs, diff classifications)
├── quickstart.md           # Phase 1 — author workflow + maintainer rollout
├── contracts/
│   └── changeset-check.md  # Phase 1 — script contract (inputs, exit codes, log lines)
└── checklists/             # (existing, empty)
```

### Source Code (repository root)

```text
.github/
└── workflows/
    └── changeset-bot.yml   # MODIFIED — rewrite check step; extend branches to [develop, main]
```

**Structure Decision**: Single-file CI workflow change. No source-code packages affected. No tests modified (this change ironically would not require a changeset under its own gate, because it doesn't touch `packages/*/src/`).

## Complexity Tracking

No constitutional violations; table omitted.

## Phases

### Phase 0 — Research

Decisions captured in [research.md](./research.md):
- **Why bash + `git diff` over `pnpm changeset status`** — zero install cost, no node setup needed, exact diff-based semantics (Q1=A).
- **Why `--diff-filter=A` (added-only)** — matches the structural fix in Q1; "modified" is excluded by design (Q1 option C rejected).
- **Path-matching strategy** — `grep -E` against `git diff --name-only` output; portable, no jq/yq dependency.
- **Branch-protection rollout sequencing** — workflow PR merged first, then settings change; otherwise the required check is "expected but never run" and blocks all PRs.

### Phase 1 — Design

- [data-model.md](./data-model.md) — workflow inputs, classification states, exit-code table.
- [contracts/changeset-check.md](./contracts/changeset-check.md) — the bash script's input/output contract (env vars consumed, log lines emitted, exit codes by classification).
- [quickstart.md](./quickstart.md) — author workflow ("I added code, what do I do?"), bypass options (`pnpm changeset --empty`), maintainer rollout steps (branch protection settings).

### Phase 2 — Tasks (generated by `/speckit:tasks`)

Will produce `tasks.md` covering:
1. Rewrite `changeset-bot.yml` check step per [contracts/changeset-check.md](./contracts/changeset-check.md).
2. Extend `on.pull_request.branches` to `[develop, main]`.
3. Remove unused `pnpm/setup-node` install steps (no longer needed).
4. Write PR description with the required manual branch-protection step.
5. Manual rollout step (maintainer): add `Changeset Bot / Changeset Check` to branch-protection rules for `develop` and `main`.

### Phase 3 — Implementation (`/speckit:implement`)

Single-file workflow edit + PR.
