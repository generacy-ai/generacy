# Clarification Questions

## Status: Resolved

## Questions

### Q1: Plugin Registration Hook
**Context**: The spec assumes plugins call `registerWorkflows()` during initialization, but the existing latency plugin system uses abstract base classes (`AbstractCICDPlugin`, `AbstractIssueTrackerPlugin`, `AbstractDevAgentPlugin`) that have no `registerWorkflows()` hook. The `agency-plugin-spec-kit` package does not yet exist — speckit is currently a built-in action in `packages/workflow-engine/src/actions/builtin/speckit/`. The spec needs to define how and where plugins actually gain access to the `WorkflowRegistry` to register workflows.
**Question**: How should the `WorkflowRegistry` be exposed to plugins for registration? Should a new abstract base class method be added (e.g., `registerWorkflows(registry)` on `AbstractPlugin`), should it be a new facet in the latency dependency injection system, or should the orchestrator call into plugins explicitly during startup?
**Options**:
- A) New lifecycle method on plugin base classes: Add a `registerWorkflows(registry: WorkflowRegistry)` method to the abstract plugin base that the orchestrator calls during plugin initialization
- B) Facet-based injection: Register `WorkflowRegistry` as a latency facet so plugins can declare it as a dependency and receive it automatically
- C) Orchestrator-side explicit wiring: The orchestrator knows which plugins provide workflows and explicitly registers them during startup (no plugin API change needed)
- D) Standalone registration API: Plugins import and call a global `registerWorkflows()` function during their `initialize()` method, similar to how action handlers use the global `registerActionHandler()`
**Answer**: **D) Standalone Registration API** — Most consistent with the existing pattern. `registerActionHandler()` is already a global function that any code calls — a `registerWorkflows()` / `getWorkflowRegistry().register()` function follows the same convention. Plugins currently have no lifecycle hooks — they're plain classes with constructors. Adding a `registerWorkflows()` method to abstract base classes (A) would require adding lifecycle management that doesn't exist today. The latency facet system (B) isn't even wired into generacy's plugin instantiation yet. C works but couples the orchestrator to plugin internals. With D, the orchestrator (or any code — see Q10) calls `getWorkflowRegistry().register()` during startup, exactly like `registerBuiltinActions()` is called lazily on first `WorkflowExecutor` construction.

### Q2: WorkflowRegistry Lifecycle — Singleton vs. Injected
**Context**: The spec mentions "Singleton or injected into executor" (FR-001) but does not decide. The existing action registry uses global singletons (`actionRegistry`, `namespaceRegistry` in `actions/index.ts`). However, `JobHandler` creates a new `WorkflowExecutor` per job. If the registry is a singleton, it's simpler but harder to test; if injected, it requires threading it through `JobHandler` → `WorkflowExecutor` → `loadWorkflowWithExtends()`.
**Question**: Should `WorkflowRegistry` be a global singleton (like the action registry) or an instance injected into `JobHandler`?
**Options**:
- A) Global singleton: Consistent with existing action registry pattern; simpler wiring, plugins call `getWorkflowRegistry().register()` directly
- B) Injected instance: Passed into `JobHandler` constructor via `JobHandlerOptions`; more testable, allows different registries per context
**Answer**: **A) Global Singleton** — The action registry already uses module-level `Map` globals and this works well. The pattern is established: `actionRegistry` + `namespaceRegistry` are global singletons with `clearActionRegistry()` for test cleanup. `WorkflowRegistry` should follow suit with a `clearWorkflowRegistry()` for tests. Injecting through `JobHandler` → `WorkflowExecutor` adds plumbing complexity for little benefit.

### Q3: Schema Validation Timing for `extends` Workflows
**Context**: The spec defines a `WorkflowOverride` type and says the schema should accept `extends` without `phases`. But the current validation flow in `loadWorkflow()` calls `validateWorkflow(data)` immediately after parsing YAML, before any merge occurs. An override file (with `extends` and `overrides` but no `phases`) would fail the existing `PhaseDefinitionSchema.min(1)` validation. The spec shows a `.refine()` check but doesn't clarify whether override files should use a separate schema or a modified version of the main schema.
**Question**: Should override files be validated against a separate `WorkflowOverrideSchema` or should the existing `WorkflowDefinitionSchema` be modified to make `phases` optional when `extends` is present?
**Options**:
- A) Single modified schema: Make `phases` optional in `WorkflowDefinitionSchema` and add a refinement requiring either `phases` or `extends`; the same schema handles both cases
- B) Separate schemas: Create a `WorkflowOverrideSchema` for files with `extends` and keep `WorkflowDefinitionSchema` unchanged; the loader detects which to use based on the presence of `extends`
- C) Two-pass validation: First parse loosely (no validation), check for `extends`, resolve and merge, then validate the final merged result against the existing strict schema
**Answer**: **C) Two-Pass Validation** — The current `loadWorkflow()` calls `validateWorkflow(data)` immediately, which would reject override files missing `phases`. Two-pass is cleanest: (1) First pass: loose parse (just valid YAML + basic structure), (2) Detect `extends`, resolve the base, merge, (3) Second pass: validate the merged result against the existing strict `WorkflowDefinitionSchema`. This means the strict schema stays unchanged — the final output always has `phases`. No separate schema to maintain (B), and no need to loosen the main schema (A) which could mask real errors in non-extends workflows.

### Q4: Error Handling for Invalid Phase References in `overrides.phases`
**Context**: The spec says phases are overridden by name match (case-sensitive) and new phases use `before:`/`after:` directives. But it doesn't specify what happens when an `overrides.phases` entry references a phase name that doesn't exist in the base workflow and has no `before:`/`after:` directive. Is it an error, silently ignored, or appended?
**Question**: What should happen when an `overrides.phases` entry references a phase name that doesn't exist in the base workflow and has no positional directive (`before:`/`after:`)?
**Options**:
- A) Error: Throw a validation error indicating the phase name doesn't exist in the base workflow and a positional directive is required for new phases
- B) Append to end: Treat it as a new phase and append it after the last base phase
- C) Ignore with warning: Skip the unrecognized phase and log a warning
**Answer**: **A) Error** — Fail fast. If an `overrides.phases` entry references a name that doesn't exist in the base and has no `before:`/`after:` directive, it's almost certainly a typo or misconfiguration. A clear error message like "Phase 'reveiw' not found in base workflow 'speckit-feature'. Did you mean 'review'? To add a new phase, use `before:` or `after:` directive." is far more helpful than silently appending or ignoring.

### Q5: Behavior When `extends` Target Cannot Be Resolved
**Context**: The spec describes the resolution chain for `extends` (repo-local `.generacy/` → plugin registry) but doesn't specify error behavior when the target workflow name cannot be resolved at all. The current `resolveWorkflowPath()` returns the raw string as a fallback, which would then fail with a "file not found" error. The `extends` case should arguably produce a more specific error.
**Question**: When `extends: some-workflow` cannot be resolved to any file (not in `.generacy/`, not in plugin registry), should the error message be a generic file-not-found or a specific "base workflow not found" error?
**Options**:
- A) Specific error: Throw `BaseWorkflowNotFoundError` with the workflow name and the list of locations searched
- B) Generic error: Let the existing file-not-found error propagate (consistent with current behavior)
**Answer**: **A) Specific Error** — A `BaseWorkflowNotFoundError` with the workflow name and list of searched locations is significantly better for debugging. The current fallback (returning the raw string which then fails with "file not found") gives no indication that the user was trying to extend a base workflow or where the system looked. Example: "Base workflow 'speckit-feature' not found. Searched: .generacy/speckit-feature.yaml, .generacy/speckit-feature.yml, plugin registry (0 registered workflows)."

### Q6: `overrides` Block Without `extends`
**Context**: The spec schema shows `overrides` as optional alongside `extends`, but doesn't explicitly state whether `overrides` is valid without `extends`. A workflow file with `overrides` but no `extends` field has no base to apply overrides to. The spec's refinement only checks that either `phases` or `extends` is present, leaving `overrides`-without-`extends` unaddressed.
**Question**: Should a workflow file that has an `overrides` block but no `extends` field be rejected with a validation error?
**Options**:
- A) Reject: Add a schema refinement that requires `extends` when `overrides` is present
- B) Ignore: Allow `overrides` without `extends` but silently ignore it (the field is simply unused)
**Answer**: **A) Reject** — A workflow file with `overrides` but no `extends` has no base to apply overrides to — this is always a mistake. A schema refinement that requires `extends` when `overrides` is present catches this early. Silent ignore (B) would let typos and misconfiguration go undetected.

### Q7: Plugin Workflow File Path Stability
**Context**: The spec has plugins register workflows as `Map<string, string>` (name → file path), where the file path points into the plugin's package directory (e.g., somewhere in `node_modules/`). If the plugin is updated or `node_modules` is rebuilt, these paths could become stale. The spec doesn't address whether paths are validated at registration time or only at resolution time.
**Question**: Should workflow file paths be validated (checked for existence) at registration time or only when `resolve()` is called?
**Options**:
- A) Validate at registration: `register()` throws if the file doesn't exist, catching bad paths early during startup
- B) Validate at resolution: `register()` accepts any path; existence is checked in `resolveWorkflowPath()` when the workflow is actually needed (current design per the spec code)
- C) Validate at both: Check existence at registration (warn if missing) and again at resolution (error if missing)
**Answer**: **A) Validate at Registration** — Validate at registration time. If a plugin registers a path that doesn't exist, fail loudly during startup rather than at workflow execution time (which could be much later, in a CI context, etc.). The "stale after `node_modules` rebuild" concern is moot in practice — a `node_modules` rebuild means the process restarts, and plugins re-register with fresh paths.

### Q8: Multi-Level Extends Merge Order Ambiguity
**Context**: FR-019 says multi-level chains merge bottom-up (C is base, B overrides, A overrides result). The code in Part 5 implements this recursively. However, for the `env` merge specifically, the spec says "shallow merge, override wins." In a 3-level chain (A extends B extends C), should A's env be merged with the already-merged result of B+C, or should all three env maps be merged simultaneously? The recursive approach means B+C merge first, then A merges with the result — so a key in C that B doesn't override would survive to the A merge. This is probably the intended behavior but should be confirmed.
**Question**: For multi-level extends (A extends B extends C), is the merge order confirmed as: first merge C+B to produce intermediate, then merge intermediate+A to produce final? Specifically for `env`, does a key set in C but not overridden in B survive to be visible in A's merge?
**Options**:
- A) Recursive bottom-up (confirmed): C+B → intermediate, intermediate+A → final; C's env keys survive unless explicitly overridden at any level
- B) Flat override: Only the most-derived file's (A) fields and the direct base's (B) fields matter; C's values are only inherited by B, not visible to A's merge logic
**Answer**: **A) Recursive Bottom-Up (Confirmed)** — Standard inheritance model: C is the base, B extends C (producing B+C), A extends B (producing A+(B+C)). A key in C's `env` that B doesn't override survives into A's merge. The recursive implementation naturally produces this, and it matches how inheritance works in every other system (CSS, class inheritance, etc.).

### Q9: Excluding the Extending File from Resolution
**Context**: FR-014 says "Resolve `extends` base workflow via normal resolution chain, excluding the file currently being resolved." But the resolution chain works on workflow *names*, not file paths. If `.generacy/speckit-feature.yaml` has `extends: speckit-feature`, the resolver needs to skip the repo-local file and find the plugin-provided one. The spec code shows this as `resolver(data.extends)` but doesn't show how the resolver knows which file to exclude. This is a critical implementation detail.
**Question**: How should the resolver exclude the current file when resolving `extends`? Should it skip the entire `.generacy/` tier, skip only the exact file path, or use a different mechanism?
**Options**:
- A) Skip exact file path: Pass the current file's absolute path to the resolver, which skips that specific path during candidate evaluation
- B) Skip the `.generacy/` tier entirely: When resolving an `extends` target, skip the repo-local `.generacy/` search and go straight to plugin registry
- C) Use a flag/context: Pass an `excludeSelf: true` flag to `resolveWorkflowPath()` that causes it to skip the first match if it equals the current file
**Answer**: **A) Skip Exact File Path** — Pass the current file's absolute path to the resolver and skip that specific path. This is the most precise approach — it only excludes the file being resolved, not the entire `.generacy/` tier (B would break cases where one repo-local workflow extends a different repo-local workflow). C is essentially A with a different API — the flag still needs the file path to know what to exclude.

### Q10: Companion Issue Dependency and Ordering
**Context**: The spec references "Companion issue: generacy-ai/agency#244 (bundle workflows in spec-kit plugin)" and assumes the `agency-plugin-spec-kit` plugin will exist and bundle workflows. But spec-kit is currently a built-in action (`packages/workflow-engine/src/actions/builtin/speckit/`). The spec doesn't clarify whether this feature depends on extracting spec-kit into a separate plugin first, or whether the `WorkflowRegistry` can also be used by built-in code (not just plugins).
**Question**: Does this feature depend on extracting spec-kit into a separate plugin package, or should the initial implementation support registering workflows from built-in code (e.g., the orchestrator itself registers the default workflows from a known location)?
**Options**:
- A) Plugin extraction first: This feature depends on agency#244 completing first; built-in registration is not needed
- B) Built-in registration supported: The `WorkflowRegistry` should support any caller registering workflows, including the orchestrator or built-in code, so this feature can ship independently of the plugin extraction
- C) Phased: Ship the registry and extends mechanism first with built-in registration, then migrate to plugin-based registration when agency#244 is complete
**Answer**: **C) Phased** — Ship the registry and extends mechanism first with built-in registration (the orchestrator registers default workflows from a known location). Then migrate to plugin-based registration when agency#244 extracts speckit into a separate plugin. This decouples the two features and allows immediate progress. The `WorkflowRegistry` API stays the same regardless of who calls `register()` — the orchestrator today, plugins tomorrow.

### Q11: Handling `name` Field in Override Files
**Context**: The spec says "Top-level scalar fields (`name`, `description`, `version`) from the override file win over base." For `name` specifically, the workflow name is used as an identifier throughout the system (in logs, events, job tracking). If an override changes the `name`, the workflow would have a different identity than its base. This could cause confusion when debugging or when the orchestrator tracks workflow execution by name.
**Question**: Should the `name` field in an override file replace the base workflow's name, or should `name` be excluded from overridable scalars to preserve workflow identity?
**Options**:
- A) Allow name override: Override can change the name; the merged workflow has the override's name (useful for distinguishing customized variants)
- B) Preserve base name: The `name` field is never overridden; the merged workflow always keeps the base workflow's name
- C) Require name in override: The override must specify a name (different from base) so it's clear this is a distinct workflow variant
**Answer**: **A) Allow Name Override** — Standard scalar override behavior: if the override specifies a `name`, use it; if not, inherit from base. An override file that changes the name is creating a distinct variant — e.g., `speckit-feature` (base) → `speckit-feature-custom` (override). This is useful for distinguishing customized workflows in logs and job tracking. C (require name) adds unnecessary friction for simple overrides that just want to tweak an env var or phase.

### Q12: Interaction Between `phases` and `overrides.phases` in the Same File
**Context**: The spec shows override files using `extends` + `overrides.phases`. But it doesn't address whether a file can have both `phases` (full phase list) AND `overrides.phases` at the same time alongside `extends`. If both are present, which takes precedence? Are the `phases` used as a complete replacement (ignoring `overrides`), or is this an error?
**Question**: If an override file specifies both `phases` (a full phase list) and `overrides.phases`, what should happen?
**Options**:
- A) Error: Reject the file; `phases` and `overrides.phases` are mutually exclusive when `extends` is present
- B) `phases` wins: If `phases` is present, it completely replaces the base phases and `overrides.phases` is ignored
- C) `overrides.phases` wins: The base phases are used, `overrides.phases` is applied, and the top-level `phases` field is ignored
**Answer**: **A) Error** — These represent mutually exclusive intents: `phases` = "I'm providing a complete phase list" (full replacement), `overrides.phases` = "I'm modifying specific phases from the base." Having both is ambiguous and almost certainly a mistake. Reject with a clear message: "Cannot specify both `phases` and `overrides.phases` when using `extends`. Use `phases` to replace all base phases, or `overrides.phases` to selectively modify them."
