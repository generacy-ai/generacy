# Research: Technical Decisions for Workflow Engine Enhancements

## 1. Global Singleton vs. Injected Registry

**Decision**: Global singleton (matches `actionRegistry` pattern)

**Evidence from codebase**:
- `actionRegistry` and `namespaceRegistry` in `packages/workflow-engine/src/actions/index.ts:12-17` are module-level `Map` globals
- `clearActionRegistry()` exists for test cleanup (line 198)
- `WorkflowExecutor` constructor calls `ensureActionsRegistered()` which lazily calls `registerBuiltinActions()` (executor `index.ts:33-40`)
- No injection of the action registry through constructor options — it's always the global

**Why not injected**: Would require adding `WorkflowRegistry` to `ExecutorOptions`, threading through `JobHandler` → `WorkflowExecutor` → `loadWorkflowWithExtends()`. The action registry doesn't do this and it works well. Test isolation via `clearWorkflowRegistry()` is sufficient.

## 2. Two-Pass Validation for Extends

**Decision**: Loose parse → resolve/merge → validate merged result

**Evidence from codebase**:
- `loadWorkflow()` in `loader/index.ts:17-39` calls `validateWorkflow(data)` immediately after YAML parse
- `validateWorkflow()` in `validator.ts:31-97` runs `WorkflowDefinitionSchema.parse(data)` which requires `phases: z.array(PhaseDefinitionSchema).min(1)` (`schema.ts:63`)
- An override file with `extends` + `overrides` but no `phases` would fail this validation
- The strict schema must remain unchanged to avoid masking errors in non-extends workflows

**Implementation approach**: `loadWorkflowWithExtends()` parses YAML without calling `validateWorkflow()`, checks for `extends`, resolves and merges if present, then calls `validateWorkflow()` on the final merged result. This means the `WorkflowDefinitionSchema` is never loosened.

## 3. Self-Exclusion in Extends Resolution

**Decision**: Skip exact file path (not the entire `.generacy/` tier)

**Why exact path**: Consider this scenario:
```
.generacy/
  speckit-feature.yaml        # extends: speckit-feature-base
  speckit-feature-base.yaml   # standalone base workflow
```

If we skipped the entire `.generacy/` tier (option B), `speckit-feature.yaml` couldn't extend `speckit-feature-base.yaml` even though it's a different file in the same directory. By only skipping the exact file path, we preserve this valid use case while preventing self-referential loops.

**Implementation**: `resolveWorkflowPath()` gains an optional `excludePath` parameter. Each candidate path is compared against `excludePath` via `resolve()` to normalize.

## 4. Merge Semantics Deep Dive

### Phase Override (by name match)
```yaml
# Base has: setup → spec → clarification → planning → impl → verify
# Override:
overrides:
  phases:
    implementation:
      steps:
        - name: implement
          uses: speckit.implement
          timeout: 7200000  # replaces ALL steps in the implementation phase
```

Result: All other phases (setup, spec, clarification, planning, verify) are preserved exactly as in base. Only `implementation` has its steps replaced.

### Phase Insertion
```yaml
overrides:
  phases:
    deploy:
      after: verification   # position relative to a base phase
      steps:
        - name: deploy-staging
          uses: shell
          command: npm run deploy:staging
```

Result: `deploy` phase is inserted after `verification` in the phase list.

### Input Merging
```yaml
# Base inputs: description (required), issue_url, issue_number, short_name
# Override:
overrides:
  inputs:
    - name: deploy_target   # new input added
      type: string
      default: staging
    - name: description     # overrides base input (matched by name)
      type: string
      required: false       # was required in base, now optional
```

Result: `[description(optional), issue_url, issue_number, short_name, deploy_target]` — base inputs with `description` replaced by override version, `deploy_target` appended.

### Env Merging
```yaml
# Base env: { NODE_ENV: "test", LOG_LEVEL: "info" }
# Override:
overrides:
  env:
    LOG_LEVEL: "debug"      # overrides base
    CUSTOM_FLAG: "true"     # new key
```

Result: `{ NODE_ENV: "test", LOG_LEVEL: "debug", CUSTOM_FLAG: "true" }`

## 5. Existing Pattern Analysis: `registerActionHandler()`

The action registry provides a clean template for `WorkflowRegistry`:

| Action Registry | Workflow Registry (planned) |
|----------------|---------------------------|
| `registerActionHandler(handler)` | `registerWorkflow(name, path)` |
| `actionRegistry.set(handler.type, handler)` | `workflowRegistry.set(name, path)` |
| `getActionHandler(step)` | `resolveRegisteredWorkflow(name)` |
| `hasActionHandler(type)` | `hasRegisteredWorkflow(name)` |
| `getRegisteredActionTypes()` | `getRegisteredWorkflowNames()` |
| `clearActionRegistry()` | `clearWorkflowRegistry()` |
| Warns on overwrite (line 24-26) | Warns on overwrite |
| `registerBuiltinActions()` | `registerBuiltinWorkflows()` (in orchestrator) |

Key difference: The workflow registry stores file paths (not handler instances), and validates path existence at registration time.

## 6. Compatibility with Inline YAML Workflows

The `executeJob()` method in `job-handler.ts:240-243` handles three cases:
1. Inline YAML string (`job.workflow.includes('\n')`) → `loadWorkflowFromString()`
2. File path/name string → `resolveWorkflowPath()` + `loadWorkflow()`
3. Already a `WorkflowDefinition` object → used directly

The `extends` mechanism only applies to case 2 (file-based workflows). Inline YAML workflows cannot use `extends` because there's no file path context for resolution. This is by design — inline YAML is for programmatic use where the full workflow is already known.

If needed in the future, `loadWorkflowFromString()` could accept an optional resolver parameter, but this is out of scope.

## 7. Error Message Quality

Each error class provides actionable context:

**BaseWorkflowNotFoundError**:
```
Base workflow 'speckit-featur' not found.
Searched:
  - /repo/.generacy/speckit-featur.yaml
  - /repo/.generacy/speckit-featur.yml
  - plugin registry (3 registered: speckit-feature, speckit-bugfix, speckit-epic)
```

**CircularExtendsError**:
```
Circular extends detected: /repo/.generacy/a.yaml → /repo/.generacy/b.yaml → /repo/.generacy/a.yaml
```

**WorkflowOverrideError** (Q4 — unrecognized phase):
```
Phase 'reveiw' not found in base workflow 'speckit-feature'.
Base phases: setup, specification, clarification, planning, task-generation, implementation, verification.
To add a new phase, use a `before:` or `after:` directive.
```

**WorkflowOverrideError** (Q6 — overrides without extends):
```
Cannot use 'overrides' without 'extends'. The 'overrides' block requires a base workflow to override.
```

**WorkflowOverrideError** (Q12 — both phases and overrides.phases):
```
Cannot specify both 'phases' and 'overrides.phases' when using 'extends'.
Use 'phases' to replace all base phases, or 'overrides.phases' to selectively modify them.
```
