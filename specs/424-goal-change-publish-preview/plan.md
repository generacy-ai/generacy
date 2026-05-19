# Implementation Plan: Gate publish-preview.yml on Manual Dispatch

**Feature**: Change `publish-preview.yml` from auto-publish-on-push to manual `workflow_dispatch` only
**Branch**: `424-goal-change-publish-preview`
**Status**: Complete

## Summary

Replace the `on: push: branches: [develop]` trigger in `.github/workflows/publish-preview.yml` with `on: workflow_dispatch` so that preview npm publishes only happen when explicitly triggered. This prevents partial spawn-refactor work from being accidentally published to the `preview` npm channel. Add inline documentation explaining the manual dispatch process.

## Technical Context

**Language/Version**: GitHub Actions YAML
**Primary Dependencies**: None (workflow file only)
**Storage**: N/A
**Testing**: Manual verification via `gh workflow run` and Actions tab inspection
**Target Platform**: GitHub Actions
**Project Type**: CI/CD configuration change
**Constraints**: Must not modify `release.yml` or any other workflow; `publish-devcontainer-feature` job (via `needs: publish-npm`) must continue to work under the new trigger

## Constitution Check

No `.specify/memory/constitution.md` found — no gates apply.

## Project Structure

### Documentation (this feature)

```text
specs/424-goal-change-publish-preview/
├── spec.md              # Feature specification (read-only)
├── plan.md              # This file
├── research.md          # Technology decisions
└── quickstart.md        # Manual dispatch instructions
```

### Source Code (files to modify)

```text
.github/workflows/
└── publish-preview.yml   # Change trigger from push to workflow_dispatch + add docs comment
```

## Change Analysis

### File 1: `.github/workflows/publish-preview.yml`

**Lines 2–5 — Trigger block replacement**

| Current | Target |
|---------|--------|
| `on:` | `on:` |
| `  push:` | `  workflow_dispatch:` |
| `    branches: [develop]` | *(removed)* |

The `workflow_dispatch` trigger:
- Supports manual runs via the Actions UI "Run workflow" button
- Supports CLI invocation: `gh workflow run publish-preview.yml --ref develop`
- Does not change the `concurrency` group behavior (still uses `github.workflow`)
- Does not affect `needs` gating — `publish-devcontainer-feature` still waits for `publish-npm`

**Add documentation comment** (above the trigger or at top of file) explaining:
- Why the trigger was changed (spawn-refactor safety)
- How to manually trigger a preview release

### Files NOT modified

- `.github/workflows/release.yml` — stable publishing, out of scope (FR-004)
- `.github/workflows/publish-devcontainer-feature.yml` — called via `uses:`, no change needed
- All other workflow files — unrelated

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `workflow_dispatch` doesn't support existing job steps | Very Low | High | GitHub docs confirm workflow_dispatch is trigger-agnostic — all steps (checkout, pnpm, changeset, publish) work identically |
| `concurrency` group breaks under new trigger | Very Low | Low | Group uses `github.workflow` which is trigger-independent |
| Team forgets how to publish preview | Medium | Low | Documentation added inline + PR description |
| Other workflows depend on push trigger | Very Low | Medium | No cross-workflow dependencies found on `publish-preview.yml`'s push trigger |

## Verification Plan

1. After merge: push a commit to `develop` — confirm `Publish Preview` workflow does NOT run
2. Run `gh workflow run publish-preview.yml --ref develop` — confirm both `publish-npm` and `publish-devcontainer-feature` jobs complete successfully
3. Verify `release.yml` is byte-identical to pre-change (no modifications)
4. Review inline comment/docs for clarity
