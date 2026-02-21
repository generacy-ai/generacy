# Tasks: Workflow Engine — Plugin Discovery & Inheritance

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: WorkflowRegistry (Global Singleton)

### T001 [P] [Plugin Discovery] Create WorkflowRegistry module
**File**: `packages/workflow-engine/src/registry/index.ts`
- Create `registry/` directory under `packages/workflow-engine/src/`
- Implement module-level `workflowRegistry` Map (follows `actionRegistry` pattern in `actions/index.ts`)
- Implement `registerWorkflow(name, filePath)` — validates file existence at registration time, logs warning on overwrite
- Implement `registerWorkflows(workflows)` — batch registration from `Map` or `Record`
- Implement `resolveRegisteredWorkflow(name)` — returns `string | undefined`
- Implement `hasRegisteredWorkflow(name)` — boolean check
- Implement `getRegisteredWorkflowNames()` — returns all registered names
- Implement `clearWorkflowRegistry()` — clears registry (for testing)

### T002 [P] [Inheritance] Create error classes for extends/override
**Files**:
- `packages/workflow-engine/src/errors/base-workflow-not-found.ts`
- `packages/workflow-engine/src/errors/circular-extends.ts`
- `packages/workflow-engine/src/errors/workflow-override.ts`
- Create `BaseWorkflowNotFoundError` — includes workflow name and searched locations in message
- Create `CircularExtendsError` — includes the full chain of file paths for debugging
- Create `WorkflowOverrideError` — generic error for invalid override configurations (e.g., `overrides` without `extends`, `phases` + `overrides.phases` simultaneously)
- All follow the pattern of existing `CorrelationTimeoutError` in `errors/correlation-timeout.ts` (extends `Error`, sets `this.name`)

### T003 [P] [Inheritance] Implement workflow merge logic (`extends.ts`)
**File**: `packages/workflow-engine/src/loader/extends.ts`
- Define `WorkflowOverride` interface for the `overrides:` YAML block (phases, inputs, env)
- Implement `mergeWorkflows(base, overrideData)` function
- Top-level scalars (`name`, `description`, `version`, `timeout`, `retry`): override wins if present
- Phases: match by name from `overrides.phases`
  - Existing phase matched by name: steps replaced entirely, condition overridden if provided
  - New phase with `before:`/`after:` directive: insert at specified position
  - New phase without positional directive: throw `WorkflowOverrideError` (fail fast on typos)
- Inputs: merge base + override arrays, override wins on name collision
- Env: shallow merge, override wins on key collision
- `phases` and `overrides.phases` are mutually exclusive — throw `WorkflowOverrideError` if both present

---

## Phase 2: Loader Integration (extends support)

### T004 [Inheritance] Add `loadWorkflowWithExtends()` to loader
**File**: `packages/workflow-engine/src/loader/index.ts`
- Define `WorkflowResolver` type: `(name: string, excludePath?: string) => string`
- Implement `loadWorkflowWithExtends(filePath, resolver, _seen?)` async function
- Two-pass validation: loose YAML parse first (no schema), validate after merge
- If no `extends`: validate with existing `validateWorkflow()` and return (identical to current path)
- If `extends` present:
  - Check for `overrides` without `extends` → throw `WorkflowOverrideError`
  - Check for `extends` + both `phases` and `overrides.phases` → throw `WorkflowOverrideError`
  - Circular detection via `Set<string>` of resolved file paths → throw `CircularExtendsError`
  - Resolve base workflow via `resolver(data.extends, filePath)` — excludes current file
  - Recurse into base: `loadWorkflowWithExtends(basePath, resolver, seen)` for multi-level extends
  - Merge: `mergeWorkflows(baseDefinition, overrideData)`
  - Validate merged result with `validateWorkflow()`
- Export `WorkflowResolver` type and `loadWorkflowWithExtends` function

---

## Phase 3: Integrate with Job Handler

### T005 [Plugin Discovery] Update `resolveWorkflowPath()` in job handler
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Import `resolveRegisteredWorkflow` from `@generacy-ai/workflow-engine`
- Add optional `excludePath` parameter to `resolveWorkflowPath(workflow, jobWorkdir?, excludePath?)`
- Update resolution order:
  1. Absolute path (if exists and not excluded)
  2. Relative to workdir (if exists and not excluded)
  3. `.generacy/` in workdir — repo-local override, highest priority (if not excluded)
  4. **NEW**: `resolveRegisteredWorkflow(workflow)` — plugin-provided fallback (if not excluded)
  5. `/workspaces/tetrad-development` — existing hardcoded fallback (kept for now)
- All candidates skip if `resolve(candidate) === excludePath`

### T006 [Inheritance] Update `executeJob()` to use `loadWorkflowWithExtends`
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Import `loadWorkflowWithExtends` and `WorkflowResolver` from `@generacy-ai/workflow-engine`
- In the file-path branch of `executeJob()` (around lines 244-247), replace:
  ```typescript
  definition = await loadWorkflow(resolvedPath);
  ```
  with:
  ```typescript
  const resolver: WorkflowResolver = (name, excludePath) =>
    this.resolveWorkflowPath(name, jobWorkdir, excludePath);
  definition = await loadWorkflowWithExtends(resolvedPath, resolver);
  ```
- Keep the YAML-string and object branches unchanged (no extends support for inline YAML)

---

## Phase 4: Built-in Workflow Registration

### T007 [Plugin Discovery] Register built-in workflows at startup
**File**: `packages/generacy/src/orchestrator/job-handler.ts` (or orchestrator init)
- Create a `registerBuiltinWorkflows()` helper function
- Scan the generacy package's `.generacy/` directory for known workflow files (e.g., `speckit-feature`, `speckit-bugfix`)
- Call `registerWorkflow(name, absolutePath)` for each found workflow
- Invoke `registerBuiltinWorkflows()` during orchestrator startup (alongside `ensureActionsRegistered()`)
- This is a temporary bridge until `agency-plugin-spec-kit` bundles its own workflows (agency#244)

---

## Phase 5: Package Exports

### T008 [P] [Plugin Discovery] Export registry API from workflow-engine package
**File**: `packages/workflow-engine/src/index.ts`
- Add exports for registry functions: `registerWorkflow`, `registerWorkflows`, `resolveRegisteredWorkflow`, `hasRegisteredWorkflow`, `getRegisteredWorkflowNames`, `clearWorkflowRegistry`

### T009 [P] [Inheritance] Export extends API and error classes from workflow-engine package
**File**: `packages/workflow-engine/src/index.ts`
- Add exports for `loadWorkflowWithExtends` and `WorkflowResolver` type from `./loader/index.js`
- Add exports for error classes: `BaseWorkflowNotFoundError`, `CircularExtendsError`, `WorkflowOverrideError` from `./errors/*.js`

---

## Phase 6: Testing

### T010 [P] [Plugin Discovery] Write unit tests for WorkflowRegistry
**File**: `packages/workflow-engine/src/registry/__tests__/registry.test.ts`
- Test `registerWorkflow()` registers and resolves correctly
- Test `registerWorkflow()` throws on non-existent file path
- Test `registerWorkflow()` logs warning on overwrite (but succeeds)
- Test `registerWorkflows()` batch registration from Record and Map
- Test `resolveRegisteredWorkflow()` returns `undefined` for unregistered names
- Test `hasRegisteredWorkflow()` returns correct boolean
- Test `getRegisteredWorkflowNames()` returns all registered names
- Test `clearWorkflowRegistry()` empties the registry
- Use temp files for realistic path validation

### T011 [P] [Inheritance] Write unit tests for merge logic (`extends.ts`)
**File**: `packages/workflow-engine/src/loader/__tests__/extends.test.ts`
- Test basic scalar override: `name`, `description`, `version` from override win
- Test `timeout` and `retry` override
- Test phase override: replace steps in existing phase entirely
- Test phase override: override `condition` on existing phase
- Test phase insertion with `after:` directive — new phase inserted after named phase
- Test phase insertion with `before:` directive — new phase inserted before named phase
- Test phase with unknown name and no positional directive → `WorkflowOverrideError`
- Test input merging: base inputs preserved, override inputs added, name collision → override wins
- Test env merging: shallow merge, override wins on key collision
- Test `phases` + `overrides.phases` mutually exclusive → `WorkflowOverrideError`
- Test base phases preserved when not mentioned in overrides

### T012 [P] [Inheritance] Write unit tests for `loadWorkflowWithExtends()`
**File**: `packages/workflow-engine/src/loader/__tests__/extends.test.ts` (or separate file)
- Test non-extends workflow loads identically to `loadWorkflow()` (same validation path)
- Test single-level extends: base resolved, merged, validated
- Test multi-level extends: A extends B extends C, correct merge order (C → B → A)
- Test circular extends detection: A extends B extends A → `CircularExtendsError` with chain
- Test self-extends: A extends itself → `CircularExtendsError`
- Test base workflow not found → `BaseWorkflowNotFoundError` with searched locations
- Test `overrides` without `extends` → `WorkflowOverrideError`
- Test `extends` + `phases` (full replacement mode, no `overrides`) works
- Test merged result passes strict `WorkflowDefinitionSchema` validation

### T013 [P] [Plugin Discovery] Write unit tests for updated `resolveWorkflowPath()`
**File**: `packages/generacy/src/orchestrator/__tests__/job-handler.test.ts` (or new test file)
- Test repo-local `.generacy/` takes priority over registry
- Test registry takes priority over hardcoded fallback
- Test `excludePath` parameter skips the specified resolved path
- Test unresolved workflow returns raw string (existing behavior preserved)
- Test absolute path resolution still works
- Test extension inference (`.yaml`, `.yml`) still works

---

## Phase 7: Remove Hardcoded Fallback

### T014 [Cleanup] Remove `/workspaces/tetrad-development` fallback
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Remove the `/workspaces/tetrad-development` search tier from `resolveWorkflowPath()`
- Remove the `searchDirs` array and hardcoded fallback directory
- Verify all workflows previously found via fallback are now registered through the registry
- **Note**: This should only be done after Phase 4 (built-in registration) is validated in production

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001-T003) has no prerequisites — start immediately
- Phase 2 (T004) depends on T002 (error classes) and T003 (merge logic)
- Phase 3 (T005-T006) depends on T001 (registry) and T004 (loader integration)
- Phase 4 (T007) depends on T005 (updated `resolveWorkflowPath`)
- Phase 5 (T008-T009) can run in parallel with Phase 3+ as each phase adds exports
- Phase 6 (T010-T013) can run in parallel with implementation, but tests for each module depend on that module being implemented
- Phase 7 (T014) depends on Phase 4 being validated in production

**Parallel opportunities within phases**:
- T001, T002, T003 are fully independent — run in parallel
- T005 and T006 both modify `job-handler.ts` — run sequentially
- T008 and T009 modify the same file (`index.ts`) — run sequentially or in a single task
- T010, T011, T012, T013 are independent test files — run in parallel

**Critical path**:
T002 + T003 → T004 → T006 → T007 → T014

**Secondary path (plugin discovery)**:
T001 → T005 → T007 → T014

```
T001 (Registry) ─────────────────→ T005 (resolveWorkflowPath) ──┐
                                                                 │
T002 (Errors) ──→ T004 (loadWorkflowWithExtends) ──→ T006 ──→ T007 ──→ T014
                     ↑                                           │
T003 (Merge)  ───────┘                                           │
                                                                 │
T008 + T009 (Exports) ── runs alongside Phase 3+ ───────────────┘
                                                                 │
T010-T013 (Tests) ── run after respective modules implemented ───┘
```
