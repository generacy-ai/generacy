# Tasks: 5.5 — Docker Compose Template for Multi-Repo Projects

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Schema Changes

All schema changes are in a single file (`src/schema.ts`) and must be done sequentially to avoid conflicts.

### T001 [DONE] Tighten `OrchestratorContextSchema` validation
**File**: `packages/templates/src/schema.ts`
- Change `pollIntervalMs` from `.positive()` to `.min(5000)` (Q3 — minimum 5s poll interval)
- Change `workerCount` from `.nonnegative().default(3)` to `.nonnegative().max(20).default(2)` (Q2 — cap at 20, default 2)
- Update `.describe()` strings to reflect new constraints

### T002 [DONE] Tighten `MultiRepoInputSchema` validation
**File**: `packages/templates/src/schema.ts`
- Change `workerCount` from `.positive()` to `.min(1).max(20)` (Q2 — multi-repo requires at least 1 worker, max 20)
- Change `pollIntervalMs` from `.positive()` to `.min(5000)` (Q3 — minimum 5s poll interval)

### T003 [DONE] Add repo name collision validation to `ReposContextSchema`
**File**: `packages/templates/src/schema.ts`
- Add `.superRefine()` to `ReposContextSchema` that checks all repos (primary, dev[], clone[]) resolve to unique `repoName` values (Q9)
- Extract repo names via `r.split('/')[1]` and check for duplicates
- Error message must identify which specific repos collide (use `.superRefine()` for dynamic message)

---

## Phase 2: Template Fixes

### T004 [DONE] [P] Fix `docker-compose.yml.hbs` template
**File**: `packages/templates/src/multi-repo/docker-compose.yml.hbs`
- Remove `version: "3.8"` line and blank line after it (line 9–10, Q6 — obsolete field)
- Remove `ports:` section from redis service (lines 19–20, Q5 — no host port exposure)
- Remove `features:` block from orchestrator service (lines 36–38, Q1 — features belong in devcontainer.json only)
- Change primary repo mount from `../..` to `..` in orchestrator volumes (line 61, Q11 — `.devcontainer/` lives inside primary repo)
- Remove `features:` block from worker service (lines 106–108, Q1)
- Change primary repo mount from `../..` to `..` in worker volumes (line 128, Q11)
- Remove `vscode-server` volume mount from worker (lines 144–145, Q8 — workers don't need VS Code server)
- Add health check to worker service after `command: sleep infinity` (Q7 — mirror orchestrator's health check):
  ```yaml
      healthcheck:
        test: ["CMD", "test", "-f", "/home/vscode/.generacy/ready"]
        interval: 10s
        timeout: 5s
        retries: 3
        start_period: 30s
  ```

### T005 [DONE] [P] Add `features` block to `devcontainer.json.hbs`
**File**: `packages/templates/src/multi-repo/devcontainer.json.hbs`
- Add `features` block with Generacy Dev Container Feature (Q1 — features belong in devcontainer.json, not docker-compose)
- Place between `"workspaceFolders"` and `"customizations"` (consistent with single-repo template):
  ```json
    "features": {
      "ghcr.io/generacy-ai/features/generacy{{devcontainer.featureTag}}": {}
    },
  ```

---

## Phase 3: Renderer Fix

### T006 [DONE] [P] Set `noEscape: true` in Handlebars compiler
**File**: `packages/templates/src/renderer.ts`
- Change `noEscape: false` to `noEscape: true` at line 261 (Q12 — templates produce YAML/JSON, not HTML; HTML escaping corrupts output with `&amp;` etc.)
- Update comment from `// Allow HTML escaping (safer default)` to `// Templates produce YAML/JSON, not HTML`

---

## Phase 4: Builder Updates

### T007 [DONE] [P] Update default `workerCount` in multi-repo builder
**File**: `packages/templates/src/builders.ts`
- Change `const workerCount = validated.workerCount ?? 3` to `?? 2` at line 197 (Q2 — default is 2, not 3)

---

## Phase 5: Validator Updates

### T008 [DONE] [P] Add `worker` to required docker-compose services
**File**: `packages/templates/src/validators.ts`
- Change `const requiredServices = ['redis', 'orchestrator']` to `['redis', 'orchestrator', 'worker']` at line 314

### T009 [DONE] [P] Verify devcontainer.json features validation path for multi-repo
**File**: `packages/templates/src/validators.ts`
- After T005 adds `features` to multi-repo devcontainer.json, verify lines 250–275 exercise the Generacy feature check for multi-repo templates
- The `hasFeatures` check at line 264 should now fire for multi-repo since we added `features`
- No code change expected — this is a verification task. If the check doesn't fire, update the logic

---

## Phase 6: Fixture Updates

### T010 [DONE] [P] Update `multi-repo-context.json` fixture values
**File**: `packages/templates/tests/fixtures/multi-repo-context.json`
- Change `orchestrator.pollIntervalMs` from `3000` to `5000` (must satisfy new `.min(5000)` constraint)
- Change `orchestrator.workerCount` from `3` to `2` (match new default)

### T011 [DONE] [P] Update `large-multi-repo-context.json` fixture values
**File**: `packages/templates/tests/fixtures/large-multi-repo-context.json`
- Change `orchestrator.pollIntervalMs` from `2000` to `5000` (must satisfy new `.min(5000)` constraint)

### T012 [DONE] [P] Update `invalid-contexts.json` fixture
**File**: `packages/templates/tests/fixtures/invalid-contexts.json`
- Update `zeroPollInterval.expectedError` from `"Number must be greater than 0"` to `"Number must be greater than or equal to 5000"` (`.positive()` → `.min(5000)` changes the error message)
- `negativeWorkerCount.expectedError` stays as `"Number must be greater than or equal to 0"` (`.nonnegative()` retained for OrchestratorContextSchema)
- Add new invalid context case for multi-repo input with `workerCount: 0` (should fail `.min(1)` on MultiRepoInputSchema)
- Add new invalid context case for `pollIntervalMs: 1000` (should fail `.min(5000)`)

### T013 [DONE] [P] Verify `single-repo-context.json` still passes validation
**File**: `packages/templates/tests/fixtures/single-repo-context.json`
- Verify `orchestrator.workerCount: 0` is still valid under updated schema (`.nonnegative().max(20)` allows 0)
- No code change expected — verification only

---

## Phase 7: Test Updates

### T014 [DONE] Update unit tests for schema changes
**Files**:
- `packages/templates/tests/unit/validators.test.ts`
- Update expected error messages for `pollIntervalMs` validation (`.positive()` → `.min(5000)`)
- Add tests for repo name collision validation (`.superRefine()` on `ReposContextSchema`)
- Update docker-compose validation tests to expect `worker` as a required service

### T015 [DONE] Update unit tests for builder changes
**File**: `packages/templates/tests/unit/builders.test.ts`
- Update default `workerCount` expectations from `3` to `2`

### T016 [DONE] Update unit tests for renderer changes
**File**: `packages/templates/tests/unit/renderer.test.ts`
- Update any tests asserting HTML escaping behavior (`noEscape: true` means `&` stays `&`, not `&amp;`)
- Verify template rendering with special characters produces correct YAML/JSON output

### T017 [DONE] Update integration tests
**Files**:
- `packages/templates/tests/integration/render-project.test.ts`
- Update assertions about docker-compose content: no `version` field, no `features` in services, no redis `ports`, corrected mount paths (`..` not `../..`), worker health check present, no `vscode-server` on worker
- Update assertions about devcontainer.json content: `features` block present for multi-repo
- Update default `workerCount` assertions (3 → 2)

### T018 [DONE] Update fixture validation tests
**File**: `packages/templates/tests/fixtures/fixture-validation.test.ts`
- Ensure all updated fixtures pass validation with new schema constraints
- Add test cases for new invalid contexts added in T012

### T019 [DONE] Regenerate snapshot tests
**Files**:
- `packages/templates/tests/integration/snapshots.test.ts`
- `packages/templates/tests/integration/__snapshots__/snapshots.test.ts.snap`
- Run `pnpm test -- --update` in `packages/templates/` to regenerate all snapshots
- Review snapshot diff carefully — should reflect: no `version: "3.8"`, no redis `ports`, no `features` in docker-compose services, `features` block in multi-repo devcontainer.json, `..` mounts, worker health check, no worker `vscode-server`, updated defaults

---

## Phase 8: Final Validation

### T020 [DONE] Run full test suite and verify coverage
**Command**: `pnpm test` in `packages/templates/`
- All unit tests pass
- All integration tests pass
- All snapshot tests pass
- Coverage meets 80% threshold for lines/functions/branches/statements

### T021 Manual template output verification
- Render multi-repo docker-compose.yml with standard fixture and verify:
  - No `version:` field at top
  - Redis has no `ports:` section
  - No `features:` blocks in any service
  - Primary mount uses `..` not `../..`
  - Worker has health check matching orchestrator's
  - Worker has no `vscode-server` volume
  - `WORKER_COUNT=2` (default)
- Render multi-repo devcontainer.json and verify:
  - `features` block with `ghcr.io/generacy-ai/features/generacy:1` present
  - `customizations` block still present
- Verify rendered YAML parses without errors (no HTML-escaped characters)

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (Schema) must complete before Phase 4 (Builders) and Phase 6 (Fixtures) — schemas define constraints that builders and fixtures must satisfy
- Phase 2 (Templates) must complete before Phase 5 (Validators) — validator checks depend on template structure
- Phases 1–6 must complete before Phase 7 (Tests) — tests validate all prior changes
- Phase 7 must complete before Phase 8 (Final Validation) — need passing tests

**Parallel opportunities within phases**:
- T004, T005 can run in parallel (different template files)
- T006, T007 can run in parallel (different source files, independent changes)
- T008, T009 can run in parallel (different validator concerns)
- T010, T011, T012, T013 can run in parallel (different fixture files)
- T004, T005, T006, T007, T008 can all run in parallel (all in Phase 2–5, different files, no inter-dependencies)

**Critical path**:
T001 → T002 → T003 → T004/T005/T006/T007/T008 (parallel) → T010/T011/T012 (parallel) → T014 → T015 → T016 → T017 → T018 → T019 → T020 → T021

**Risk items**:
- Single-repo `workerCount: 0` regression — verify T013 after T001
- Snapshot churn — regenerate snapshots (T019) only after all template/schema changes are complete
- `noEscape` change — audit template variables for HTML-sensitive characters (project/repo names use `[\w.-]+` regex, so safe)
- YAML syntax after template edits — run `validateRenderedDockerCompose()` on rendered output in T021
