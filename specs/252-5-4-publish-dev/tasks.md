# Tasks: 5.4 — Publish Dev Container Feature to GHCR

**Input**: Design documents from `specs/252-5-4-publish-dev/`
**Prerequisites**: plan.md (required), spec.md (required), clarifications.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Test Scenario Addition & Preview Default Baking

### T001 [P] Add TypeScript-Node test scenario entry to scenarios.json
**File**: `packages/devcontainer-feature/test/generacy/scenarios.json`
- Add `defaults_typescript_node` entry using `mcr.microsoft.com/devcontainers/typescript-node:22` base image
- Feature should use all defaults (empty options object `{}`)
- This exercises the Node.js "already installed" skip path in `install.sh`

### T002 [P] Create TypeScript-Node test script
**File**: `packages/devcontainer-feature/test/generacy/defaults_typescript_node.sh` (CREATE)
- Create new test script following existing pattern from `defaults_python.sh` / `defaults_ubuntu.sh`
- Validate all tools installed: `node`, `gh`, `claude`, `generacy`, `agency`
- Include descriptive comment noting this image has Node.js pre-installed (tests the skip branch)
- Must be executable (`#!/bin/sh`, `set -e`)

### T003 [P] Add preview defaults baking step to publish workflow
**File**: `.github/workflows/publish-devcontainer-feature.yml`
- Add a "Set preview defaults" step that runs only when `inputs.mode == 'preview'`
- Insert step **before** the "Publish Feature (preview)" step
- Use `jq` to rewrite `devcontainer-feature.json` option defaults:
  - `.options.version.default` → `"preview"`
  - `.options.agencyVersion.default` → `"preview"`
- This ensures `:preview` tagged OCI artifacts deliver preview npm packages automatically

---

## Phase 2: Multi-Repo Template GHCR Path Fix

### T004 [P] Fix GHCR path in multi-repo template
**File**: `packages/templates/src/multi-repo/devcontainer.json.hbs` (line 25)
- Change `ghcr.io/generacy-ai/features/generacy` → `ghcr.io/generacy-ai/generacy/generacy`
- Single-repo template already has the correct path; this aligns multi-repo to match

### T005 [P] Fix GHCR path in integration test assertion
**File**: `packages/templates/tests/integration/render-project.test.ts` (line 254)
- Change assertion from `ghcr.io/generacy-ai/features/generacy:1` → `ghcr.io/generacy-ai/generacy/generacy:1`
- Verify the single-repo assertion on line 91 is already correct (no change needed)

### T006 [P] Fix GHCR path in validator test fixtures
**File**: `packages/templates/tests/unit/validators.test.ts`
- Replace all 13 occurrences of `ghcr.io/generacy-ai/features/generacy` → `ghcr.io/generacy-ai/generacy/generacy`
- Validator regex (`/generacy-ai\/.*\/generacy/`) matches both patterns — **no source code changes needed**, only test fixtures
- Affected lines: ~577, 596, 650, 692–694, 717, 1120, 1150

### T007 Regenerate integration test snapshots
**File**: `packages/templates/tests/integration/__snapshots__/snapshots.test.ts.snap`
- Run `pnpm -r --filter @generacy-ai/templates test -- --update` to regenerate snapshots
- ~3 occurrences in snapshot file will auto-update from `features/generacy` → `generacy/generacy`
- **Do NOT manually edit** — let the test runner regenerate
- **Depends on**: T004, T005, T006 (template and test fixes must be in place first)

---

## Phase 3: Documentation & Validation

### T008 [P] Update README test scenario table
**File**: `packages/devcontainer-feature/README.md`
- Add row to the test scenario table for `defaults_typescript_node`:
  ```
  | `defaults_typescript_node` | TypeScript-Node 22 | All defaults | All tools installed, Node skip path |
  ```
- Insert in alphabetical order or after the existing `defaults_ubuntu` entry

### T009 Run full local validation suite
**Files**: (no file changes — validation only)
- Run linting: `pnpm lint && pnpm -r run --if-present lint`
- Run build: `pnpm build && pnpm -r run --if-present build`
- Run template tests: `pnpm -r --filter @generacy-ai/templates test`
- Run full test suite: `pnpm test && pnpm -r --filter '!generacy-extension' --filter '!@generacy-ai/orchestrator' --filter '!@generacy-ai/generacy' run --if-present test`
- Verify `scenarios.json` parses correctly: `cat packages/devcontainer-feature/test/generacy/scenarios.json | jq .`
- **Depends on**: All previous tasks (T001–T008)

---

## Phase 4: Post-Merge Manual Steps (Operational)

### T010 Verify preview publish workflow executes
**Files**: (no file changes — operational verification)
- After merge to `develop`, confirm `publish-preview.yml` workflow triggers
- Check GitHub Actions logs for successful `oras push` to GHCR
- Validate preview artifact exists: `oras manifest fetch ghcr.io/generacy-ai/generacy/generacy:preview`
- **Depends on**: Merge to `develop` branch

### T011 Set GHCR package visibility to public
**Files**: (no file changes — one-time manual configuration)
- Navigate to `https://github.com/orgs/generacy-ai/packages/container/generacy%2Fgeneracy/settings`
- Under "Danger Zone", change visibility from "Private" to "Public"
- Cannot be automated without `packages: admin` permissions (per Q6 clarification)
- **Depends on**: T010 (package must exist before changing visibility)

### T012 Verify public pull of preview artifact
**Files**: (no file changes — verification only)
- Test: `docker pull ghcr.io/generacy-ai/generacy/generacy:preview`
- Or test via devcontainer.json referencing `ghcr.io/generacy-ai/generacy/generacy:preview`
- Confirm all tools install successfully in a fresh container
- **Depends on**: T011 (package must be public)

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 and Phase 2 can run **in parallel** (no file overlap)
- Phase 3 (T008) can run in parallel with Phases 1 & 2; T009 depends on all of Phases 1 & 2
- Phase 4 is post-merge and sequential (T010 → T011 → T012)

**Parallel opportunities within phases**:
- **Phase 1**: T001, T002, T003 are all independent files — run in parallel
- **Phase 2**: T004, T005, T006 are independent files — run in parallel; T007 depends on T004+T005+T006
- **Phase 3**: T008 is independent; T009 depends on everything

**Critical path**:
```
T001 ─┐
T002 ─┤
T003 ─┤
T004 ─┤
T005 ─┼─► T007 ─► T009 ─► [merge] ─► T010 ─► T011 ─► T012
T006 ─┤
T008 ─┘
```

**Shortest critical path**: T004/T005/T006 → T007 → T009 → merge → T010 → T011 → T012

**External blockers** (not in this PR's scope):
- `@generacy-ai/generacy` published to npm (issue 1.1)
- `@generacy-ai/agency` published to npm (issue 1.3/1.4)
- CI/CD for generacy repo (issue 243)

> Note: Code changes can merge independently. Workflows will only succeed at runtime after dependent npm packages are published.
