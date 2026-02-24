# Implementation Plan: Onboarding PR Templates

**Feature**: Define onboarding PR template content
**Issue**: [#247](https://github.com/generacy-ai/generacy/issues/247)
**Status**: Ready for implementation
**Priority**: High (Phase 1 - Foundation)

---

## Summary

Create a template system for generating onboarding PRs that add Generacy configuration and dev container setup to user repositories. Templates support both single-repo and multi-repo projects using Handlebars for variable substitution and conditional logic.

The templates will be consumed by:
1. **generacy-cloud PR generation service** - Automated PR creation when projects are created via web UI
2. **generacy CLI `init` command** - Local scaffolding for developers who prefer CLI workflow

---

## Technical Context

### Language & Framework
- **TypeScript** (Node.js)
- **Handlebars 4.7.8** - Template rendering with conditionals and loops
- **js-yaml** - YAML parsing/stringification for config generation
- **Zod** - Runtime type validation for template context

### Dependencies
```json
{
  "dependencies": {
    "handlebars": "^4.7.8",
    "js-yaml": "^4.1.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9"
  }
}
```

### Repository Structure
```
generacy/
├── packages/
│   └── templates/              # NEW - This package
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts        # Public API
│       │   ├── schema.ts       # Zod schemas + TypeScript types
│       │   ├── renderer.ts     # Handlebars rendering logic
│       │   ├── validators.ts   # Pre/post render validation
│       │   ├── shared/         # Templates used by all projects
│       │   │   ├── config.yaml.hbs
│       │   │   ├── generacy.env.template.hbs
│       │   │   ├── extensions.json.hbs
│       │   │   └── .gitignore
│       │   ├── single-repo/    # Single-repo specific templates
│       │   │   └── devcontainer.json.hbs
│       │   └── multi-repo/     # Multi-repo specific templates
│       │       ├── devcontainer.json.hbs
│       │       └── docker-compose.yml.hbs
│       ├── tests/
│       │   ├── unit/
│       │   │   ├── renderer.test.ts
│       │   │   └── validators.test.ts
│       │   ├── integration/
│       │   │   └── render-project.test.ts
│       │   └── fixtures/
│       │       ├── single-repo-context.json
│       │       ├── multi-repo-context.json
│       │       └── snapshots/
│       └── README.md
```

---

## Architecture Overview

### Template Rendering Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Template Context                            │
│  (project, repos, defaults, orchestrator, devcontainer, metadata)   │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │  Validate Context    │
                  │  (Zod schema check)  │
                  └──────────┬───────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │  Select Templates    │
                  │  (single vs multi)   │
                  └──────────┬───────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
                ▼                         ▼
     ┌──────────────────┐      ┌──────────────────┐
     │  Shared Templates│      │ Type-Specific    │
     │  - config.yaml   │      │  - devcontainer  │
     │  - env.template  │      │  - docker-compose│
     │  - extensions    │      │    (multi only)  │
     └────────┬─────────┘      └─────────┬────────┘
              │                          │
              └────────────┬─────────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │  Render with         │
                │  Handlebars          │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │  Validate Output     │
                │  (YAML/JSON parse)   │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────────────┐
                │  Return File Map             │
                │  Map<targetPath, content>    │
                └──────────────────────────────┘
```

### Template Selection Logic

```typescript
function selectTemplates(context: TemplateContext): string[] {
  const templates = [
    'shared/config.yaml.hbs',
    'shared/generacy.env.template.hbs',
    'shared/.gitignore',
    'shared/extensions.json.hbs',
  ];

  if (context.repos.isMultiRepo) {
    templates.push('multi-repo/devcontainer.json.hbs');
    templates.push('multi-repo/docker-compose.yml.hbs');
  } else {
    templates.push('single-repo/devcontainer.json.hbs');
  }

  return templates;
}
```

### Extensions.json Merge Strategy

When rendering `extensions.json`, check if file exists in target repo:

```typescript
async function renderExtensionsJson(
  context: TemplateContext,
  existingContent?: string
): Promise<string> {
  const generacyExtensions = [
    'generacy-ai.agency',
    'generacy-ai.generacy'
  ];

  if (!existingContent) {
    return JSON.stringify({
      recommendations: generacyExtensions
    }, null, 2);
  }

  const existing = JSON.parse(existingContent);
  const merged = {
    ...existing,
    recommendations: [
      ...new Set([
        ...(existing.recommendations || []),
        ...generacyExtensions
      ])
    ]
  };

  return JSON.stringify(merged, null, 2);
}
```

---

## Implementation Phases

### Phase 1: Package Setup & Schema Definition (Day 1)

**Tasks**:
1. Create `packages/templates/` directory structure
2. Initialize `package.json` with dependencies
3. Define Zod schemas in `schema.ts` (see `data-model.md`)
4. Export TypeScript types from schemas
5. Set up tsconfig for library build
6. Add package to workspace root `package.json`

**Deliverables**:
- `@generacy-ai/templates` package scaffolded
- Type-safe schema for template context
- Build configuration complete

**Files**:
- `packages/templates/package.json`
- `packages/templates/tsconfig.json`
- `packages/templates/src/schema.ts`
- `packages/templates/src/index.ts` (exports only)

---

### Phase 2: Shared Templates (Day 2)

**Tasks**:
1. Create `config.yaml.hbs` template
   - Variable substitution for project metadata
   - Conditional sections for dev/clone repos
   - Conditional orchestrator config (multi-repo only)
2. Create `generacy.env.template.hbs`
   - Required env vars with descriptive comments
   - No actual secrets (template only)
3. Create `.gitignore` (static file)
   - Ignore `generacy.env`
   - Ignore `.agent-state/`
4. Create `extensions.json.hbs`
   - Recommendations for Agency + Generacy extensions

**Deliverables**:
- 4 shared template files
- Templates validated with sample contexts

**Files**:
- `packages/templates/src/shared/config.yaml.hbs`
- `packages/templates/src/shared/generacy.env.template.hbs`
- `packages/templates/src/shared/.gitignore`
- `packages/templates/src/shared/extensions.json.hbs`

**Reference**:
- See `data-model.md` for config.yaml schema
- See buildout plan section 4.2 for config.yaml example

---

### Phase 3: Single-Repo Templates (Day 2)

**Tasks**:
1. Create `devcontainer.json.hbs` for single-repo projects
   - Base image variable: `{{devcontainer.baseImage}}`
   - Feature reference with tag: `{{devcontainer.featureTag}}`
   - No docker-compose, direct container

**Deliverables**:
- Single-repo devcontainer template

**Files**:
- `packages/templates/src/single-repo/devcontainer.json.hbs`

**Example Output**:
```json
{
  "name": "{{project.name}}",
  "image": "{{devcontainer.baseImage}}",
  "features": {
    "ghcr.io/generacy-ai/generacy/generacy{{devcontainer.featureTag}}": {}
  },
  "customizations": {
    "vscode": {
      "extensions": [
        "generacy-ai.agency",
        "generacy-ai.generacy"
      ]
    }
  }
}
```

---

### Phase 4: Multi-Repo Templates (Day 3)

**Tasks**:
1. Create `devcontainer.json.hbs` for multi-repo projects
   - References `docker-compose.yml`
   - Service name: `orchestrator`
   - Workspace folder mappings for all repos
2. Create `docker-compose.yml.hbs`
   - Redis service (ephemeral, no persistence)
   - Orchestrator service
   - Worker services with `deploy.replicas`
   - Environment variables from `.generacy/generacy.env`

**Deliverables**:
- Multi-repo devcontainer + docker-compose templates

**Files**:
- `packages/templates/src/multi-repo/devcontainer.json.hbs`
- `packages/templates/src/multi-repo/docker-compose.yml.hbs`

**Reference**:
- `/workspaces/tetrad-development/docker-compose.generacy.yml` for structure
- Clarification Q6: Workers have no shared workspace volume
- Clarification Q9: Default `pollIntervalMs: 5000`, `workerCount: 3`
- Clarification Q14: Redis ephemeral (no persistence)

---

### Phase 5: Rendering Engine (Day 4)

**Tasks**:
1. Implement `renderer.ts`
   - Register Handlebars helpers (urlEncode, json, repoName)
   - Render single template function
   - Render full project function (returns file map)
2. Implement template selection logic
3. Handle special cases:
   - `.gitignore` is static (copy without rendering)
   - `extensions.json` requires merge logic

**Deliverables**:
- Working template rendering API
- Handlebars helpers registered

**Files**:
- `packages/templates/src/renderer.ts`

**API**:
```typescript
export async function renderTemplate(
  templatePath: string,
  context: TemplateContext
): Promise<string>;

export async function renderProject(
  context: TemplateContext
): Promise<Map<string, string>>;
```

---

### Phase 6: Validation (Day 4)

**Tasks**:
1. Implement pre-render validation (Zod)
2. Implement post-render validation
   - Parse rendered YAML/JSON
   - Check required fields
   - Validate structure
3. Add helpful error messages

**Deliverables**:
- Validation functions with clear error messages

**Files**:
- `packages/templates/src/validators.ts`

**API**:
```typescript
export function validateContext(context: unknown): TemplateContext;

export function validateRenderedConfig(yaml: string): void;
export function validateRenderedDevContainer(json: string): void;
```

---

### Phase 7: Testing (Day 5)

**Tasks**:
1. Unit tests for renderer
   - Test individual template rendering
   - Test Handlebars helpers
2. Unit tests for validators
   - Test valid contexts pass
   - Test invalid contexts fail with clear errors
3. Integration tests
   - Test full project rendering for single-repo
   - Test full project rendering for multi-repo
   - Test extensions.json merge logic
4. Snapshot tests
   - Capture rendered output for standard contexts
   - Detect unintended changes in future updates

**Deliverables**:
- Comprehensive test suite (>80% coverage)
- Test fixtures for common scenarios

**Files**:
- `packages/templates/tests/unit/renderer.test.ts`
- `packages/templates/tests/unit/validators.test.ts`
- `packages/templates/tests/integration/render-project.test.ts`
- `packages/templates/tests/fixtures/*.json`

---

### Phase 8: Documentation & API (Day 5)

**Tasks**:
1. Write package README
   - Installation instructions
   - API documentation
   - Usage examples (CLI and cloud service)
2. Export clean public API from `index.ts`
3. Add JSDoc comments to all exported functions
4. Create example contexts for documentation

**Deliverables**:
- Published package documentation
- Clean, well-documented API

**Files**:
- `packages/templates/README.md`
- `packages/templates/src/index.ts` (final exports)

---

## API Contracts

### Public API

```typescript
// Main rendering functions
export async function renderProject(
  context: TemplateContext
): Promise<Map<string, string>>;

export async function renderTemplate(
  templatePath: string,
  context: TemplateContext
): Promise<string>;

// Helper for extensions.json merging
export async function renderExtensionsJson(
  context: TemplateContext,
  existingContent?: string
): Promise<string>;

// Validation
export function validateContext(context: unknown): TemplateContext;

// Types
export type { TemplateContext } from './schema';
export type {
  ProjectContext,
  ReposContext,
  DefaultsContext,
  OrchestratorContext,
  DevContainerContext,
  MetadataContext
} from './schema';
```

### Context Builder Helpers

Utilities for constructing template context (used by CLI and cloud service):

```typescript
export function buildSingleRepoContext(options: {
  projectId: string;
  projectName: string;
  primaryRepo: string;
  baseImage?: string;
  releaseStream?: 'stable' | 'preview';
}): TemplateContext;

export function buildMultiRepoContext(options: {
  projectId: string;
  projectName: string;
  primaryRepo: string;
  devRepos: string[];
  cloneRepos?: string[];
  baseImage?: string;
  releaseStream?: 'stable' | 'preview';
  workerCount?: number;
  pollIntervalMs?: number;
}): TemplateContext;

export function buildContextFromProject(
  project: Project
): TemplateContext;
```

---

## Key Technical Decisions

### 1. Handlebars vs. Alternatives

**Decision**: Use Handlebars 4.7.8

**Rationale**:
- Supports conditionals (`{{#if}}`) and loops (`{{#each}}`)
- Well-established, actively maintained
- Works both server-side (Node.js) and potentially client-side (web UI preview)
- Better than Mustache (too limited) or custom implementation (maintenance burden)

**Reference**: Clarification Q1

---

### 2. Hybrid Template Organization

**Decision**: Separate templates for single-repo and multi-repo devcontainer.json, shared templates for everything else

**Rationale**:
- `devcontainer.json` differs substantially between single/multi-repo
- `docker-compose.yml` only exists for multi-repo
- Shared files (`config.yaml`, `env.template`, `extensions.json`) are identical
- Avoids full duplication while keeping templates readable

**Reference**: Clarification Q2

---

### 3. .gitignore Strategy

**Decision**: Create `.generacy/.gitignore` instead of patching root `.gitignore`

**Rationale**:
- No conflicts with existing user patterns
- No risk of duplicate entries
- Scoped to `.generacy/` directory only
- Works with Git 2.x nested `.gitignore` (universal support)

**Reference**: Clarification Q3

---

### 4. Feature Tag Selection

**Decision**: Add `releaseStream` to project config, default to `stable` (`:1`)

**Rationale**:
- Explicit per-project setting
- Early adopters can opt into `:preview`
- Auditable and clear in config
- Avoids environment-based magic

**Reference**: Clarification Q4

---

### 5. Base Image Configuration

**Decision**: Use `{{baseImage}}` template variable with default `mcr.microsoft.com/devcontainers/base:ubuntu`

**Rationale**:
- Language-agnostic default works for all stacks
- Generacy Dev Container Feature handles tooling installation
- Users can customize post-onboarding if needed
- Auto-detection is over-engineering for MVP

**Reference**: Clarification Q5

---

### 6. Worker Volume Mounts

**Decision**: Workers have no shared workspace volume

**Rationale**:
- Matches existing tetrad-development architecture
- Each worker clones repos independently via `REPO_URL`/`REPO_BRANCH`
- Avoids file conflicts between concurrent workers
- Simpler, proven pattern

**Reference**: Clarification Q6

---

### 7. Repository URL Format

**Decision**: Store as shorthand `owner/repo`, expand at runtime

**Rationale**:
- Concise and natural for GitHub-first approach
- Matches how developers think about repos
- GitHub App provides auth context for expansion
- Keeps config files clean

**Reference**: Clarification Q7

---

### 8. Environment Variable Validation

**Decision**: Validation handled by `generacy doctor` CLI command (issue #254), not in templates

**Rationale**:
- Templates stay simple (just provide examples)
- Runtime validation gives clear pass/fail output
- Aligns with planned `generacy doctor` implementation
- Dev Container Feature can also do basic checks on start

**Reference**: Clarification Q8

---

### 9. Orchestrator Defaults

**Decision**: `pollIntervalMs: 5000`, `workerCount: 3`

**Rationale**:
- Matches buildout plan examples
- Matches existing tetrad-development docker-compose defaults
- Balanced performance for most projects
- 5s polling is responsive without hammering API
- 3 workers handles typical parallel workloads

**Reference**: Clarification Q9

---

### 10. Redis Persistence

**Decision**: Ephemeral Redis (no volume persistence)

**Rationale**:
- Orchestrator rescans issues on startup and repopulates queue
- Persisting stale data could cause duplicate work
- Simpler for dev containers
- Avoids stale state issues across restarts

**Reference**: Clarification Q14

---

### 11. Dev vs Clone Repo Treatment

**Decision**: All repos cloned side-by-side under `/workspaces/`, distinction enforced at orchestrator/worker level

**Rationale**:
- Matches tetrad-development pattern (`/workspaces/repo-name/`)
- Workers only create branches/PRs on `repos.dev`, not `repos.clone`
- No directory-level separation needed
- Simpler mental model

**Reference**: Clarification Q15

---

### 12. Timestamp Format

**Decision**: ISO 8601 UTC (`2026-02-24T15:30:00Z`)

**Rationale**:
- Standard, unambiguous, machine-readable
- Appears in config metadata (not user-facing UI)
- Universal choice for generated files

**Reference**: Clarification Q11

---

### 13. Template Storage Location

**Decision**: `generacy/packages/templates/` published as `@generacy-ai/templates` npm package

**Rationale**:
- Consumable by both CLI and cloud service
- Follows existing pattern (workflow templates in generacy repo)
- Versioned with main repo releases
- Publicly visible to adopters

**Reference**: Clarification Q12

---

## Risk Mitigation Strategies

### Risk 1: Template Rendering Errors

**Impact**: High - Broken templates block onboarding

**Mitigation**:
- Comprehensive unit and integration tests
- Snapshot testing to detect unintended changes
- Pre-render validation (Zod schema)
- Post-render validation (parse YAML/JSON)
- Clear error messages with context

---

### Risk 2: Extensions.json Merge Conflicts

**Impact**: Medium - User loses existing recommendations

**Mitigation**:
- Smart merge preserves all existing recommendations
- Add Generacy extensions to array (no replacement)
- Handle missing file gracefully (create new)
- Test with various existing configurations

---

### Risk 3: Template Schema Changes

**Impact**: Medium - Older templates incompatible with newer context

**Mitigation**:
- Include `schema_version` in template metadata
- Implement migration system for context transforms
- Version templates with npm package
- Maintain backward compatibility where possible

---

### Risk 4: Docker Compose Complexity

**Impact**: Medium - Multi-repo setup fails for some environments

**Mitigation**:
- Follow proven tetrad-development pattern
- Include healthchecks for all services
- Test on multiple platforms (Linux, macOS, Windows WSL2)
- Document troubleshooting steps

---

### Risk 5: Dev Container Feature Not Published

**Impact**: High - Templates reference non-existent feature

**Mitigation**:
- Coordinate with issue #252 (Publish Dev Container Feature)
- This issue (#247) is Phase 1, Feature publish is Phase 3
- Templates will be ready when feature is published
- Use local feature reference for testing

---

## Dependencies

### Upstream Dependencies
- None (Phase 1 - Foundation, can start immediately)

### Downstream Dependencies
- **Issue #248**: `.generacy/config.yaml` schema definition (parallel work, same phase)
- **Issue #252**: Dev Container Feature publishing (Phase 3 - templates reference `:preview` and `:1` tags)
- **Issue #249**: `generacy init` CLI command (Phase 3 - consumes this package)
- **Issue #95**: Onboarding PR generation service (Phase 3 - consumes this package)

---

## Testing Strategy

### Unit Tests (80% coverage target)

```typescript
describe('renderTemplate', () => {
  it('renders config.yaml with single-repo context', async () => {
    const context = fixtures.singleRepoContext;
    const output = await renderTemplate('shared/config.yaml.hbs', context);
    const parsed = yaml.load(output);

    expect(parsed.project.id).toBe('proj_test123');
    expect(parsed.orchestrator).toBeUndefined();
  });

  it('renders config.yaml with multi-repo context', async () => {
    const context = fixtures.multiRepoContext;
    const output = await renderTemplate('shared/config.yaml.hbs', context);
    const parsed = yaml.load(output);

    expect(parsed.orchestrator.workerCount).toBe(3);
    expect(parsed.repos.dev).toHaveLength(2);
  });
});

describe('Handlebars helpers', () => {
  it('repoName extracts repo from shorthand', () => {
    const template = Handlebars.compile('{{repoName "acme/main-api"}}');
    expect(template({})).toBe('main-api');
  });
});

describe('validateContext', () => {
  it('accepts valid context', () => {
    expect(() => validateContext(fixtures.validContext)).not.toThrow();
  });

  it('rejects context missing project.id', () => {
    const invalid = { ...fixtures.validContext, project: { name: 'Test' } };
    expect(() => validateContext(invalid)).toThrow(/project.id/);
  });
});
```

### Integration Tests

```typescript
describe('renderProject', () => {
  it('generates all files for single-repo project', async () => {
    const files = await renderProject(fixtures.singleRepoContext);

    expect(files.size).toBe(5);
    expect(files.has('.generacy/config.yaml')).toBe(true);
    expect(files.has('.devcontainer/devcontainer.json')).toBe(true);
    expect(files.has('.devcontainer/docker-compose.yml')).toBe(false);
  });

  it('generates all files for multi-repo project', async () => {
    const files = await renderProject(fixtures.multiRepoContext);

    expect(files.size).toBe(6);
    expect(files.has('.devcontainer/docker-compose.yml')).toBe(true);
  });

  it('merges extensions.json with existing recommendations', async () => {
    const existing = { recommendations: ['dbaeumer.vscode-eslint'] };
    const output = await renderExtensionsJson(
      fixtures.singleRepoContext,
      JSON.stringify(existing)
    );
    const parsed = JSON.parse(output);

    expect(parsed.recommendations).toContain('dbaeumer.vscode-eslint');
    expect(parsed.recommendations).toContain('generacy-ai.agency');
    expect(parsed.recommendations).toContain('generacy-ai.generacy');
  });
});
```

### Snapshot Tests

```typescript
describe('template snapshots', () => {
  it('config.yaml matches snapshot', async () => {
    const output = await renderTemplate(
      'shared/config.yaml.hbs',
      fixtures.standardMultiRepoContext
    );
    expect(output).toMatchSnapshot();
  });

  it('docker-compose.yml matches snapshot', async () => {
    const output = await renderTemplate(
      'multi-repo/docker-compose.yml.hbs',
      fixtures.standardMultiRepoContext
    );
    expect(output).toMatchSnapshot();
  });
});
```

---

## Success Criteria

### Functional Requirements

- ✅ Templates render valid YAML/JSON for all supported contexts
- ✅ Single-repo and multi-repo variants produce correct file sets
- ✅ Extensions.json merge preserves existing recommendations
- ✅ All variables properly substituted (no `{{undefined}}` in output)
- ✅ Generated config.yaml validates against schema (issue #248)
- ✅ Generated devcontainer.json references correct feature tag

### Quality Requirements

- ✅ Test coverage ≥80%
- ✅ All tests pass in CI
- ✅ Snapshot tests catch unintended changes
- ✅ Validation errors include helpful messages
- ✅ Package exports clean TypeScript types

### Integration Requirements

- ✅ Package published to npm as `@generacy-ai/templates`
- ✅ CLI can import and use templates (issue #249)
- ✅ Cloud service can import and use templates (issue #95)
- ✅ Templates work with both `:preview` and `:1` feature tags

---

## Open Questions

### Q1: Should templates include .gitattributes?

**Context**: Some repos use `.gitattributes` for line ending normalization

**Recommendation**: Skip for MVP. Add in future iteration if needed.

---

### Q2: Should we support custom template variables?

**Context**: Users might want to inject custom variables (e.g., company name)

**Recommendation**: Not for MVP. Context schema is fixed. Can extend later.

---

### Q3: How to handle template updates for existing projects?

**Context**: If templates change, how do users update their configs?

**Recommendation**: Out of scope for this issue. Future feature: `generacy update` command to re-render templates with preserved user customizations.

---

## Appendices

### A. Example Rendered Files

See `data-model.md` for config.yaml example.

### B. Handlebars Helper Reference

```typescript
// {{repoName "owner/repo"}} → "repo"
Handlebars.registerHelper('repoName', (shorthand: string) => {
  return shorthand.split('/')[1];
});

// {{json project}} → pretty-printed JSON
Handlebars.registerHelper('json', (obj: any) => {
  return JSON.stringify(obj, null, 2);
});

// {{urlEncode "string with spaces"}} → "string%20with%20spaces"
Handlebars.registerHelper('urlEncode', (str: string) => {
  return encodeURIComponent(str);
});
```

### C. Template Paths → Target Paths

| Template | Target Path | Condition |
|----------|-------------|-----------|
| `shared/config.yaml.hbs` | `.generacy/config.yaml` | Always |
| `shared/generacy.env.template.hbs` | `.generacy/generacy.env.template` | Always |
| `shared/.gitignore` | `.generacy/.gitignore` | Always |
| `shared/extensions.json.hbs` | `.vscode/extensions.json` | Always (merge if exists) |
| `single-repo/devcontainer.json.hbs` | `.devcontainer/devcontainer.json` | Single-repo only |
| `multi-repo/devcontainer.json.hbs` | `.devcontainer/devcontainer.json` | Multi-repo only |
| `multi-repo/docker-compose.yml.hbs` | `.devcontainer/docker-compose.yml` | Multi-repo only |

---

**Plan Complete** - Ready for implementation.
