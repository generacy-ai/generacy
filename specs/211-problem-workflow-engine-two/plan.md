# Implementation Plan: Workflow Engine — Plugin Discovery & Inheritance

**Branch**: `211-problem-workflow-engine-two`
**Date**: 2026-02-21
**Status**: Draft

## Summary

This feature adds two capabilities to the workflow engine:

1. **WorkflowRegistry** — A global singleton registry (following the `actionRegistry` pattern) that allows any code to register named workflow file paths. `resolveWorkflowPath()` in `job-handler.ts` gains a plugin-registry search tier between repo-local `.generacy/` and the hardcoded fallback.

2. **Workflow inheritance (`extends`)** — Workflow YAML files can declare `extends: <base-workflow>` to inherit from a base workflow and selectively override phases, inputs, env, and scalar fields. The loader uses two-pass validation: loose parse → resolve extends → merge → validate merged result against the existing strict schema.

3. **Cleanup** — Remove the hardcoded `/workspaces/tetrad-development` fallback once plugin-provided workflows are working.

## Technical Context

| Aspect | Detail |
|--------|--------|
| Language | TypeScript (ESM, `.js` extensions in imports) |
| Package | `@generacy-ai/workflow-engine` (`packages/workflow-engine/`) |
| Consumer | `packages/generacy/src/orchestrator/job-handler.ts` |
| Schema validation | Zod |
| YAML parsing | `yaml` package (`parse`) |
| Testing | Vitest (`packages/workflow-engine/vitest.config.ts`) |
| Existing pattern | `actionRegistry` global singleton in `packages/workflow-engine/src/actions/index.ts` |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    job-handler.ts (consumer)                     │
│                                                                 │
│  resolveWorkflowPath(name, workdir)                            │
│    1. Absolute path                                             │
│    2. Relative to workdir                                       │
│    3. .generacy/ in workdir  ←── repo-local override (highest) │
│    4. WorkflowRegistry       ←── NEW: plugin-provided fallback │
│    5. (removed: /workspaces/tetrad-development)                │
│                                                                 │
│  loadWorkflowWithExtends(path, resolver)  ←── NEW              │
│    - Parse YAML loosely                                         │
│    - If `extends`: resolve base, recurse, merge                │
│    - Validate merged result with WorkflowDefinitionSchema      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│              packages/workflow-engine/src/                       │
│                                                                 │
│  registry/                                                      │
│    index.ts          ←── WorkflowRegistry (global singleton)   │
│                                                                 │
│  loader/                                                        │
│    index.ts          ←── loadWorkflowWithExtends() added       │
│    extends.ts        ←── NEW: merge logic for extends          │
│    validator.ts      ←── unchanged (strict schema stays)       │
│    schema.ts         ←── unchanged                             │
│                                                                 │
│  errors/                                                        │
│    base-workflow-not-found.ts  ←── NEW                         │
│    circular-extends.ts        ←── NEW                          │
│    workflow-override.ts       ←── NEW                          │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: WorkflowRegistry (Global Singleton)

**Files to create:**
- `packages/workflow-engine/src/registry/index.ts`

**Files to modify:**
- `packages/workflow-engine/src/index.ts` (export registry functions)

**Implementation:**

Create a `WorkflowRegistry` module following the exact pattern of `actions/index.ts`:

```typescript
// packages/workflow-engine/src/registry/index.ts

/** Global registry: workflow name → absolute file path */
const workflowRegistry = new Map<string, string>();

/**
 * Register a workflow by name.
 * @throws Error if filePath does not exist (validated at registration time per Q7)
 */
export function registerWorkflow(name: string, filePath: string): void;

/**
 * Register multiple workflows at once.
 */
export function registerWorkflows(workflows: Map<string, string> | Record<string, string>): void;

/**
 * Resolve a workflow name to a file path from the registry.
 * @returns The absolute file path, or undefined if not registered.
 */
export function resolveRegisteredWorkflow(name: string): string | undefined;

/** Check if a workflow is registered */
export function hasRegisteredWorkflow(name: string): boolean;

/** Get all registered workflow names */
export function getRegisteredWorkflowNames(): string[];

/** Clear registry (for testing) */
export function clearWorkflowRegistry(): void;
```

Key decisions:
- `registerWorkflow()` validates file existence at registration time (Q7 answer: A)
- Overwriting an existing registration logs a warning (consistent with `registerActionHandler`)
- No lazy init needed — registry is populated explicitly during startup

**Tests:** `packages/workflow-engine/src/registry/__tests__/registry.test.ts`
- Register and resolve workflows
- Overwrite warning
- Throw on non-existent file path
- `clearWorkflowRegistry()` empties registry
- `registerWorkflows()` batch registration

---

### Phase 2: Workflow Extends/Inheritance

**Files to create:**
- `packages/workflow-engine/src/loader/extends.ts`
- `packages/workflow-engine/src/errors/base-workflow-not-found.ts`
- `packages/workflow-engine/src/errors/circular-extends.ts`
- `packages/workflow-engine/src/errors/workflow-override.ts`

**Files to modify:**
- `packages/workflow-engine/src/loader/index.ts` (add `loadWorkflowWithExtends`)
- `packages/workflow-engine/src/index.ts` (export new functions and error classes)

#### 2a: Error Classes

```typescript
// errors/base-workflow-not-found.ts
export class BaseWorkflowNotFoundError extends Error {
  constructor(workflowName: string, searchedLocations: string[]) { ... }
}

// errors/circular-extends.ts
export class CircularExtendsError extends Error {
  constructor(chain: string[]) { ... }
}

// errors/workflow-override.ts
export class WorkflowOverrideError extends Error {
  constructor(message: string) { ... }
}
```

#### 2b: Merge Logic (`extends.ts`)

The `mergeWorkflows()` function implements the merge semantics from the spec:

```typescript
// loader/extends.ts

export interface WorkflowOverride {
  phases?: Record<string, {
    steps?: StepDefinitionRaw[];
    condition?: string;
    /** Insert new phase before this phase */
    before?: string;
    /** Insert new phase after this phase */
    after?: string;
  }>;
  inputs?: InputDefinitionRaw[];
  env?: Record<string, string>;
}

/**
 * Merge a base WorkflowDefinition with override data.
 *
 * Merge semantics (from spec):
 * - Top-level scalars (name, description, version): override wins if present
 * - phases: matched by name from overrides.phases
 *   - Existing phase matched by name: steps replaced entirely, condition overridden
 *   - New phase with before:/after: inserted at position
 *   - New phase without positional directive: ERROR (Q4 answer: A)
 * - inputs: merged (base + override, override wins on name collision)
 * - env: shallow merge, override wins
 * - timeout: override wins if present
 * - retry: override wins if present
 */
export function mergeWorkflows(
  base: WorkflowDefinition,
  overrideData: {
    name?: string;
    description?: string;
    version?: string;
    timeout?: number;
    retry?: RetryConfig;
    overrides?: WorkflowOverride;
    phases?: PhaseDefinition[];  // full replacement mode
  }
): WorkflowDefinition;
```

Validation rules enforced during merge:
- `phases` and `overrides.phases` are mutually exclusive when `extends` is present (Q12: A)
- Phase name in `overrides.phases` that doesn't exist in base and has no `before:`/`after:` → error (Q4: A)
- `overrides` without `extends` → error (Q6: A — enforced in the loader, not the merge function)

#### 2c: Loader Integration (`loadWorkflowWithExtends`)

```typescript
// loader/index.ts

export type WorkflowResolver = (name: string, excludePath?: string) => string;

/**
 * Load a workflow with extends support.
 * Uses two-pass validation (Q3 answer: C):
 *   1. Parse YAML loosely (no schema validation)
 *   2. If `extends` present, resolve base, recurse, merge
 *   3. Validate final merged result against WorkflowDefinitionSchema
 *
 * @param filePath - Path to the workflow YAML file
 * @param resolver - Function to resolve workflow names to file paths
 * @param _seen - Internal: chain of file paths for circular detection
 */
export async function loadWorkflowWithExtends(
  filePath: string,
  resolver: WorkflowResolver,
  _seen?: Set<string>,
): Promise<WorkflowDefinition>;
```

Algorithm:
1. Read and parse YAML (no validation yet)
2. Check for `overrides` without `extends` → error (Q6)
3. Check for `extends` + both `phases` and `overrides.phases` → error (Q12)
4. If no `extends`: validate with existing `validateWorkflow()` and return
5. If `extends`:
   a. Check circular: if `filePath` is in `_seen` → `CircularExtendsError`
   b. Resolve base: call `resolver(data.extends, filePath)` — skips current file (Q9: A)
   c. Recurse: `loadWorkflowWithExtends(basePath, resolver, seen)` — gives us a validated `WorkflowDefinition`
   d. Merge: `mergeWorkflows(baseDefinition, overrideData)` (Q8: A — recursive bottom-up)
   e. Validate merged result with `validateWorkflow()`
   f. Return

**Tests:** `packages/workflow-engine/src/loader/__tests__/extends.test.ts`
- Basic extends: override scalar fields
- Phase override: replace steps in existing phase
- Phase insertion: `before:` and `after:` directives
- Input merging: base + override, override wins on collision
- Env merging: shallow merge, override wins
- Circular extends detection
- Base workflow not found error
- `overrides` without `extends` rejected
- `phases` + `overrides.phases` mutually exclusive
- Phase name not in base without positional directive → error
- Multi-level extends (A extends B extends C) with correct merge order
- Name override behavior (Q11: A)

---

### Phase 3: Integrate with `resolveWorkflowPath()` and Job Handler

**Files to modify:**
- `packages/generacy/src/orchestrator/job-handler.ts`

#### 3a: Update `resolveWorkflowPath()`

Add the registry as a search tier and support `excludePath` parameter:

```typescript
private resolveWorkflowPath(
  workflow: string,
  jobWorkdir?: string,
  excludePath?: string,
): string {
  // 1. Absolute path
  if (isAbsolute(workflow) && existsSync(workflow) && resolve(workflow) !== excludePath) {
    return workflow;
  }

  const searchDir = jobWorkdir ?? this.workdir;

  // 2. Relative to workdir
  const direct = resolve(searchDir, workflow);
  if (existsSync(direct) && resolve(direct) !== excludePath) return direct;

  // 3. .generacy/ in workdir (repo-local override — highest priority)
  for (const ext of ['', '.yaml', '.yml']) {
    const candidate = resolve(searchDir, '.generacy', `${workflow}${ext}`);
    if (existsSync(candidate) && resolve(candidate) !== excludePath) return candidate;
  }

  // 4. Plugin-provided workflows (WorkflowRegistry)
  const registered = resolveRegisteredWorkflow(workflow);
  if (registered && registered !== excludePath) return registered;

  // 5. Hardcoded fallback (to be removed in Phase 4)
  const fallbackDir = '/workspaces/tetrad-development';
  const fallbackDirect = resolve(fallbackDir, workflow);
  if (existsSync(fallbackDirect) && resolve(fallbackDirect) !== excludePath) return fallbackDirect;
  for (const ext of ['', '.yaml', '.yml']) {
    const candidate = resolve(fallbackDir, '.generacy', `${workflow}${ext}`);
    if (existsSync(candidate) && resolve(candidate) !== excludePath) return candidate;
  }

  return workflow;
}
```

#### 3b: Update `executeJob()` to use `loadWorkflowWithExtends`

Replace `loadWorkflow(resolvedPath)` with `loadWorkflowWithExtends(resolvedPath, resolver)`:

```typescript
// In executeJob(), replace the workflow loading block:
const resolvedPath = this.resolveWorkflowPath(job.workflow, jobWorkdir);
const resolver: WorkflowResolver = (name, excludePath) =>
  this.resolveWorkflowPath(name, jobWorkdir, excludePath);
definition = await loadWorkflowWithExtends(resolvedPath, resolver);
```

**Tests:** Unit tests for `resolveWorkflowPath` with mocked filesystem
- Repo-local `.generacy/` takes priority over registry
- Registry takes priority over hardcoded fallback
- `excludePath` skips the specified file
- Unresolved workflow returns raw string (existing behavior)

---

### Phase 4: Built-in Workflow Registration (Phased Approach)

**Files to modify:**
- `packages/generacy/src/orchestrator/job-handler.ts` (or a startup module)

Per Q10 answer (C — phased approach), register the default speckit workflows from the known `.generacy/` location in the generacy package during orchestrator startup:

```typescript
// Called during orchestrator initialization
import { registerWorkflow } from '@generacy-ai/workflow-engine';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

function registerBuiltinWorkflows(): void {
  const workflowDir = resolve(import.meta.dirname, '../../.generacy');
  const builtins = ['speckit-feature', 'speckit-bugfix'];
  for (const name of builtins) {
    const path = resolve(workflowDir, `${name}.yaml`);
    if (existsSync(path)) {
      registerWorkflow(name, path);
    }
  }
}
```

This is a temporary bridge. When `agency-plugin-spec-kit` is extracted (agency#244), the plugin itself will call `registerWorkflow()` with its bundled workflow files.

---

### Phase 5: Remove Hardcoded Fallback

**Files to modify:**
- `packages/generacy/src/orchestrator/job-handler.ts`

Remove the `/workspaces/tetrad-development` search tier from `resolveWorkflowPath()`. This can happen once all workflows that were previously found via the fallback are registered through the registry.

---

### Phase 6: Export and Package Integration

**Files to modify:**
- `packages/workflow-engine/src/index.ts`

Add exports for:
```typescript
// Registry
export {
  registerWorkflow,
  registerWorkflows,
  resolveRegisteredWorkflow,
  hasRegisteredWorkflow,
  getRegisteredWorkflowNames,
  clearWorkflowRegistry,
} from './registry/index.js';

// Extends loader
export { loadWorkflowWithExtends, type WorkflowResolver } from './loader/index.js';

// Error classes
export { BaseWorkflowNotFoundError } from './errors/base-workflow-not-found.js';
export { CircularExtendsError } from './errors/circular-extends.js';
export { WorkflowOverrideError } from './errors/workflow-override.js';
```

---

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `packages/workflow-engine/src/registry/index.ts` | **Create** | WorkflowRegistry global singleton |
| `packages/workflow-engine/src/loader/extends.ts` | **Create** | `mergeWorkflows()` merge logic |
| `packages/workflow-engine/src/errors/base-workflow-not-found.ts` | **Create** | Error class for missing base workflow |
| `packages/workflow-engine/src/errors/circular-extends.ts` | **Create** | Error class for circular extends |
| `packages/workflow-engine/src/errors/workflow-override.ts` | **Create** | Error class for invalid override configs |
| `packages/workflow-engine/src/loader/index.ts` | **Modify** | Add `loadWorkflowWithExtends()`, export `WorkflowResolver` type |
| `packages/workflow-engine/src/index.ts` | **Modify** | Export registry, extends, and error classes |
| `packages/generacy/src/orchestrator/job-handler.ts` | **Modify** | Update `resolveWorkflowPath()`, use `loadWorkflowWithExtends()`, register built-in workflows |
| `packages/workflow-engine/src/registry/__tests__/registry.test.ts` | **Create** | Registry unit tests |
| `packages/workflow-engine/src/loader/__tests__/extends.test.ts` | **Create** | Extends/merge unit tests |

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Registry pattern | Global singleton (Q2: A) | Matches `actionRegistry` pattern; simpler wiring |
| Registration API | Standalone function (Q1: D) | Matches `registerActionHandler()` convention; no plugin lifecycle changes needed |
| Schema validation | Two-pass (Q3: C) | Loose parse first, validate after merge; strict schema unchanged |
| Invalid phase ref | Error (Q4: A) | Fail fast on typos; "Did you mean X?" helpful |
| Missing base workflow | Specific error (Q5: A) | `BaseWorkflowNotFoundError` with searched locations |
| `overrides` without `extends` | Reject (Q6: A) | Always a mistake; catch early |
| Path validation | At registration (Q7: A) | Fail loudly during startup |
| Multi-level merge order | Recursive bottom-up (Q8: A) | Standard inheritance model |
| Self-exclusion | Skip exact file path (Q9: A) | Most precise; allows repo-local to extend other repo-local |
| Initial registration | Phased/built-in (Q10: C) | Ship independently of agency#244 |
| Name override | Allowed (Q11: A) | Standard scalar override; useful for distinguishing variants |
| `phases` + `overrides.phases` | Mutually exclusive error (Q12: A) | Ambiguous intent; always a mistake |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Breaking existing workflows | Two-pass validation ensures existing (non-extends) workflows still use the exact same strict schema path. No changes to `WorkflowDefinitionSchema`. |
| Registry not populated before first job | Built-in workflow registration happens in orchestrator startup (same as `ensureActionsRegistered()`). |
| Circular extends infinite loop | Explicit chain tracking via `Set<string>` of resolved file paths; `CircularExtendsError` thrown with the full chain for debugging. |
| Merge semantics edge cases | Comprehensive unit tests for all merge scenarios. Strict error on ambiguous inputs (Q4, Q6, Q12). |
| Fallback removal too early | Phase 5 (fallback removal) is a separate step; the fallback remains until we confirm all workflows are registered. |
| File path staleness in registry | Validated at registration time (Q7). Process restarts after `node_modules` changes re-register fresh paths. |

## Dependency Order

```
Phase 1 (Registry) ──→ Phase 3 (resolveWorkflowPath integration)
                                    │
Phase 2 (Extends)  ──→ Phase 3 (loadWorkflowWithExtends integration)
                                    │
                                    ▼
                        Phase 4 (Built-in registration)
                                    │
                                    ▼
                        Phase 5 (Remove fallback)
                                    │
Phase 6 (Exports) ──── runs in parallel with Phase 3+
```

Phases 1 and 2 are independent and can be implemented in parallel. Phase 3 depends on both. Phase 4 depends on Phase 3. Phase 5 depends on Phase 4 being validated in production. Phase 6 should be kept up to date as each phase adds new exports.
