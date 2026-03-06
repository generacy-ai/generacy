# Implementation Plan: Remove hardcoded tetrad-development bootstrap fallback

**Feature**: Make `generacy setup workspace` discover config from any mounted project, not just tetrad-development
**Branch**: `333-problem-generacy-setup`
**Status**: Complete

## Summary

Remove all `tetrad-development`-specific hardcoding from `generacy setup workspace`. Replace the hardcoded config path and bootstrap fallback with a generic config discovery strategy that scans `workdir` subdirectories for `.generacy/config.yaml`. Add a `--config` CLI flag / `CONFIG_PATH` env var for explicit override. Fail with a clear error when no config is found.

This aligns with the design established in issue #291: the config file is the sole source of truth, no hardcoded repo lists.

## Technical Context

| Aspect | Details |
|--------|---------|
| Language | TypeScript 5.4 |
| Framework | Commander (CLI), Zod (validation) |
| Packages | `@generacy-ai/config`, `@generacy-ai/generacy` |
| Test Framework | Vitest |
| Key Files | `packages/generacy/src/cli/commands/setup/workspace.ts`, `packages/config/src/loader.ts` |

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Add `--config` flag + `CONFIG_PATH` env var | Explicit is better than implicit; gives callers full control |
| D2 | Scan `workdir` subdirectories as fallback | Discovers config in any mounted project (e.g., `/workspaces/my-project/.generacy/config.yaml`) |
| D3 | Fail with clear error when no config found | Per #291 design — no silent bootstrap, no hardcoded repos |
| D4 | Remove ALL tetrad-development-specific code | Clean break: Phase 2 bootstrap logic, repo ordering priority, bootstrap repoSource — all removed |
| D5 | Add `scanForWorkspaceConfig()` in config package | Reusable config discovery; keeps loader concerns in the config package |

## Clarification Answers (Assumed)

The clarifications in `clarifications.md` are pending. This plan assumes:

- **Q1 (Config discovery)**: Option D — try `--config`/env first, then scan `workdir` subdirectories as fallback
- **Q2 (Multiple configs)**: Option B — fail with error listing all found configs, require `--config` to disambiguate
- **Q3 (Scope of removal)**: Option A — remove all tetrad-development-specific code (clean break)

## Project Structure (Changed Files)

```text
packages/
├── config/
│   └── src/
│       ├── loader.ts                          # ADD: scanForWorkspaceConfig()
│       └── index.ts                           # EXPORT: new function
└── generacy/
    └── src/
        └── cli/
            └── commands/
                └── setup/
                    ├── workspace.ts            # MODIFY: new config resolution
                    └── __tests__/
                        └── workspace.test.ts   # MODIFY: update test cases
```

## Implementation Steps

### Step 1: Add `scanForWorkspaceConfig()` to config package

**File**: `packages/config/src/loader.ts`

Add a new function that scans immediate subdirectories of a given directory for `.generacy/config.yaml`:

```typescript
/**
 * Scan immediate subdirectories of `parentDir` for a workspace config file.
 * Returns all found config paths (caller decides how to handle multiples).
 */
export function scanForWorkspaceConfig(
  parentDir: string,
  configDirName = '.generacy',
  configFileName = 'config.yaml',
): string[] {
  const entries = readdirSync(parentDir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(parentDir, entry.name, configDirName, configFileName);
    if (existsSync(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}
```

**File**: `packages/config/src/index.ts`

Export the new function.

### Step 2: Rewrite `resolveWorkspaceConfig()` in workspace.ts

**File**: `packages/generacy/src/cli/commands/setup/workspace.ts`

Replace the current config resolution logic (lines 39-97) with:

1. **Priority 1**: CLI `--repos` flag → use those repos directly
2. **Priority 2**: `REPOS` env var → use those repos directly
3. **Priority 3**: `--config` flag / `CONFIG_PATH` env var → load that specific config file
4. **Priority 4**: `scanForWorkspaceConfig(workdir)` → discover config from mounted projects
5. **No config found** → fail with clear error message

Changes to the `WorkspaceConfig` interface:
- Remove `'bootstrap (config not found)'` from `repoSource` union type
- Add `'config file (explicit)'` and `'config file (discovered)'` variants (or keep single `'config file'`)

Add `--config` option to Commander:
```typescript
.option('--config <path>', 'Path to .generacy/config.yaml (or CONFIG_PATH env)')
```

Error when no config found:
```typescript
logger.error(
  'No .generacy/config.yaml found. Provide one via --config, CONFIG_PATH env, ' +
  'or ensure a project with .generacy/config.yaml is mounted under ' + workdir
);
process.exit(1);
```

Error when multiple configs found:
```typescript
logger.error(
  { configs: foundPaths },
  'Multiple .generacy/config.yaml files found. Use --config or CONFIG_PATH to specify which one.'
);
process.exit(1);
```

### Step 3: Remove tetrad-development-specific code

**File**: `packages/generacy/src/cli/commands/setup/workspace.ts`

Remove entirely:
- **Lines 62-74**: Hardcoded `tetrad-development` config path and bootstrap fallback
- **Lines 285-289**: Repo ordering that prioritizes `tetrad-development`
- **Lines 301-340**: Phase 2 bootstrap logic (re-read config after cloning tetrad-development)

### Step 4: Update tests

**File**: `packages/generacy/src/cli/commands/setup/__tests__/workspace.test.ts`

Tests to **remove**:
- `bootstrap mode clones only tetrad-development when no config found and no overrides` (line 196)
- `two-phase clone: bootstraps tetrad-development, then clones additional repos from config` (line 209)
- `two-phase clone does not re-clone tetrad-development in phase 2` (line 235)
- `bootstrap warns when no config found after cloning tetrad-development` (line 314)

Tests to **add**:
- `--config flag loads config from specified path`
- `CONFIG_PATH env var loads config from specified path`
- `--config overrides CONFIG_PATH env var`
- `discovers config from workdir subdirectory when no explicit config`
- `fails with error when no config found anywhere`
- `fails with error when multiple configs found in workdir subdirectories`
- `--config resolves ambiguity when multiple configs exist`

Tests to **update**:
- `config file is used when no CLI flag and no REPOS env var` — mock `scanForWorkspaceConfig` instead of `tryLoadWorkspaceConfig` with hardcoded path

## Verification

1. All existing tests pass (after updates)
2. New test cases cover the config discovery flow
3. `pnpm build` succeeds for both packages
4. Manual test: mount a project with `.generacy/config.yaml` under `/workspaces/` and run `generacy setup workspace`

---

*Generated by speckit*
