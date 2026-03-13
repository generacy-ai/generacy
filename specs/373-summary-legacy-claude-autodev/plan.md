# Implementation Plan: Remove autodev.json and migrate config to .generacy/config.yaml

**Feature**: Eliminate legacy `.claude/autodev.json` and consolidate all speckit config under `.generacy/config.yaml`
**Branch**: `373-summary-legacy-claude-autodev`
**Status**: Complete

## Summary

This is a configuration migration — not a behavior change. The legacy `.claude/autodev.json` file and all "autodev" branding references are removed. Speckit configuration (paths, files, branches) is absorbed into the existing `.generacy/config.yaml` Zod schema. All default values remain identical.

## Technical Context

- **Language**: TypeScript
- **Packages**: monorepo with `packages/generacy`, `packages/workflow-engine`, `packages/github-issues`, `packages/generacy-extension`
- **Config stack**: Zod schema validation + YAML parsing (via `yaml` package)
- **Existing loader**: `packages/generacy/src/config/loader.ts` already discovers and parses `.generacy/config.yaml`
- **Test framework**: Vitest with mock-based filesystem stubs

## Project Structure

```
packages/
├── generacy/src/config/
│   ├── schema.ts              # FR-001: Add speckit section to Zod schema
│   ├── loader.ts              # No changes needed (already loads .generacy/config.yaml)
│   └── __tests__/
│       └── schema.test.ts     # FR-010: Add speckit schema tests
├── workflow-engine/src/actions/builtin/speckit/lib/
│   ├── fs.ts                  # FR-002: Migrate resolveSpecsPath, resolveTemplatesPath, getFilesConfig
│   ├── feature.ts             # FR-003: Migrate loadBranchConfig
│   └── __tests__/
│       └── feature.test.ts    # FR-009: Update mocks
├── github-issues/src/webhooks/
│   └── triggers.ts            # FR-004, FR-005: Remove autodev patterns
└── generacy-extension/src/views/local/runner/actions/
    └── cli-utils.ts           # FR-006: Update phase detection regex

Root files:
├── .claude/autodev.json       # FR-008: Delete
└── .windsurfrules             # FR-007: Remove autodev reference
```

## Implementation Phases

### Phase 1: Schema Extension (Blocking — all other phases depend on this)

**File**: `packages/generacy/src/config/schema.ts`

Add `SpecKitConfigSchema` with three subsections:
- `paths` — `specs` (default `"specs"`), `templates` (default `".specify/templates"`)
- `files` — `spec`, `plan`, `tasks`, `clarifications`, `research`, `dataModel` (all with `.md` defaults)
- `branches` — `pattern`, `numberPadding`, `slugOptions` (all matching current `DEFAULT_BRANCH_CONFIG` in `feature.ts`)

Add `speckit: SpecKitConfigSchema.optional()` to `GeneracyConfigSchema`. The entire section is optional with defaults, so existing config files remain valid.

Export `SpecKitConfig` type for downstream consumers.

### Phase 2: Config Reading Migration (Depends on Phase 1)

**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/fs.ts`

Three functions to update:

1. **`resolveSpecsPath()`** (lines 111-130) — Replace `.claude/autodev.json` JSON parsing with loading `.generacy/config.yaml` and reading `speckit.paths.specs`. Use the existing `loadConfig()` from `@generacy-ai/generacy/config` or parse YAML directly with fallback to defaults.

2. **`resolveTemplatesPath()`** (lines 136-155) — Same pattern, read `speckit.paths.templates`.

3. **`getFilesConfig()`** (lines 172-203) — Same pattern, read `speckit.files`.

**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`

4. **`loadBranchConfig()`** (lines 59-85) — Replace `.claude/autodev.json` reading with `.generacy/config.yaml` → `speckit.branches`. Keep `DEFAULT_BRANCH_CONFIG` as fallback.

**Design decision**: These functions should load and parse `.generacy/config.yaml` YAML directly (using the `yaml` package) rather than importing `loadConfig()` from the generacy package, to avoid introducing a cross-package dependency from workflow-engine → generacy. The pattern should mirror the current approach (read file, parse, extract field, fallback to default) but with YAML instead of JSON.

### Phase 3: Branding Cleanup (Independent of Phases 1-2)

**File**: `packages/github-issues/src/webhooks/triggers.ts`
- Line 35: Remove `/@autodev\s+continue/i` from `DEFAULT_RESUME_PATTERNS`
- Lines 98-101: Change `label.name === 'autodev:ready' || label.name === 'ready'` to just `label.name === 'ready'`

**File**: `packages/generacy-extension/src/views/local/runner/actions/cli-utils.ts`
- Line 313: Change regex from `(speckit|autodev):(\w+)` to `(speckit):(\w+)`

**File**: `.windsurfrules`
- Line 61: Remove or update the `157-migrate-autodev-workflow-capabilities` reference

### Phase 4: Testing (Depends on Phase 2)

**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/__tests__/feature.test.ts`
- Update all `existsFor` mocks: change `'autodev.json': false` to `'config.yaml': false` (lines 135, 263, 299, 321, 358, 384, 414)
- Add test cases for when config.yaml exists with `speckit.branches` section

**File**: `packages/generacy/src/config/__tests__/schema.test.ts`
- Add tests validating the new `speckit` schema section: defaults, full override, partial override, validation errors

### Phase 5: Cleanup (Final)

- Delete `.claude/autodev.json`
- Verify no remaining functional `autodev` references via grep

## Key Technical Decisions

1. **YAML parsing in workflow-engine**: Parse `.generacy/config.yaml` directly with the `yaml` package rather than importing the generacy config loader. This avoids a new cross-package dependency and keeps the migration minimal.

2. **All-optional with defaults**: The entire `speckit` section is optional. Sub-fields have defaults matching current hardcoded values. This means no existing `.generacy/config.yaml` files need updating.

3. **No backward compatibility layer**: The migration is forward-only. There is no fallback to `.claude/autodev.json`. This is acceptable because the legacy file only existed in this repo and is under our control.

4. **`stateProvider` config not migrated**: The `autodev.json` contains a `stateProvider` field that is not referenced by any code. It is silently dropped.

## Risk Assessment

- **Low risk**: All defaults are preserved exactly, so behavior is unchanged for repos without custom config
- **Testing gap**: Need to verify `yaml` package is already a dependency of `workflow-engine` (it is via transitive deps, but may need explicit addition)
- **No runtime breakage**: The `speckit` section is fully optional — existing config files pass validation without changes
