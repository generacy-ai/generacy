# Feature Specification: ## Problem

The workflow engine has two limitations that force every repo to maintain full copies of workflow files:

1

**Branch**: `211-problem-workflow-engine-two` | **Date**: 2026-02-21 | **Status**: Draft

## Summary

## Problem

The workflow engine has two limitations that force every repo to maintain full copies of workflow files:

1. **No plugin-provided workflow discovery** — `resolveWorkflowPath()` in `job-handler.ts:431-456` only searches the repo's `.generacy/` directory and a hardcoded tetrad-development fallback. It cannot discover workflows bundled inside installed plugin packages (e.g., `agency-plugin-spec-kit`).

2. **No inheritance/extends mechanism** — Repos that need small customizations (e.g., different timeouts, an extra step) must fork the entire workflow file. There's no way to say "use the base workflow but override phase X."

## Proposed Solution

### Part 1: Plugin-provided workflow resolution

Update `resolveWorkflowPath()` to include a plugin search tier. Resolution order becomes:

```
1. Absolute path (if exists)
2. Relative to job workdir
3. .generacy/ in job workdir (repo-local override — highest priority)
4. Plugin-provided workflows (new — fallback from installed packages)
5. /workspaces/tetrad-development (existing fallback — remove eventually)
```

**Implementation approach:**

- Plugins that provide workflows export a `BUILTIN_WORKFLOWS` map (see companion issue in agency repo: generacy-ai/agency#244)
- The orchestrator/workflow engine discovers these via a plugin registry or convention
- Options for discovery:
  - **A) Plugin registration**: Plugins call `registerWorkflows(map)` during init
  - **B) Convention-based**: Engine scans `node_modules/*/workflows/*.yaml` matching a pattern
  - **C) Config-based**: `generacy.config.yaml` lists workflow sources

Recommendation: **Option A** (explicit registration) — cleanest, no filesystem scanning, works with all package managers.

### Part 2: Workflow inheritance/extends

Allow workflow YAML files to extend a base workflow and override specific parts:

```yaml
# .generacy/speckit-feature.yaml (repo-local override)
extends: speckit-feature  # resolves via the normal resolution chain

# Override only what's different
overrides:
  phases:
    implementation:
      steps:
        - name: implement
          timeout: 7200000  # 2 hours instead of 1 for this repo
    
    # Add a repo-specific phase
    deploy:
      after: verification
      steps:
        - name: deploy-staging
          uses: shell
          command: npm run deploy:staging
```

**Merge semantics:**
- Phases from base are preserved unless overridden by name
- Steps within an overridden phase are replaced entirely (not merged)
- New phases can be inserted with `after:` or `before:` positioning
- Inputs are merged (base + override)
- Top-level fields (`version`, `description`) from override win

### Part 3: Remove hardcoded fallback

Once plugin-provided workflows are working, remove the hardcoded `/workspaces/tetrad-development` fallback from `resolveWorkflowPath()`.

## Current Code Reference

```typescript
// packages/generacy/src/orchestrator/job-handler.ts:431-456
private resolveWorkflowPath(workflow: string, jobWorkdir?: string): string {
  if (isAbsolute(workflow) && existsSync(workflow)) {
    return workflow;
  }
  const searchDirs = [
    jobWorkdir ?? this.workdir,
    '/workspaces/tetrad-development',  // ← hardcoded fallback to remove
  ];
  for (const dir of searchDirs) {
    const direct = resolve(dir, workflow);
    if (existsSync(direct)) return direct;
    for (const ext of ['', '.yaml', '.yml']) {
      const candidate = resolve(dir, '.generacy', `${workflow}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return workflow;
}
```

## Acceptance Criteria

### Part 1 — Plugin workflow discovery
- [ ] Plugins can register workflow files with the engine
- [ ] `resolveWorkflowPath()` searches plugin-provided workflows as fallback
- [ ] Repo-local `.generacy/` files take priority over plugin-provided ones
- [ ] Repos without `.generacy/` workflow files can run plugin-provided workflows

### Part 2 — Workflow inheritance
- [ ] `extends:` field supported in workflow YAML
- [ ] Base workflow resolved via normal resolution chain
- [ ] Phase-level overrides work (replace steps, adjust timeouts)
- [ ] New phases can be inserted with positional directives
- [ ] Inputs are merged from base + override
- [ ] Circular extends detected and rejected
- [ ] Unit tests for merge semantics

### Part 3 — Cleanup
- [ ] Remove hardcoded `/workspaces/tetrad-development` fallback
- [ ] Document the new resolution order

## Related

- Companion issue: generacy-ai/agency#244 (bundle workflows in spec kit plugin)

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
