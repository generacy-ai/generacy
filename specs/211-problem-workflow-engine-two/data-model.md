# Data Model: Workflow Engine — Plugin Discovery & Inheritance

## New Types

### WorkflowRegistry (Runtime)

```typescript
// packages/workflow-engine/src/registry/index.ts

/**
 * Global registry mapping workflow names to absolute file paths.
 * Internal storage — not exported directly. Accessed via functions.
 */
type WorkflowRegistryMap = Map<string, string>;
// key: workflow name (e.g., "speckit-feature")
// value: absolute file path (e.g., "/path/to/speckit-feature.yaml")
```

### Workflow Override Types

```typescript
// packages/workflow-engine/src/loader/extends.ts

/**
 * Raw parsed data from a workflow YAML file that uses `extends`.
 * This is the shape after YAML parse but BEFORE validation/merge.
 */
export interface RawWorkflowData {
  name?: string;
  description?: string;
  version?: string;
  extends?: string;
  inputs?: Array<{
    name: string;
    description?: string;
    default?: unknown;
    required?: boolean;
    type?: string;
  }>;
  phases?: Array<{
    name: string;
    steps: Array<Record<string, unknown>>;
    condition?: string;
  }>;
  overrides?: WorkflowOverride;
  env?: Record<string, string>;
  timeout?: number;
  retry?: {
    maxAttempts?: number;
    delay?: number | string;
    backoff?: string;
    maxDelay?: number | string;
    jitter?: number;
  };
}

/**
 * Override specification for workflow inheritance.
 * Used within the `overrides:` block of a workflow YAML.
 */
export interface WorkflowOverride {
  /** Phase-level overrides, keyed by phase name */
  phases?: Record<string, PhaseOverride>;
  /** Additional inputs to merge with base */
  inputs?: Array<{
    name: string;
    description?: string;
    default?: unknown;
    required?: boolean;
    type?: string;
  }>;
  /** Environment variable overrides (shallow merge, override wins) */
  env?: Record<string, string>;
}

/**
 * Override for a single phase.
 * - If the phase name matches a base phase: replaces steps/condition
 * - If the phase name is new: must have `before` or `after` directive
 */
export interface PhaseOverride {
  /** Replacement steps (entire step list replaced, not merged) */
  steps?: Array<Record<string, unknown>>;
  /** Override condition expression */
  condition?: string;
  /** Insert this new phase before the named phase */
  before?: string;
  /** Insert this new phase after the named phase */
  after?: string;
}
```

### WorkflowResolver Type

```typescript
// packages/workflow-engine/src/loader/index.ts

/**
 * Function type for resolving workflow names to file paths.
 * Used by loadWorkflowWithExtends to find base workflows.
 *
 * @param name - Workflow name to resolve
 * @param excludePath - Absolute path to exclude from results (prevents self-resolution)
 * @returns Absolute file path to the workflow YAML file
 */
export type WorkflowResolver = (name: string, excludePath?: string) => string;
```

## New Error Classes

```typescript
// packages/workflow-engine/src/errors/base-workflow-not-found.ts
export class BaseWorkflowNotFoundError extends Error {
  public readonly workflowName: string;
  public readonly searchedLocations: string[];

  constructor(workflowName: string, searchedLocations: string[]) {
    const locations = searchedLocations.map(l => `  - ${l}`).join('\n');
    super(
      `Base workflow '${workflowName}' not found.\nSearched:\n${locations}`
    );
    this.name = 'BaseWorkflowNotFoundError';
    this.workflowName = workflowName;
    this.searchedLocations = searchedLocations;
  }
}

// packages/workflow-engine/src/errors/circular-extends.ts
export class CircularExtendsError extends Error {
  public readonly chain: string[];

  constructor(chain: string[]) {
    super(
      `Circular extends detected: ${chain.join(' → ')}`
    );
    this.name = 'CircularExtendsError';
    this.chain = chain;
  }
}

// packages/workflow-engine/src/errors/workflow-override.ts
export class WorkflowOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowOverrideError';
  }
}
```

## Existing Types (Unchanged)

These types are **not modified** — the merged output of extends always produces a standard `WorkflowDefinition`:

```typescript
// packages/workflow-engine/src/types/workflow.ts (existing, unchanged)
export interface WorkflowDefinition {
  name: string;
  description?: string;
  version?: string;
  inputs?: InputDefinition[];
  phases: PhaseDefinition[];
  env?: Record<string, string>;
  timeout?: number;
  retry?: RetryConfig;
}

export interface PhaseDefinition {
  name: string;
  steps: StepDefinition[];
  condition?: string;
}
```

## Workflow YAML Schema (Extended Format)

### Standard Workflow (no changes)

```yaml
name: speckit-feature
description: Standard feature workflow
version: "1.3.0"
inputs:
  - name: description
    type: string
    required: true
phases:
  - name: setup
    steps:
      - name: create-feature
        uses: speckit.create_feature
  # ... more phases
```

### Override Workflow (new format)

```yaml
# Extends a base workflow with selective overrides
extends: speckit-feature

# Optional: override scalar fields
name: speckit-feature-custom
description: Custom feature workflow with longer timeouts

# Optional: override env (shallow merge)
overrides:
  # Optional: additional/override env vars
  env:
    CUSTOM_FLAG: "true"

  # Optional: additional/override inputs
  inputs:
    - name: deploy_target
      type: string
      default: staging

  # Optional: phase-level overrides
  phases:
    # Override an existing phase (matched by name)
    implementation:
      steps:
        - name: implement
          uses: speckit.implement
          with:
            feature_dir: ${{ steps.create-feature.output.feature_dir }}
          timeout: 7200000  # 2 hours instead of 1

    # Insert a new phase (positional directive required)
    deploy:
      after: verification
      steps:
        - name: deploy-staging
          uses: shell
          command: npm run deploy:staging
```

### Full Replacement Mode (alternative to overrides)

```yaml
# Use extends with full phases replacement
extends: speckit-feature
name: speckit-feature-minimal

# Providing `phases` directly replaces ALL base phases
# Cannot be combined with overrides.phases (error)
phases:
  - name: setup
    steps:
      - name: create-feature
        uses: speckit.create_feature
  - name: implementation
    steps:
      - name: implement
        uses: speckit.implement
```

## Resolution Order Diagram

```
resolveWorkflowPath("speckit-feature", workdir, excludePath?)
│
├─ 1. Is absolute path? → return if exists and != excludePath
│
├─ 2. Relative to workdir: resolve(workdir, name)
│     → return if exists and != excludePath
│
├─ 3. Repo-local: workdir/.generacy/{name}[.yaml|.yml]
│     → return if exists and != excludePath
│     (Highest priority for repo-level overrides)
│
├─ 4. WorkflowRegistry: resolveRegisteredWorkflow(name)
│     → return if registered and != excludePath
│     (Plugin-provided workflows)
│
├─ 5. Hardcoded fallback (temporary):
│     /workspaces/tetrad-development/.generacy/{name}[.yaml|.yml]
│     → return if exists and != excludePath
│
└─ 6. Return raw string (produces "file not found" downstream)
```
