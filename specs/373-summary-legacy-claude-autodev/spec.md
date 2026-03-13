# Feature Specification: Remove autodev.json and migrate config to .generacy/config.yaml

**Branch**: `373-summary-legacy-claude-autodev` | **Date**: 2026-03-13 | **Status**: Draft

## Summary

The legacy `.claude/autodev.json` configuration file needs to be removed and its functionality migrated to `.generacy/config.yaml`. The `autodev` branding is deprecated in favor of Generacy.

## Background

`.claude/autodev.json` was the original configuration mechanism for speckit operations. Now that we have `.generacy/config.yaml` as the canonical project config, the autodev.json file should be eliminated and its schema absorbed into the generacy config.

## User Stories

### US1: Developer uses unified config

**As a** developer working in a Generacy-managed project,
**I want** all configuration to live in `.generacy/config.yaml`,
**So that** I don't need to maintain a separate `.claude/autodev.json` file and can find all project settings in one place.

**Acceptance Criteria**:
- [ ] Speckit reads paths, files, and branch config from `.generacy/config.yaml`
- [ ] `.claude/autodev.json` is deleted from the repo
- [ ] Existing behavior (defaults, naming conventions) is unchanged

### US2: Clean removal of autodev branding

**As a** maintainer of the Generacy platform,
**I want** all references to the deprecated "autodev" branding removed from triggers and CLI detection,
**So that** the codebase consistently uses the "Generacy" / "speckit" nomenclature.

**Acceptance Criteria**:
- [ ] `@autodev continue` trigger pattern removed from webhook triggers
- [ ] `autodev:ready` label check removed from webhook triggers
- [ ] CLI phase detection regex no longer matches `autodev:*` patterns
- [ ] `.windsurfrules` contains no autodev references

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `speckit` section to Zod schema in `packages/generacy/src/config/schema.ts` with `paths`, `files`, and `branches` subsections | P1 | Schema must include defaults matching current autodev.json values |
| FR-002 | Migrate `resolveSpecsPath()`, `resolveTemplatesPath()`, `getFilesConfig()` in `workflow-engine/.../fs.ts` to read from `.generacy/config.yaml` | P1 | |
| FR-003 | Migrate `loadBranchConfig()` in `workflow-engine/.../feature.ts` to read from `.generacy/config.yaml` | P1 | |
| FR-004 | Remove `/@autodev\s+continue/i` from `DEFAULT_RESUME_PATTERNS` in webhook triggers | P1 | Keep `/@agent\s+continue/i` |
| FR-005 | Remove `label.name === 'autodev:ready'` check in webhook triggers | P1 | Keep `label.name === 'ready'` |
| FR-006 | Update CLI regex from `(speckit\|autodev):(\w+)` to `(speckit):(\w+)` | P1 | |
| FR-007 | Remove autodev references from `.windsurfrules` | P2 | |
| FR-008 | Delete `.claude/autodev.json` | P1 | |
| FR-009 | Update `feature.test.ts` to mock `.generacy/config.yaml` instead of `.claude/autodev.json` | P1 | |
| FR-010 | Add schema tests for new `speckit` section in config | P2 | |

## Tasks

### 1. Expand `.generacy/config.yaml` schema with speckit config

Add a `speckit` section to the Zod schema in `packages/generacy/src/config/schema.ts`:

```yaml
speckit:
  paths:
    specs: "specs"
    templates: ".specify/templates"
  files:
    spec: "spec.md"
    plan: "plan.md"
    tasks: "tasks.md"
    clarifications: "clarifications.md"
    research: "research.md"
    dataModel: "data-model.md"
  branches:
    pattern: "{paddedNumber}-{slug}"
    numberPadding: 3
    slugOptions:
      maxLength: 30
      separator: "-"
      removeStopWords: true
      maxWords: 4
```

### 2. Migrate config reading in workflow-engine

**`packages/workflow-engine/src/actions/builtin/speckit/lib/fs.ts`:**
- `resolveSpecsPath()` — change from reading `.claude/autodev.json` → `.generacy/config.yaml` (`speckit.paths.specs`)
- `resolveTemplatesPath()` — same, read `speckit.paths.templates`
- `getFilesConfig()` — same, read `speckit.files`

**`packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`:**
- `loadBranchConfig()` — change from reading `.claude/autodev.json` → `.generacy/config.yaml` (`speckit.branches`)

### 3. Update webhook triggers

**`packages/github-issues/src/webhooks/triggers.ts`:**
- Line 35: Remove `/@autodev\s+continue/i` from `DEFAULT_RESUME_PATTERNS` (keep `/@agent\s+continue/i`)
- Line 99: Remove `label.name === 'autodev:ready'` check (keep `label.name === 'ready'`)

### 4. Update CLI phase detection

**`packages/generacy-extension/src/views/local/runner/actions/cli-utils.ts`:**
- Line 313: Change regex from `(speckit|autodev):(\w+)` to just `(speckit):(\w+)`

### 5. Update .windsurfrules

Remove any autodev references from `.windsurfrules`.

### 6. Delete `.claude/autodev.json`

### 7. Update tests

- Update feature.test.ts to mock `.generacy/config.yaml` instead of `.claude/autodev.json`
- Add schema tests for new `speckit` section in config

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | All speckit operations use `.generacy/config.yaml` | 100% | No code references to `.claude/autodev.json` remain |
| SC-002 | No autodev branding in triggers or CLI detection | 0 references | Grep for `autodev` returns no functional code hits |
| SC-003 | Existing behavior preserved | All tests pass | Run existing + new test suite |

## Assumptions

- `.generacy/config.yaml` already exists and has a working Zod schema that can be extended
- All defaults remain the same — this is a config location migration, not a behavior change

## Out of Scope

- Changing default values for any speckit configuration
- Migrating historical markdown files under `specs/`
- Renaming the `speckit` namespace itself

---

*Generated by speckit*
