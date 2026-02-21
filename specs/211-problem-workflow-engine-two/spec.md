# Feature Specification: Plugin-Provided Workflow Discovery and Workflow Inheritance

**Branch**: `211-problem-workflow-engine-two` | **Date**: 2026-02-21 | **Status**: Draft

## Summary

The workflow engine currently requires every repository to maintain full copies of workflow YAML files because `resolveWorkflowPath()` can only search the repo's `.generacy/` directory and a hardcoded `/workspaces/tetrad-development` fallback. This feature introduces two capabilities: (1) plugin-provided workflow discovery, allowing plugins like `agency-plugin-spec-kit` to bundle and register workflows that the engine can resolve automatically, and (2) a workflow `extends` mechanism that lets repos override specific parts of a base workflow without forking the entire file. Together, these eliminate workflow duplication across repos and enable centralized workflow maintenance.

## User Stories

### US1: Plugin-Provided Workflow Resolution

**As a** plugin author,
**I want** to bundle workflow YAML files in my plugin package and register them with the workflow engine,
**So that** repos using my plugin can run those workflows without copying files into their `.generacy/` directory.

**Acceptance Criteria**:
- [ ] Plugins can call `registerWorkflows(map)` during initialization to register a `Map<string, string>` of workflow name to file path
- [ ] `resolveWorkflowPath()` searches the plugin workflow registry as a fallback tier after repo-local `.generacy/`
- [ ] Repo-local `.generacy/` files always take priority over plugin-provided workflows
- [ ] Repos with no `.generacy/` workflow files can run plugin-provided workflows by name
- [ ] Multiple plugins can register workflows; names are first-come-first-served with a warning on collision

### US2: Repo-Local Workflow Override

**As a** repository maintainer,
**I want** to place a workflow file in my `.generacy/` directory that takes priority over the plugin-provided version,
**So that** I can customize a plugin workflow for my repo's specific needs without modifying the plugin.

**Acceptance Criteria**:
- [ ] A `.generacy/speckit-feature.yaml` in the repo overrides the plugin-provided `speckit-feature` workflow
- [ ] The override is a complete replacement (not merged) when no `extends` field is present
- [ ] Resolution order is documented and deterministic

### US3: Workflow Inheritance via `extends`

**As a** repository maintainer,
**I want** to create a workflow that extends a base workflow and overrides only specific phases or settings,
**So that** I can make small customizations (timeouts, extra steps, additional phases) without duplicating the entire workflow.

**Acceptance Criteria**:
- [ ] `extends: speckit-feature` in a workflow YAML resolves the base workflow via the normal resolution chain (excluding the extending file itself)
- [ ] Phases from the base are preserved unless explicitly overridden by name in the `overrides.phases` block
- [ ] Steps within an overridden phase are replaced entirely (not merged at step level)
- [ ] New phases can be inserted with `after:` or `before:` positional directives
- [ ] Inputs are merged: base inputs + override inputs, with override winning on name collision
- [ ] Top-level scalar fields (`version`, `description`, `name`) from the override file win over base
- [ ] Top-level `env` is merged (override keys win on collision)
- [ ] Top-level `timeout` and `retry` from override replace base values entirely

### US4: Circular Extends Detection

**As a** workflow author,
**I want** the engine to detect and reject circular `extends` chains,
**So that** I get a clear error message instead of an infinite loop.

**Acceptance Criteria**:
- [ ] `A extends B extends A` is detected and produces an error naming the cycle
- [ ] The extends chain depth is capped at 10 levels to prevent deep nesting abuse
- [ ] Self-reference (`A extends A`) is detected and rejected
- [ ] Error messages include the full chain (e.g., `Circular extends detected: A -> B -> A`)

### US5: Hardcoded Fallback Removal

**As a** platform engineer,
**I want** to remove the hardcoded `/workspaces/tetrad-development` fallback from `resolveWorkflowPath()`,
**So that** workflow resolution is clean, portable, and not dependent on a specific development environment layout.

**Acceptance Criteria**:
- [ ] The `/workspaces/tetrad-development` search directory is removed from `resolveWorkflowPath()`
- [ ] All existing repos that relied on this fallback now get their workflows via plugin registration
- [ ] No workflow resolution regressions occur (verified by integration tests)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `WorkflowRegistry` class to `workflow-engine` package with `register(name, filePath)` and `resolve(name): string \| undefined` methods | P1 | Singleton or injected into executor |
| FR-002 | Export `registerWorkflows(registry: WorkflowRegistry, workflows: Map<string, string>)` helper for plugins | P1 | Convenience wrapper for batch registration |
| FR-003 | Update `resolveWorkflowPath()` to search plugin registry after `.generacy/` directory and before returning fallback | P1 | Resolution order: absolute -> relative -> .generacy/ -> plugin registry -> raw string |
| FR-004 | Add `extends` field support to `WorkflowDefinitionSchema` (Zod) as optional string | P1 | Must be a workflow name, not a file path |
| FR-005 | Implement `mergeWorkflows(base: WorkflowDefinition, override: WorkflowOverride): WorkflowDefinition` function | P1 | Core merge logic |
| FR-006 | Support `overrides.phases` block: override existing phases by name, replace steps entirely | P1 | Phase name matching is case-sensitive |
| FR-007 | Support `before:` and `after:` positional directives on new phases in `overrides.phases` | P2 | Insert new phases relative to existing ones |
| FR-008 | Merge `inputs` arrays: base + override, override wins on `name` collision | P1 | Merge by input `name` field |
| FR-009 | Override top-level scalar fields (`name`, `description`, `version`) when present in override file | P1 | Absent fields inherit from base |
| FR-010 | Merge top-level `env` maps with override keys winning on collision | P1 | Shallow merge only |
| FR-011 | Override top-level `timeout` and `retry` when present in override file (full replacement, not merge) | P2 | Consistent with step-level override behavior |
| FR-012 | Detect circular `extends` chains and reject with descriptive error | P1 | Track visited names during resolution |
| FR-013 | Cap `extends` chain depth at 10 levels | P2 | Configurable via constant |
| FR-014 | Resolve `extends` base workflow via normal resolution chain, excluding the file currently being resolved | P1 | Prevents self-resolution |
| FR-015 | Remove `/workspaces/tetrad-development` from `resolveWorkflowPath()` search directories | P3 | After plugin registration is confirmed working |
| FR-016 | Add `WorkflowRegistry` integration to `JobHandler` constructor, injecting the registry into `resolveWorkflowPath()` | P1 | Registry provided by orchestrator |
| FR-017 | Log resolved workflow source (repo-local, plugin, or fallback) at info level | P2 | Aids debugging resolution issues |
| FR-018 | Warn on plugin workflow name collisions during registration | P2 | First registration wins; log warning for duplicates |
| FR-019 | Support multi-level extends chains (A extends B extends C) by recursively resolving and merging | P2 | Merge is bottom-up: C is base, B overrides, A overrides result |

## Technical Design

### Part 1: Workflow Registry

```typescript
// packages/workflow-engine/src/registry/workflow-registry.ts

export class WorkflowRegistry {
  private workflows = new Map<string, string>(); // name -> file path

  register(name: string, filePath: string): void {
    if (this.workflows.has(name)) {
      logger.warn(`Workflow "${name}" already registered; keeping existing registration`);
      return;
    }
    this.workflows.set(name, filePath);
  }

  resolve(name: string): string | undefined {
    return this.workflows.get(name);
  }

  has(name: string): boolean {
    return this.workflows.has(name);
  }

  list(): string[] {
    return Array.from(this.workflows.keys());
  }
}
```

### Part 2: Updated Resolution Order

```typescript
// packages/generacy/src/orchestrator/job-handler.ts

private resolveWorkflowPath(workflow: string, jobWorkdir?: string): string {
  // 1. Absolute path
  if (isAbsolute(workflow) && existsSync(workflow)) {
    return workflow;
  }

  const workdir = jobWorkdir ?? this.workdir;

  // 2. Relative to job workdir (as-is)
  const direct = resolve(workdir, workflow);
  if (existsSync(direct)) return direct;

  // 3. .generacy/ in job workdir (repo-local override, highest priority)
  for (const ext of ['', '.yaml', '.yml']) {
    const candidate = resolve(workdir, '.generacy', `${workflow}${ext}`);
    if (existsSync(candidate)) return candidate;
  }

  // 4. Plugin-provided workflows (from registry)
  const pluginPath = this.workflowRegistry.resolve(workflow);
  if (pluginPath && existsSync(pluginPath)) return pluginPath;

  // 5. Return original string (will produce clear "file not found" error)
  return workflow;
}
```

### Part 3: Workflow Inheritance YAML Format

```yaml
# .generacy/speckit-feature.yaml (repo-local override)
extends: speckit-feature  # Resolves via plugin registry

# Override only what's different
overrides:
  phases:
    implementation:
      # Replaces the entire implementation phase steps
      steps:
        - name: implement
          uses: speckit.implement
          with:
            feature_dir: ${{ steps.create-feature.output.feature_dir }}
          timeout: 7200000  # 2 hours instead of default

    # Insert a new phase after verification
    deploy:
      after: verification
      steps:
        - name: deploy-staging
          uses: shell
          command: npm run deploy:staging
          timeout: 300000

# Override top-level fields
description: "Custom feature workflow with deploy step"
env:
  DEPLOY_TARGET: staging
```

### Part 4: Merge Function

```typescript
// packages/workflow-engine/src/loader/merge.ts

export function mergeWorkflows(
  base: WorkflowDefinition,
  override: WorkflowOverride
): WorkflowDefinition {
  const result = { ...base };

  // Top-level scalars: override wins if present
  if (override.name) result.name = override.name;
  if (override.description) result.description = override.description;
  if (override.version) result.version = override.version;
  if (override.timeout !== undefined) result.timeout = override.timeout;
  if (override.retry) result.retry = override.retry;

  // Env: shallow merge, override wins
  if (override.env) {
    result.env = { ...result.env, ...override.env };
  }

  // Inputs: merge by name, override wins on collision
  if (override.inputs) {
    result.inputs = mergeInputs(base.inputs ?? [], override.inputs);
  }

  // Phases: apply overrides
  if (override.overrides?.phases) {
    result.phases = mergePhases(base.phases, override.overrides.phases);
  }

  return result;
}
```

### Part 5: Extends Resolution with Cycle Detection

```typescript
// packages/workflow-engine/src/loader/index.ts

const MAX_EXTENDS_DEPTH = 10;

export async function loadWorkflowWithExtends(
  filePath: string,
  resolver: (name: string) => string,
  visited: string[] = []
): Promise<WorkflowDefinition> {
  if (visited.includes(filePath)) {
    throw new Error(
      `Circular extends detected: ${[...visited, filePath].join(' -> ')}`
    );
  }
  if (visited.length >= MAX_EXTENDS_DEPTH) {
    throw new Error(
      `Extends chain too deep (max ${MAX_EXTENDS_DEPTH}): ${visited.join(' -> ')}`
    );
  }

  const content = await readFile(filePath, 'utf-8');
  const data = parseYaml(content);

  if (!data.extends) {
    return validateWorkflow(data);
  }

  // Resolve base workflow (excluding current file)
  const basePath = resolver(data.extends);
  const base = await loadWorkflowWithExtends(
    basePath, resolver, [...visited, filePath]
  );

  return mergeWorkflows(base, data as WorkflowOverride);
}
```

### New Types

```typescript
// packages/workflow-engine/src/types/workflow.ts

interface WorkflowOverride {
  extends: string;
  name?: string;
  description?: string;
  version?: string;
  timeout?: number;
  retry?: RetryConfig;
  env?: Record<string, string>;
  inputs?: InputDefinition[];
  overrides?: {
    phases: Record<string, PhaseOverride>;
  };
}

interface PhaseOverride {
  steps: StepDefinition[];       // Replaces all steps in this phase
  condition?: string;            // Override phase condition
  before?: string;               // Insert new phase before this phase (new phases only)
  after?: string;                // Insert new phase after this phase (new phases only)
}
```

## Data Model Changes

### WorkflowDefinitionSchema (Zod) Updates

Add optional `extends` and `overrides` fields. When `extends` is present, `phases` becomes optional (inherited from base). A refinement ensures that at least one of `phases` or `extends` is provided.

```typescript
// packages/workflow-engine/src/loader/schema.ts

const PhaseOverrideSchema = z.object({
  steps: z.array(StepDefinitionSchema),
  condition: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
});

const WorkflowDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  extends: z.string().optional(),
  overrides: z.object({
    phases: z.record(PhaseOverrideSchema),
  }).optional(),
  inputs: z.array(InputDefinitionSchema).optional(),
  phases: z.array(PhaseDefinitionSchema).optional(),
  env: z.record(z.string()).optional(),
  timeout: z.number().optional(),
  retry: RetryConfigSchema.optional(),
}).refine(
  (data) => data.phases || data.extends,
  { message: 'Workflow must have phases or extend another workflow' }
);
```

## File Changes

| File | Change | Description |
|------|--------|-------------|
| `packages/workflow-engine/src/registry/workflow-registry.ts` | **New** | `WorkflowRegistry` class for plugin workflow registration |
| `packages/workflow-engine/src/registry/index.ts` | **New** | Public exports for registry |
| `packages/workflow-engine/src/loader/merge.ts` | **New** | `mergeWorkflows()`, `mergePhases()`, `mergeInputs()` functions |
| `packages/workflow-engine/src/loader/index.ts` | **Modify** | Add `loadWorkflowWithExtends()` with cycle detection |
| `packages/workflow-engine/src/loader/schema.ts` | **Modify** | Add `extends`, `overrides` fields to schema |
| `packages/workflow-engine/src/types/workflow.ts` | **Modify** | Add `WorkflowOverride`, `PhaseOverride` types |
| `packages/workflow-engine/src/index.ts` | **Modify** | Export `WorkflowRegistry` and merge utilities |
| `packages/generacy/src/orchestrator/job-handler.ts` | **Modify** | Update `resolveWorkflowPath()` to use registry; accept `WorkflowRegistry` injection |
| `packages/generacy/src/orchestrator/index.ts` | **Modify** | Create and pass `WorkflowRegistry` to `JobHandler` |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Workflow file duplication across repos | 0 duplicated files (repos use plugin-provided or extends) | Audit `.generacy/` directories across managed repos |
| SC-002 | Plugin workflow resolution latency | < 1ms overhead vs. current resolution | Benchmark `resolveWorkflowPath()` with registry lookup |
| SC-003 | Merge correctness | 100% of merge scenarios pass unit tests | Automated test suite covering all merge semantics |
| SC-004 | Circular detection reliability | All circular chains rejected with descriptive error | Unit tests for self-reference, 2-cycle, 3-cycle, and depth-limit scenarios |
| SC-005 | Backwards compatibility | All existing workflows resolve identically (until fallback removal) | Run full e2e workflow suite before and after changes |
| SC-006 | Override correctness | Repo-local `.generacy/` always wins over plugin-provided | Integration test: place override in .generacy/, verify it is used |

## Testing Strategy

### Unit Tests (packages/workflow-engine)

| Test Area | Cases |
|-----------|-------|
| `WorkflowRegistry` | register, resolve, has, list, duplicate name warning, resolve unknown returns undefined |
| `mergeWorkflows()` | Scalar override, env merge, input merge by name, input collision override wins |
| `mergePhases()` | Override existing phase by name, insert new phase with `after:`, insert with `before:`, unrecognized phase name error, empty overrides preserves base |
| `mergeInputs()` | No overlap merge, name collision override wins, override adds new input, base-only preserved |
| `loadWorkflowWithExtends()` | No extends (pass-through), single-level extends, multi-level extends chain, circular self-reference error, circular 2-cycle error, depth limit exceeded error |
| Schema validation | `extends` without `phases` valid, neither `extends` nor `phases` rejected, `overrides` without `extends` rejected |

### Integration Tests (packages/generacy)

| Test Area | Cases |
|-----------|-------|
| `resolveWorkflowPath()` | Absolute path, relative path, .generacy/ path, plugin registry path, unknown workflow fallback |
| Priority ordering | .generacy/ wins over plugin, plugin wins over raw string |
| Full workflow load | Load workflow with extends from plugin, verify merged output matches expected |
| JobHandler integration | Execute a workflow resolved from plugin registry end-to-end |

## Assumptions

- Plugins are initialized and call `registerWorkflows()` before any workflow resolution occurs (orchestrator boot order guarantees this)
- The existing facet-based plugin system (`@generacy-ai/latency`) provides a hook for plugins to register workflows during their `initialize()` lifecycle method
- Workflow names are globally unique across all plugins (collision produces a warning, first registration wins)
- The `extends` field is always a workflow name (not a file path); it resolves via the same resolution chain
- All existing repos can transition from the hardcoded fallback to plugin-provided workflows before FR-015 is implemented
- YAML parsing continues to use the existing `yaml` library; no new parser dependencies needed
- The `overrides.phases` block uses phase names as keys, which must match base workflow phase names exactly (case-sensitive)

## Out of Scope

- **Step-level merging within a phase**: Overriding a phase replaces all its steps; merging individual steps within a phase is not supported in this iteration
- **Remote workflow resolution**: Fetching workflows from URLs, registries, or artifact stores is not included
- **Workflow versioning/pinning**: No mechanism for `extends: speckit-feature@1.2.0`; the resolved version is whatever the plugin provides
- **Dynamic workflow generation**: Workflows are static YAML; no templating engine or conditional includes beyond the existing `condition` field
- **Plugin auto-discovery via filesystem scanning**: Option B (scanning `node_modules/`) is explicitly deferred in favor of explicit registration (Option A)
- **Config-based workflow sources**: Option C (`generacy.config.yaml` listing workflow sources) is deferred
- **Migration tooling**: No automated tool to convert existing duplicated workflow files into `extends`-based overrides
- **Workflow marketplace or sharing**: No UI or catalog for discovering available workflows
- **Phase reordering**: The `extends` mechanism supports inserting new phases and overriding existing ones, but does not support reordering existing phases from the base workflow

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Plugin init order causes workflows to be unregistered when needed | Medium | High | Enforce plugin init completes before job processing starts; add startup health check |
| Merge semantics are surprising to users (e.g., step-level replace vs. merge) | Medium | Medium | Document clearly; provide examples; add `--dry-run` merge preview |
| Removing hardcoded fallback breaks repos not yet migrated to plugins | Low | High | Part 3 is gated on Part 1 completion; fallback removal is a separate, explicit step |
| Deep extends chains make workflows hard to debug | Low | Medium | Cap at 10 levels; log full resolution chain at debug level |
| Plugin workflow name collisions across plugins | Low | Medium | Warn on collision; document namespace convention (e.g., `speckit-feature`, `myplug-deploy`) |

## Related

- Companion issue: generacy-ai/agency#244 (bundle workflows in spec-kit plugin)
- Current code: `packages/generacy/src/orchestrator/job-handler.ts:438-463` (`resolveWorkflowPath`)
- Workflow loader: `packages/workflow-engine/src/loader/index.ts`
- Workflow schema: `packages/workflow-engine/src/loader/schema.ts`
- Action registry pattern (analogous): `packages/workflow-engine/src/actions/index.ts`

---

*Generated by speckit*
