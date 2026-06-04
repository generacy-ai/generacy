# Implementation Plan: Release pending changesets to `@generacy-ai/*@stable`

**Feature**: Drain 16 pending changesets to the `stable` npm tag, ship the cloud-cluster line to prod
**Branch**: `748-summary-generacy-ai-stable`
**Status**: Complete
**Date**: 2026-06-04
**Spec**: [spec.md](./spec.md)

## Summary

`@generacy-ai/*@stable` is stuck at 0.3.0 and misses the entire cloud-cluster
line of fixes (notably #744's per-cluster `deriveTunnelName`, the workspace
clone-race fix, the claude.json volume bind, GH-username identity, and the
`feat-750` identity-split detector). Sixteen `.changeset/*.md` files are
pending; staging (`preview`) is current, prod (`stable`) is not.

This issue is a **release-engineering execution**, not a code change. The
deliverable is to drive the existing `.github/workflows/release.yml` end-to-end
to consume all 16 changesets and ship them under the `stable` dist-tag. The
workflow is already correct (it splits version mode and publish mode,
explicitly uses `pnpm -r publish` to avoid #669's `workspace:` leak, and gates
on `scripts/verify-pack-no-workspace-deps.js`). What's missing is the
operational sequence and the live-cluster verification step.

The sequence (per Clarifications Q2=A, Q3=B):

1. **Freeze + pin**: Pick a `develop` SHA, merge it to `main`. Hold further
   `develop`/`main` merges until the Version PR lands. That SHA *is* the
   release scope.
2. **Version mode**: `release.yml` runs on `push: main`, detects pending
   changesets, runs `pnpm changeset version` via `changesets/action@v1`, and
   opens a "chore: version packages" Version PR (bumps versions, drains all
   16 changesets).
3. **Review + merge**: Manual review gate on the Version PR confirms version
   bumps look sane (and that no changeset got lost). Merge it.
4. **Publish mode**: `release.yml` runs again on the Version-PR merge,
   detects no pending changesets, runs `verify-pack-no-workspace-deps.js`,
   then `pnpm -r --filter '!generacy-extension' publish --tag stable
   --no-git-checks --provenance`, then advances `@latest` per package.
5. **Tarball check** (SC-002): `npm view @generacy-ai/control-plane@stable
   dist.tarball` → download/unpack → grep `deriveTunnelName`. Necessary but
   not sufficient.
6. **Live verify** (SC-003, Q4=A): `generacy launch`/`deploy` a throwaway
   `stable`-channel cluster, inspect its relay metadata, confirm
   `vscodeTunnelName` matches `^g-[0-9a-f]{18}$` (UUID-derived, per #744's
   `deriveTunnelName`), then `generacy destroy`.
7. **Rollback plan** (Q5=B): If a regression surfaces post-publish,
   `npm dist-tag add @generacy-ai/<pkg>@<previous-good> stable` per affected
   package to re-point `stable` back to last-good (instant, non-destructive).
   Then roll forward with a hotfix changeset. Do NOT `npm unpublish`.

## Technical Context

**Language/Version**: No code changes. The workflow itself is GitHub Actions
YAML running Node.js 22 (`actions/setup-node@v4` with `node-version: '22'`)
and pnpm via `pnpm/action-setup@v4`.

**Primary Dependencies** (all already wired in `release.yml`):
- `pnpm`, `@changesets/cli` (root devDep)
- `changesets/action@v1` (version mode only — opens the Version PR)
- `actions/checkout@v6`, `actions/setup-node@v4`, `pnpm/action-setup@v4`
- `npm` CLI (preinstalled), `gh` CLI (for manual ops)
- `scripts/verify-pack-no-workspace-deps.js` (existing publish gate)

**Storage**: N/A. State lives in the npm registry (the `stable` dist-tag and
the package tarballs themselves) and in the GitHub repo (`.changeset/*.md`
files consumed by `changeset version`, `CHANGELOG.md` per package written by
the Version PR).

**Testing**:
- Static (SC-002): `npm view @generacy-ai/control-plane@stable dist.tarball`
  + `npm pack` inspection.
- Dynamic (SC-003): throwaway `stable` cluster via `generacy launch` /
  `generacy deploy`, relay-metadata inspection via `generacy status` /
  `/health`.

**Target Platform**:
- Release workflow: GitHub-hosted Linux runner (`ubuntu-latest`).
- Verification cluster: whichever channel `stable` resolves to —
  `generacy-ai/cluster-base:stable` image, single-cluster deploy.

**Project Type**: Single project (monorepo release).

**Performance Goals**: None — this is a one-shot release execution. The
workflow's typical runtime is ~5–10 minutes per phase (version mode + publish
mode). Live verification adds ~5–10 minutes for the throwaway cluster boot +
teardown.

**Constraints**:
- MUST use `release.yml`, NOT a hand-run of `pnpm changeset publish`
  (#669: `changeset publish` shells to `npm publish` which doesn't rewrite
  `workspace:` deps; `pnpm -r publish` does, and the workflow already uses
  the right command).
- MUST hold further `develop`/`main` merges between the `develop → main`
  merge and the Version-PR merge (Q3=B). Otherwise the Version PR drifts
  from the pinned SHA.
- MUST verify against a real `stable`-channel deploy, not tarball inspection
  alone (Q4=A; this whole issue exists because #746's tarball check missed a
  real deploy mismatch).
- MUST NOT `npm unpublish` on regression (Q5=B; 72h window, disallowed with
  downstream installs).
- The two `bulk-…-release` changesets and the two `release-followup-…`
  changesets are bundled with the cloud-cluster work in this single cut
  (Q1=A; one clean drain).

**Scale/Scope**: 16 pending changesets across the workspace; ~15 publishable
packages under `packages/` (`generacy-extension` is filtered out at publish
time; private packages are skipped by `pnpm publish`). One `develop → main`
merge, one Version PR review/merge, one publish run, one throwaway cluster
deploy/destroy.

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo. Skipping
constitution gate. The change is operational (no source code modified); no
architectural concerns to track.

## Project Structure

### Documentation (this feature)

```text
specs/748-summary-generacy-ai-stable/
├── plan.md                 # This file
├── research.md             # Tech decisions + alternatives (release path)
├── data-model.md           # State of the world before/after publish
├── quickstart.md           # Operator runbook for the release
├── contracts/
│   └── release-workflow.md # Trigger contract for .github/workflows/release.yml
├── spec.md                 # (read-only)
├── clarifications.md       # (read-only)
└── tasks.md                # (created by /speckit:tasks)
```

### Source Code (repository root)

This feature ships **no source modifications**. The release workflow, scripts,
and changesets it consumes already exist on `develop`. The plan touches only:

```text
.changeset/                          # 16 *.md files CONSUMED by `changeset version`
├── 739-pre-approved-device-code.md
├── bulk-stable-release.md
├── bulk-worker-scale-release.md
├── feat-744-multi-cluster-cli.md
├── feat-750-identity-split-detector.md
├── fix-737-claude-json-volume-bind.md
├── fix-739-post-activation-clone-race.md
├── fix-cluster-identity-gh-username.md
├── fix-orchestrator-republish-clean-deps.md
├── fix-vscode-tunnel-actual-name.md
├── fix-workspace-deps-leak.md
├── initial-stable-release.md
├── prepare-workspace-lifecycle.md
├── propagate-primary-branch.md
├── release-followup-727-730.md
└── release-followup-workflow-engine.md

.github/workflows/release.yml        # EXECUTED (unmodified) — version mode + publish mode

packages/*/package.json              # MUTATED BY the Version PR (changeset version)
packages/*/CHANGELOG.md              # MUTATED BY the Version PR (changeset version)

scripts/verify-pack-no-workspace-deps.js  # EXISTING gate; runs at publish step
```

**Structure Decision**: No new files, no source edits. All artifacts under
`specs/748-…/` are operator documentation for the release sequence and
verification. The Version PR (auto-opened by `changesets/action@v1` against
`main`) is the one repo-mutating artifact; it is generated by tooling, not
hand-authored.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Live cluster verification step (FR-006) in addition to tarball inspection (FR-005) | This issue exists *because* tarball/static inspection (#746) missed a real deploy-time mismatch — the `stable`-channel cluster regressed to projectId-derived tunnel names despite the static check on the publish artifact. Q4=A is explicit that SC-002 is necessary but not sufficient. | Tarball inspection only — rejected: would repeat the failure mode that motivated this issue. Re-deploying an existing prod cluster — rejected: production risk for a verification step. Flipping staging to `stable` for one boot — rejected: pollutes the staging environment for a one-shot check. |
| Operational freeze of `develop`/`main` between the cut and the Version-PR merge (FR-001 / Q3=B) | The pinned `develop` SHA *is* the release scope; further merges before the Version PR lands would either get pulled into the same release (defeating the pin) or stall the Version PR (rebase churn). | Cutting a release branch (Q3=C) — rejected: dedicated branch is unnecessary overhead for a single-merge main-triggered workflow. No freeze (Q3=A) — rejected: scope drift between when scope is "decided" and when it's published. |
