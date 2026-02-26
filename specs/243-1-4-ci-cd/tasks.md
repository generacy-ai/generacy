# Tasks: 1.4 — CI/CD for generacy repo

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md)
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Convert Dev Container Feature Workflow to Reusable

### T001 [US5] Add `workflow_call` trigger and preview mode to `publish-devcontainer-feature.yml`
**File**: `.github/workflows/publish-devcontainer-feature.yml`
- Add `workflow_call` trigger with `mode` input (type: `string`, required: `true`)
- Keep existing `push.tags: ['feature/v*']` trigger as fallback (treated as stable)
- Add conditional for stable mode: run `devcontainers/action@v1` when `inputs.mode == 'stable'` or `inputs.mode == ''` (tag trigger fallback)
- Add conditional for preview mode: install `oras` CLI v1.2.0 when `inputs.mode == 'preview'`
- Add preview publish step: login to GHCR via `oras login`, tar the feature directory (`packages/devcontainer-feature/src/generacy`), push to `ghcr.io/generacy-ai/generacy/generacy:preview` with correct OCI media types (`application/vnd.devcontainers` config, `application/vnd.devcontainers.layer.v1+tar` layer)
- Preserve existing permissions: `contents: read`, `packages: write`

**Current state** (23 lines):
```yaml
on:
  push:
    tags:
      - 'feature/v*'
jobs:
  publish:
    # ... devcontainers/action@v1 only
```

**Target state**: Dual-mode workflow supporting both `preview` (oras) and `stable` (devcontainers/action)

**Spec coverage**: FR-010, FR-014, FR-019, US5

---

## Phase 2: Fix and Extend Preview Publishing

### T002 [US3] Fix changeset detection bug in `publish-preview.yml`
**File**: `.github/workflows/publish-preview.yml`
- Replace `ls .changeset/*.md` (line 41) with `find .changeset -name '*.md' ! -name 'README.md'`
- Current code matches `README.md` which always exists, causing false positives (changesets always detected even when none exist)
- Match the pattern already used in `changeset-bot.yml` (line 24)

**Bug details**: `ls .changeset/*.md` will match `.changeset/README.md` (always present), so `has_changesets` is always `true`, potentially triggering empty publishes.

**Spec coverage**: FR-008

### T003 [US3] Add `--provenance` flag to preview npm publish
**File**: `.github/workflows/publish-preview.yml`
- Add `--provenance` to the publish command (line 53): `pnpm -r --filter '!generacy-extension' publish --tag preview --no-git-checks --provenance`
- The `id-token: write` permission is already set (line 13), so this is a one-line change

**Spec coverage**: FR-009 (enhanced)

### T004 [US3] Add `packages: write` permission to `publish-preview.yml`
**File**: `.github/workflows/publish-preview.yml`
- Add `packages: write` to the top-level `permissions` block (after line 13)
- Required for the reusable workflow to push to GHCR

**Spec coverage**: FR-015, FR-019

### T005 [US3] [US5] Restructure `publish-preview.yml` to call reusable Dev Container Feature workflow
**File**: `.github/workflows/publish-preview.yml`
- Rename existing job from `publish-preview` to `publish-npm`
- Add `outputs` to the `publish-npm` job: `has_changesets: ${{ steps.changesets.outputs.has_changesets }}`
- Add new job `publish-devcontainer-feature` that:
  - Depends on `publish-npm` via `needs: publish-npm`
  - Conditionally runs when `needs.publish-npm.outputs.has_changesets == 'true'`
  - Calls `./.github/workflows/publish-devcontainer-feature.yml` with `mode: preview`
  - Uses `secrets: inherit` to pass `GITHUB_TOKEN`

**Depends on**: T001 (reusable workflow must exist), T002 (changeset detection must be fixed first)

**Spec coverage**: FR-010, US5

---

## Phase 3: Fix and Extend Release Publishing

### T006 [US4] Add `registry-url` to `setup-node` step in `release.yml`
**File**: `.github/workflows/release.yml`
- Add `registry-url: 'https://registry.npmjs.org'` to the `actions/setup-node@v4` step (after line 27)
- **Bug fix**: Without `registry-url`, `actions/setup-node` does not configure the `.npmrc` file, so `NODE_AUTH_TOKEN` has no effect and `npm publish` cannot authenticate

**Spec coverage**: FR-013

### T007 [P] [US4] Fix npm auth env var in `release.yml`
**File**: `.github/workflows/release.yml`
- Change `NPM_TOKEN` to `NODE_AUTH_TOKEN` in the `changesets/action` env block (line 48)
- **Bug fix**: `actions/setup-node` with `registry-url` creates an `.npmrc` that references `NODE_AUTH_TOKEN`, not `NPM_TOKEN`. The current env var name means the token is set but never read by npm.

**Spec coverage**: FR-013

### T008 [P] [US4] Add `--provenance` flag to release npm publish
**File**: `.github/workflows/release.yml`
- Add `--provenance` to the publish command in the changesets action (line 43): `pnpm -r --filter '!generacy-extension' publish --no-git-checks --provenance`
- The `id-token: write` permission is already set (line 14)

**Spec coverage**: FR-013 (enhanced)

### T009 [US4] Add `packages: write` permission to `release.yml`
**File**: `.github/workflows/release.yml`
- Add `packages: write` to the top-level `permissions` block (after line 14)
- Required for the reusable workflow to push to GHCR

**Spec coverage**: FR-015, FR-019

### T010 [US4] [US5] Add Dev Container Feature publish job to `release.yml`
**File**: `.github/workflows/release.yml`
- Add `outputs` to the `release` job: `published: ${{ steps.changesets.outputs.published }}`
- Add new job `publish-devcontainer-feature` that:
  - Depends on `release` via `needs: release`
  - Conditionally runs when `needs.release.outputs.published == 'true'` (only when changesets/action actually published packages)
  - Calls `./.github/workflows/publish-devcontainer-feature.yml` with `mode: stable`
  - Uses `secrets: inherit`

**Depends on**: T001 (reusable workflow must exist), T006 + T007 (auth fixes should be in place)

**Spec coverage**: FR-014, US5

---

## Phase 4: Defense-in-Depth

### T011 [P] [US3] [US4] Create `packages/devcontainer-feature/package.json` with `"private": true`
**File**: `packages/devcontainer-feature/package.json` (new)
- Create minimal `package.json` with `"private": true` to prevent accidental npm publishing
- Content:
  ```json
  {
    "name": "devcontainer-feature",
    "private": true,
    "description": "Generacy Dev Container Feature (published to GHCR, not npm)"
  }
  ```
- This directory currently has no `package.json`, so if pnpm ever picks it up as a workspace, it could be accidentally published

**Spec coverage**: FR-016 (defense-in-depth)

---

## Phase 5: Verification

### T012 [US1] Verify `ci.yml` matches specification
**File**: `.github/workflows/ci.yml`
- Confirm no changes needed (already verified in plan)
- Checklist:
  - [x] Triggers on `pull_request` and `push` to `develop`/`main` (FR-001)
  - [x] Concurrency with `cancel-in-progress: true` (FR-004)
  - [x] `pnpm install --frozen-lockfile` (FR-002)
  - [x] Node 22 with pnpm cache (FR-003)
  - [x] Lint root + packages (FR-001)
  - [x] Build root + packages (FR-001)
  - [x] Typecheck excluding `generacy-extension` (FR-005)
  - [x] Test excluding `generacy-extension`, `orchestrator`, `generacy` CLI (FR-005)
  - [x] Sequential steps — fails fast (FR-001)
  - [x] `contents: read` permission (FR-015)

**Spec coverage**: FR-001 through FR-005, US1

### T013 [P] [US2] Verify `changeset-bot.yml` matches specification
**File**: `.github/workflows/changeset-bot.yml`
- Confirm no changes needed (already verified in plan)
- Checklist:
  - [x] Triggers on `pull_request` (opened/synchronize) to `develop` (FR-006)
  - [x] Uses `find` with `! -name 'README.md'` exclusion (correct detection)
  - [x] Emits `::warning::` annotation (non-blocking) (FR-006)
  - [x] Shows confirmation message when changeset found (US2)

**Spec coverage**: FR-006, US2

### T014 [US1] [US2] Verify `.changeset/config.json` matches specification
**File**: `.changeset/config.json`
- Confirm settings:
  - [x] `baseBranch` is `develop` (FR-017)
  - [x] `access` is `public` (FR-017)
  - [x] `ignore` includes `generacy-extension` (FR-017)

**Spec coverage**: FR-017

### T015 Validate all workflow YAML syntax
**Files**:
- `.github/workflows/publish-devcontainer-feature.yml`
- `.github/workflows/publish-preview.yml`
- `.github/workflows/release.yml`
- Validate YAML syntax for all modified workflows (dry run parse)
- Verify no trailing whitespace, correct indentation, proper quoting

**Depends on**: T001 through T010

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phases 2 and 3 (reusable workflow is a dependency for both)
- Phases 2 and 3 can run in parallel after Phase 1
- Phase 4 can run in parallel with any phase (independent file)
- Phase 5 runs after all implementation phases

**Parallel opportunities within phases**:
- **Phase 2**: T002, T003, T004 can be done in parallel (different parts of same file, but changes are independent sections). T005 depends on T002 (needs fixed changeset detection for output)
- **Phase 3**: T006 and T007 are parallel (different lines). T008 is parallel with T006/T007. T009 is parallel. T010 depends on T006 + T007
- **Phase 4**: T011 is fully independent — can run any time
- **Phase 5**: T012, T013, T014 are parallel (different files, read-only). T015 depends on all implementation tasks

**Critical path**:
```
T001 → T002 → T005 → T015
            ↗
T001 → T006/T007 → T010 → T015
```

**Task summary**:
- Total tasks: 15
- Implementation tasks: 11 (T001–T011)
- Verification tasks: 4 (T012–T015)
- Files modified: 3 (`publish-devcontainer-feature.yml`, `publish-preview.yml`, `release.yml`)
- Files created: 1 (`packages/devcontainer-feature/package.json`)
- Files unchanged: 2 (`ci.yml`, `changeset-bot.yml`)
