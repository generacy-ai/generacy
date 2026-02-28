# Tasks: CI/CD for Generacy VS Code Extension

**Input**: `spec.md`, `plan.md`
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Extension CI Workflow

### T001 Create `extension-ci.yml` workflow
**File**: `.github/workflows/extension-ci.yml`
- Create new workflow file for extension-specific PR CI
- Set trigger: `pull_request` on `[develop, main]` with paths filter `packages/generacy-extension/**`
- Set concurrency: `group: ${{ github.workflow }}-${{ github.ref }}`, `cancel-in-progress: true` (matches `ci.yml` pattern)
- Set permissions: `contents: read`
- Add job `ci` running on `ubuntu-latest`
- Add steps:
  1. `actions/checkout@v4`
  2. `pnpm/action-setup@v4`
  3. `actions/setup-node@v4` with node-version 22 and pnpm cache
  4. `pnpm install --frozen-lockfile`
  5. `pnpm --filter generacy-extension run lint`
  6. `pnpm --filter generacy-extension... run build` (with `...` for transitive workspace deps)
  7. `pnpm --filter generacy-extension run typecheck`
  8. `pnpm --filter generacy-extension run test`

---

## Phase 2: Extension Publish Workflow

### T002 Create `extension-publish.yml` — triggers, concurrency, permissions
**File**: `.github/workflows/extension-publish.yml`
- Create new workflow file
- Set trigger: `push` on `[develop, main]` with paths filter `packages/generacy-extension/**`
- Add `workflow_dispatch` trigger with `channel` input (choice: `preview`, `stable`)
- Set concurrency: `group: extension-publish`, `cancel-in-progress: false` (matches `release.yml` pattern)
- Set permissions: `contents: write` (for git tag + GitHub Release)

### T003 Add channel determination and branch validation steps
**File**: `.github/workflows/extension-publish.yml`
- Add step to derive publish channel:
  - Push to `develop` → `preview`
  - Push to `main` → `stable`
  - `workflow_dispatch` → use `inputs.channel`
- Add branch-channel validation step for `workflow_dispatch`:
  - `channel=preview` must run on `develop`
  - `channel=stable` must run on `main`
  - Fail with clear error message if mismatched
- Output channel value for downstream steps

### T004 Add build, test, and version pre-check steps
**File**: `.github/workflows/extension-publish.yml`
- Add checkout, pnpm setup, Node.js 22 setup, and dependency install steps
- Add build step: `pnpm --filter generacy-extension... run build`
- Add test step: `pnpm --filter generacy-extension run test`
- Add version extraction step: read version from `packages/generacy-extension/package.json`
- Add marketplace version pre-check step:
  - Query current published version via `npx vsce show generacy-ai.generacy --json`
  - Compare with local `package.json` version
  - Set `skip=true` output if versions match
  - Default to proceeding if `vsce show` fails (API unavailable)

### T005 Add package, publish, and artifact upload steps
**File**: `.github/workflows/extension-publish.yml`
- Add package step: `npx vsce package --no-dependencies` in `packages/generacy-extension/`
- Add publish step (conditioned on version check not skipped):
  - Preview: `npx vsce publish --no-dependencies --pre-release`
  - Stable: `npx vsce publish --no-dependencies`
  - Auth via `VSCE_PAT` env var only (no `--pat` flag)
- Add VSIX artifact upload step: `actions/upload-artifact@v4` with 30-day retention (both channels)

### T006 Add git tag and GitHub Release steps (stable only)
**File**: `.github/workflows/extension-publish.yml`
- Add git tag step (stable channel only, conditioned on version check not skipped):
  - Tag format: `extension-v{version}`
  - Skip if tag already exists (log warning, don't fail)
  - Push tag to origin
- Add GitHub Release step (stable channel only, conditioned on version check not skipped):
  - Use `softprops/action-gh-release@v2`
  - Attach `.vsix` file
  - Enable `generate_release_notes: true`
  - Set release name: `Generacy Extension v{version}`

---

## Phase 3: Update Existing Workflows

### T007 [P] Remove extension exclusion from `ci.yml`
**File**: `.github/workflows/ci.yml`
- **Typecheck step** (line 45): Remove `--filter '!generacy-extension'` from the pnpm command
  - Before: `pnpm -r --filter '!generacy-extension' run --if-present typecheck`
  - After: `pnpm -r run --if-present typecheck`
- **Test step** (line 51): Remove `--filter '!generacy-extension'` from the pnpm command
  - Before: `pnpm -r --filter '!generacy-extension' --filter '!@generacy-ai/orchestrator' --filter '!@generacy-ai/generacy' run --if-present test`
  - After: `pnpm -r --filter '!@generacy-ai/orchestrator' --filter '!@generacy-ai/generacy' run --if-present test`
- Keep other exclusions (`orchestrator`, `generacy`) intact

### T008 [P] Delete draft workflow file
**File**: `packages/generacy-extension/extension-publish.workflow.yml`
- Delete the superseded draft workflow file
- This file is replaced by `.github/workflows/extension-publish.yml`

---

## Phase 4: Validation

### T009 Verify extension scripts run locally
**Commands**:
- `pnpm --filter generacy-extension run lint`
- `pnpm --filter generacy-extension... run build`
- `pnpm --filter generacy-extension run typecheck`
- `pnpm --filter generacy-extension run test`
- Confirm all four commands pass before pushing workflow changes
- This validates that removing the CI exclusions won't break `ci.yml`

### T010 Validate workflow YAML syntax
**Files**:
- `.github/workflows/extension-ci.yml`
- `.github/workflows/extension-publish.yml`
- `.github/workflows/ci.yml`
- Run `actionlint` or manual review to validate:
  - All `${{ }}` expressions are correct
  - Step IDs referenced in conditionals exist
  - Action versions are correct (`@v4`, `@v2`)
  - Secrets reference (`secrets.VSCE_PAT`) is correct
  - Concurrency groups are properly defined

### T011 Push and verify CI triggers
- Push branch and open PR touching `packages/generacy-extension/**` files
- Verify `extension-ci.yml` triggers on the PR
- Verify `ci.yml` now includes extension in typecheck and test steps
- Verify `extension-publish.yml` does NOT trigger on the PR (push-only)

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 and Phase 2 can run in parallel (independent files)
- Phase 3 can run in parallel with Phase 1 and Phase 2 (independent files)
- Phase 4 depends on all prior phases completing

**Parallel opportunities within phases**:
- T001, T007, T008 can all run in parallel (different files, no dependencies)
- T002 → T003 → T004 → T005 → T006 must be sequential (building up the same file)
- T009, T010 can run in parallel (different validation approaches)
- T011 depends on T009 and T010

**Critical path**:
T002 → T003 → T004 → T005 → T006 → T009 → T010 → T011

**External blockers** (not part of this implementation):
- `VSCE_PAT` secret must be configured in GitHub repo settings (blocked by #244)
- Extension MVP must build/lint/typecheck cleanly (blocked by #250)
