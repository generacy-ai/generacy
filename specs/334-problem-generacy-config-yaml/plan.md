# Implementation Plan: Template Config Format Support

**Feature**: Add template config format (`project` + `repos.primary/dev/clone`) support to the workspace config loader
**Branch**: `334-problem-generacy-config-yaml`
**Status**: Complete

## Summary

The `tryLoadWorkspaceConfig()` function in `@generacy-ai/config` only recognizes configs with a `workspace` key. Cluster-templates generate configs using the `project` + `repos.primary/dev/clone` format (the "generacy config" format). This means externally-generated config files are structurally invisible to the workspace setup command and orchestrator fallback.

The fix adds a fallback path in `tryLoadWorkspaceConfig()`: when no `workspace` key is found, detect the template format (`project` + `repos` with `primary` key), convert it to a `WorkspaceConfig`, and return it. This is **Option A** from the spec — the template format is already in users' hands and contains sufficient information.

## Technical Context

- **Language**: TypeScript
- **Framework**: Node.js monorepo (pnpm workspaces)
- **Key dependencies**: `zod` (schema validation), `yaml` (parsing)
- **Package**: `@generacy-ai/config` (`packages/config/`)
- **Test framework**: Vitest

## Design Decisions

### Clarification Resolutions

The spec has 4 pending clarifications. The implementation assumes:

1. **Q1 (repos.dev/clone format)**: Flat list of `"github.com/owner/repo"` strings (confirmed by existing `ReposConfigSchema` in `packages/generacy/src/config/schema.ts` and example configs)

2. **Q2 (primary repo monitor flag)**: Primary repo gets `monitor: true`. The primary repo is the "main" project repo — monitoring it is the expected default behavior. Callers can override if needed.

3. **Q3 (template validation errors)**: **Throw** on validation errors (Option A). This is consistent with the existing `workspace` key behavior — if the format is detected (template keys present), validation errors are real errors, not "unrecognized format".

4. **Q4 (project metadata preservation)**: **Only return `WorkspaceConfig`** (Option A). The workspace loader's contract returns `WorkspaceConfig | null` and changing this would break all consumers. Project metadata is available through the separate `loadConfig()` in `packages/generacy/src/config/loader.ts` for consumers that need it.

### Conversion Logic

Template format → WorkspaceConfig mapping:
- `repos.primary` (`"github.com/owner/repo"` or `"owner/repo"`) → extract `owner` as `org`, `repo` as first entry in `repos[]`
- `repos.dev[]` → additional `repos[]` entries with `monitor: true`
- `repos.clone[]` → additional `repos[]` entries with `monitor: false`
- `project.org_name` → used as `org` if `repos.primary` is a bare name (fallback)
- `branch` → defaults to `'develop'` (matches `WorkspaceConfigSchema` default)

### Why not reuse `GeneracyConfigSchema`?

The `@generacy-ai/config` package is a low-level dependency. Importing `GeneracyConfigSchema` from `@generacy-ai/generacy` would create a circular dependency. Instead, we define a lightweight `TemplateConfigSchema` in the config package that validates only the fields needed for conversion.

## Project Structure

```
packages/config/src/
├── workspace-schema.ts          # existing — no changes
├── loader.ts                    # MODIFY — add template format detection + fallback
├── template-schema.ts           # NEW — Zod schema for template config format
├── convert-template.ts          # NEW — template → WorkspaceConfig converter
├── repos.ts                     # existing — no changes
├── parse-repo-input.ts          # existing — reuse parseRepoInput()
├── drift.ts                     # existing — no changes
├── index.ts                     # MODIFY — export new modules
├── __tests__/
│   ├── loader.test.ts           # MODIFY — add template fallback tests
│   ├── template-schema.test.ts  # NEW — template schema validation tests
│   └── convert-template.test.ts # NEW — conversion logic tests
```

## Implementation Steps

### Step 1: Create `template-schema.ts`

Define a lightweight Zod schema for the template config format:

```typescript
// Validates just enough to detect and convert the template format
export const TemplateReposSchema = z.object({
  primary: z.string().min(1),
  dev: z.array(z.string()).optional().default([]),
  clone: z.array(z.string()).optional().default([]),
});

export const TemplateConfigSchema = z.object({
  project: z.object({
    org_name: z.string().optional(),
  }).passthrough().optional(),
  repos: TemplateReposSchema,
});
```

Key design choices:
- Uses `.passthrough()` on `project` to not reject extra fields like `id`, `org_id`, `name`
- `repos.primary` is a plain string (not validated as URL) — `parseRepoInput()` handles format detection
- `project` is optional — only `repos` with `primary` is required for detection

### Step 2: Create `convert-template.ts`

Conversion function:

```typescript
export function convertTemplateConfig(template: TemplateConfig): WorkspaceConfig {
  // 1. Parse primary repo to get owner/repo
  const primary = parseRepoInput(template.repos.primary, template.project?.org_name);

  // 2. Build repos array: primary first, then dev (monitor:true), then clone (monitor:false)
  const repos: WorkspaceRepo[] = [
    { name: primary.repo, monitor: true },
    ...template.repos.dev.map(r => {
      const parsed = parseRepoInput(r, primary.owner);
      return { name: parsed.repo, monitor: true };
    }),
    ...template.repos.clone.map(r => {
      const parsed = parseRepoInput(r, primary.owner);
      return { name: parsed.repo, monitor: false };
    }),
  ];

  // 3. Return WorkspaceConfig
  return { org: primary.owner, branch: 'develop', repos };
}
```

### Step 3: Modify `loader.ts`

Add template format fallback to `tryLoadWorkspaceConfig()`:

```typescript
export function tryLoadWorkspaceConfig(configPath: string): WorkspaceConfig | null {
  // ... existing null checks ...

  // Existing: try workspace key
  if ('workspace' in doc && doc['workspace'] != null) {
    return WorkspaceConfigSchema.parse(doc['workspace']);
  }

  // NEW: try template format (repos.primary detection)
  if ('repos' in doc && doc['repos'] != null &&
      typeof doc['repos'] === 'object' && 'primary' in (doc['repos'] as object)) {
    const template = TemplateConfigSchema.parse(doc);
    return convertTemplateConfig(template);
  }

  return null;
}
```

### Step 4: Update `index.ts`

Export new modules for consumers that need them directly.

### Step 5: Write tests

- **template-schema.test.ts**: Schema validation for various template formats (full, minimal, missing fields, invalid)
- **convert-template.test.ts**: Conversion logic with different repo formats (owner/repo, URLs, bare names), edge cases (empty dev/clone, multiple repos)
- **loader.test.ts additions**: Integration tests for template fallback path — config with `project`+`repos` keys returns correct `WorkspaceConfig`

## Edge Cases

1. **Config has both `workspace` and `repos.primary`**: `workspace` key takes precedence (existing behavior unchanged)
2. **`repos.dev`/`repos.clone` contain repos from different orgs**: Each repo is parsed individually; `org` is derived from `repos.primary` only
3. **`repos.primary` is a bare name without `project.org_name`**: `parseRepoInput()` throws, which propagates as a validation error (consistent with Q3 decision)
4. **Template format YAML comments (`# none configured`)**: YAML parser ignores comments; empty arrays are handled by `.optional().default([])`

## Risk Assessment

- **Low risk**: Changes are additive — existing `workspace` key behavior is untouched
- **No breaking changes**: Return type remains `WorkspaceConfig | null`
- **Existing consumers unaffected**: Orchestrator and CLI setup will transparently benefit from the new fallback
