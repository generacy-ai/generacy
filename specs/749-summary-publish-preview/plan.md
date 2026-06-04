# Implementation Plan: publish-preview race + SHA traceability

**Feature**: publish-preview can publish a stale preview when run during a merge
**Branch**: `749-summary-publish-preview`
**Status**: Complete
**Date**: 2026-06-04
**Spec**: [spec.md](./spec.md)

## Summary

Harden `.github/workflows/publish-preview.yml` against three failure modes
exposed by #744/#746:

1. **Race**: a `workflow_dispatch` run started while a PR is merging snapshots
   the pre-merge commit even though the publish lands after the merge.
2. **Opaque provenance**: there is no way to tell which commit a published
   `@preview` tarball was built from without unpacking it.
3. **Silent backward publish**: a stale build (or a deliberate rollback) can
   replace a newer `@preview` with no signal.

The fix is a workflow-level change plus a small Node helper. We:

- **Resolve `origin/develop` HEAD at build time** and check it out for the
  build (kills the race for the common path — FR-002).
- **Stamp every published `package.json`** with `gitHead` + `generacy.sourceSha`
  (full 40-char SHA) and **append `-<sha7>`** to the snapshot version string
  produced by `changeset version --snapshot preview` (FR-003).
- **Compare the candidate SHA's ancestry** against the currently-published
  `@preview` tarball's `gitHead` for one anchor package (`@generacy-ai/generacy`,
  which is always published and never private). Refuse to publish if the
  candidate is a strict ancestor of the current preview SHA. Fail fast — no
  retries or self-redispatch (FR-004, FR-006).
- **Fail open** when there is no current `@preview` (first run, registry wipe,
  new package) — the publish establishes the baseline (FR-005).
- **Add `force_rollback: boolean` input** to `workflow_dispatch` (default
  `false`) that skips the staleness check and logs an auditable warning. The
  `push: develop` trigger ignores this input (FR-007).

Existing `push: develop` trigger (added in #538) already satisfies FR-001.

## Technical Context

**Language/Version**: GitHub Actions YAML + Node.js 24 (runner default per
`bf126ec`)
**Primary Dependencies**:
- `pnpm`, `@changesets/cli` (already in repo)
- `actions/checkout@v6`, `actions/setup-node@v4`, `pnpm/action-setup@v4`
- `gh` CLI (preinstalled on `ubuntu-latest`), `git`, `npm`
- Zero new runtime deps. New helper scripts are plain Node ESM (matches
  `scripts/verify-pack-no-workspace-deps.js`).

**Storage**: N/A. State lives in the npm registry (`gitHead` on the published
preview tarball is the only persisted "previous SHA" pointer).

**Testing**: Manual verification against staging. There is no test harness for
GitHub Actions workflows in this repo; the staleness-check helper is pure
enough to unit-test if we want, but in line with `verify-pack-no-workspace-deps.js`
we'll add it as a script and rely on the integration check (SC-004) for proof.

**Target Platform**: GitHub-hosted Linux runner (`ubuntu-latest`).

**Project Type**: Single project (monorepo CI workflow).

**Performance Goals**: SC-001 — merge-to-`@preview` ≤ 10 minutes. Current
workflow is already ~5–8 min; the only added work is one `npm view ... gitHead`
call and one `git merge-base --is-ancestor` — both sub-second.

**Constraints**:
- Must not break the existing `push: develop` auto-publish (FR-001 is
  already satisfied by `976c454`; this PR keeps it intact).
- Must not require new secrets or new GitHub App permissions.
- Version format change (`-<sha7>` suffix) is a public-facing string change;
  must not break the pinned-consumer path (`@generacy-ai/*@preview` resolves
  by dist-tag, not by version string).
- `changeset version --snapshot preview` rewrites every `package.json` —
  the SHA stamp step must run **after** the snapshot version step.

**Scale/Scope**: 16 published packages in `packages/` (`generacy-extension` is
ignored per `.changeset/config.json`). One workflow file + two new helper
scripts.

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo. Skipping
constitution gate. The change is a single-workflow modification (~80
added lines in YAML, ~80 lines in two Node helpers); no architectural
concerns to track.

## Project Structure

### Documentation (this feature)

```text
specs/749-summary-publish-preview/
├── plan.md              # This file
├── research.md          # Tech decisions + alternatives
├── data-model.md        # Version-string + gitHead shape
├── quickstart.md        # Operator usage (force_rollback, verify)
├── contracts/
│   └── workflow-inputs.md  # workflow_dispatch input schema
├── spec.md              # (read-only)
├── clarifications.md    # (read-only)
└── tasks.md             # (created by /speckit:tasks)
```

### Source Code (repository root)

```text
.github/workflows/
└── publish-preview.yml          # MODIFIED: add force_rollback input,
                                 # resolve origin/develop HEAD, stamp SHA,
                                 # run staleness check, version suffix

scripts/
├── verify-pack-no-workspace-deps.js   # existing — unchanged
├── stamp-source-sha.mjs               # NEW: writes gitHead +
│                                       # generacy.sourceSha into every
│                                       # non-private package.json and
│                                       # appends -<sha7> to .version
└── check-preview-staleness.mjs        # NEW: reads current @preview gitHead
                                       # via `npm view`, runs
                                       # `git merge-base --is-ancestor`,
                                       # exits non-zero on stale
```

**Structure Decision**: Two new top-level scripts under `scripts/` rather than
inlining 50+ lines of JS into the workflow YAML. Mirrors the existing
`verify-pack-no-workspace-deps.js` pattern (Node ESM, `node:` builtins only,
no deps). The workflow stays scannable; the scripts are independently
testable from a clean checkout via `node scripts/<name>.mjs`.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Two helper scripts instead of one | Stamping and staleness-checking run at different points in the workflow (stamp **after** `changeset version`; check **before** stamp, against `origin/develop` HEAD) and have different exit semantics (stamp: side-effect; check: gate). Combining them would force a `--mode=stamp\|check` flag and an awkward shared CLI surface. | Inlining into the YAML — rejected (50+ lines of inline JS hurt readability; matches existing `scripts/` convention). One combined script — rejected (cleaner separation of concerns; trivial duplication is just `import { execSync } from 'node:child_process'`). |
| Using `npm view <pkg>@preview gitHead` as the source-of-truth for "current preview SHA" | The npm registry is the only persistent record of what's actually deployed. Local git refs/tags can drift. | A git tag like `preview-published` — rejected (would require workflow write to push tags and a separate rollback story when tags get out of sync with the registry). Reading `package.json` from a downloaded tarball — rejected (slower, and `npm view` exposes the field directly). |
