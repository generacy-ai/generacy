# Research & Technical Decisions

## Codebase Analysis

### Current Architecture

The `generacy init` command has a clean 10-step orchestration flow:

1. **Git root detection** — validates user is in a git repo
2. **Option resolution** — merges CLI flags > existing config > interactive prompts > auto-detection > defaults
3. **GitHub validation** — advisory repo access checks (never blocks)
4. **Context building** — constructs `TemplateContext` via `buildSingleRepoContext()` or `buildMultiRepoContext()`
5. **Existing file collection** — reads `.vscode/extensions.json` for smart merge
6. **Template rendering** — `renderProject()` generates all files via Handlebars
7. **Conflict detection** — checks which output files already exist on disk
8. **Conflict resolution** — per-file overwrite/skip/diff prompts (or `--force`/`--yes`)
9. **File writing** — writes to disk or dry-run preview
10. **Summary** — prints results and next steps

The templates package (`@generacy-ai/templates`) has clear separation:
- `schema.ts` — Zod-validated type definitions
- `builders.ts` — Context construction from simpler inputs
- `renderer.ts` — Handlebars template loading, selection, and rendering
- `validators.ts` — Pre-render (schema) and post-render (structure) validation

### Template Selection Pattern

Currently, template selection is driven by `context.repos.isMultiRepo`:

```typescript
// renderer.ts: selectTemplates()
if (context.repos.isMultiRepo) {
  // → multi-repo/devcontainer.json.hbs + multi-repo/docker-compose.yml.hbs
} else {
  // → single-repo/devcontainer.json.hbs
}
```

Shared templates (config.yaml, generacy.env.template, .gitignore, extensions.json) are always included.

The cluster templates integration replaces this binary selection with variant-based routing while keeping the shared templates unchanged.

### Key Integration Points

**Handlebars configuration** (`renderer.ts`):
- `strict: true` — throws on undefined variables (good for catching template errors)
- `noEscape: true` — templates produce YAML/JSON, not HTML
- Custom helpers: `repoName`, `configRepoUrl`, `json`, `urlEncode`, `eq`
- Static file detection: files without `.hbs` extension are copied verbatim

**Conflict resolution** (`conflicts.ts`):
- Per-file actions: overwrite / skip / merge
- Smart merge only for `.vscode/extensions.json`
- `--force` overwrites all; `--yes` overwrites all + smart-merge where applicable

**Post-render validation** (`validators.ts`):
- `validateRenderedDevContainer()` currently requires Generacy Feature — must be relaxed for cluster templates
- `findUndefinedVariables()` uses regex `\{\{?\{?\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}?\}?\}/g` — matches `{{ }}` not `${ }`, safe for bash scripts
- `validateAllRenderedFiles()` applies validators based on file path suffix

---

## Decision Log

### D1: Extend renderProject vs. Separate renderCluster

**Options considered**:
- A) Extend `renderProject()` — add variant to context, route in `selectTemplates()`
- B) Separate `renderCluster()` — new function, init command merges results
- C) Replace with `renderInit()` — new unified function

**Decision**: A — Extend `renderProject()`

**Rationale**: The existing pattern in `selectTemplates()` already does conditional routing based on `isMultiRepo`. Adding variant-based routing follows the same pattern. A single entry point means the init command doesn't need to orchestrate two rendering calls, and validators/conflict resolution work unchanged.

### D2: Where to Store Cluster Templates

**Options considered**:
- In `packages/templates/src/cluster/{variant}/` — alongside existing templates
- In a separate `packages/cluster-templates/` package — independent versioning
- Fetched at runtime from GitHub API — always latest

**Decision**: In `packages/templates/src/cluster/` — bundled with existing templates

**Rationale**: Eliminates runtime GitHub API dependency. Enables offline usage. Version consistency between CLI and templates. Templates can be tested alongside CLI changes. The spec explicitly calls for this approach.

### D3: Handlebars vs. Static for Shell Scripts

**Options considered**:
- All Handlebars — maximum flexibility for build-time substitution
- All static — simplest, no rendering conflicts
- Hybrid — most scripts static, specific ones use Handlebars

**Decision**: All static (Q8-A)

**Rationale**: Shell scripts use `${VAR:-default}` bash syntax which conflicts with Handlebars `{{ }}` delimiters. All configuration is handled via runtime environment variables. Converting to Handlebars adds complexity for zero gain and risks breaking bash syntax.

### D4: Devcontainer Feature Removal

The current single-repo template uses the Generacy Dev Container Feature (`ghcr.io/generacy-ai/features/generacy`). Cluster templates install the CLI directly in the Dockerfile.

**Decision**: Remove Feature from cluster devcontainer.json (Q9-A)

**Impact on validators**: `validateRenderedDevContainer()` currently checks for the Feature and throws if not found. This check must be relaxed for cluster templates (which use `dockerComposeFile` instead of `image`).

### D5: Static File Handling in Validation

The `findUndefinedVariables()` function scans all rendered content for `{{ }}` patterns. Static files (.sh scripts) contain bash `${}` syntax but NOT Handlebars `{{ }}` syntax.

**Verification**: The regex `/\{\{?\{?\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}?\}?\}/g` matches:
- `{{var}}` ✓ (catches Handlebars)
- `{{{var}}}` ✓ (catches Handlebars raw)
- `${var}` ✗ (does NOT match bash variables)
- `${var:-default}` ✗ (does NOT match bash fallbacks)

**Conclusion**: Safe. No changes needed. Static files pass through the undefined variable check without false positives.

### D6: Environment Variable Fallback Pattern

Per Q2-C, scripts use official names with fallbacks:

```bash
# In setup-credentials.sh and entrypoint scripts:
export GITHUB_TOKEN="${GITHUB_TOKEN:-$GH_TOKEN}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$CLAUDE_API_KEY}"
```

In `.env.template`:
```bash
# GitHub authentication (also accepts GH_TOKEN)
GITHUB_TOKEN=

# Anthropic API key (also accepts CLAUDE_API_KEY)
ANTHROPIC_API_KEY=
```

This ensures backward compatibility with existing cluster-templates users while aligning with ecosystem conventions.

---

## Existing Test Coverage

Test files exist at:
- `packages/templates/tests/unit/builders.test.ts` — context builder tests
- `packages/templates/tests/unit/validators.test.ts` — validation tests
- `packages/templates/tests/unit/renderer.test.ts` — rendering engine tests
- `packages/templates/tests/integration/render-project.test.ts` — full flow tests
- `packages/templates/tests/integration/snapshots.test.ts` — snapshot regression tests
- `packages/templates/tests/fixtures/fixture-validation.test.ts` — fixture validation

Test fixtures (JSON context objects):
- `minimal-single-repo-context.json`
- `single-repo-context.json`
- `multi-repo-context.json`
- `large-multi-repo-context.json`
- Various edge case fixtures

**Impact**: All existing tests will need updating since `TemplateContext` now requires a `cluster` field. Fixtures need `cluster: { variant: "standard" }` added. Snapshot tests will need regeneration.

No existing tests for the CLI init command were found (only template package tests exist).

---

## Backward Compatibility

### Template Context Consumers

The `@generacy-ai/templates` package is consumed by both the CLI (`generacy init`) and the cloud service (onboarding PR generation). Adding `cluster` to `TemplateContext` is a **breaking change** for any consumer that constructs contexts manually.

**Mitigation**:
- `ClusterContextSchema` has a default (`variant: 'standard'`)
- Existing `buildSingleRepoContext()` and `buildMultiRepoContext()` will set `cluster.variant = 'standard'` by default when `variant` is not provided
- Cloud service will need updating separately

### Config Schema

Adding `cluster` as optional to `GeneracyConfigSchema` is backward compatible — existing config files without `cluster` will parse successfully (Zod `.optional()` handles this).

### Generated Files

Users who previously ran `generacy init` will have:
- `.devcontainer/devcontainer.json` (old format with `image` key)
- Possibly `.devcontainer/docker-compose.yml` (multi-repo only)
- No `.devcontainer/Dockerfile`, no `.devcontainer/scripts/`, no `.devcontainer/.env.template`

Re-running `generacy init`:
- New files (Dockerfile, scripts, .env.template) — created without conflict
- Existing devcontainer.json — conflict resolution prompts (with migration warning if old format detected)
- Existing docker-compose.yml — conflict resolution prompts
