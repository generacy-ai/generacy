# Research: CLI Package Skeleton & Cluster Registry

**Feature**: #493 — CLI skeleton with placeholder subcommands and cluster registry

## Technology Decisions

### 1. Commander.js for CLI framework

**Decision**: Use the existing Commander.js (^12.0.0) already in the package.

**Rationale**: Already the CLI framework for `@generacy-ai/generacy`. 8 commands are registered. Adding 11 placeholder commands follows the established pattern. No reason to introduce a second CLI library.

**Alternatives considered**:
- **yargs**: More opinionated, would require rewriting existing commands. Rejected.
- **clipanion**: Used by Yarn; heavier, no benefit for simple placeholders. Rejected.
- **oclif**: Framework-level CLI toolkit; overkill for this use case. Rejected.

### 2. Atomic file writes via tmp+rename

**Decision**: Write to `clusters.json.tmp`, then `rename()` over the target.

**Rationale**: Standard POSIX atomic write pattern. `rename()` is atomic on the same filesystem. No external dependencies needed. The CLI is single-user, so advisory file locking (as used in `credhelper-daemon`'s `file-store.ts`) is unnecessary overhead.

**Alternatives considered**:
- **fd-based advisory locking** (as in `file-store.ts`): Heavier; needed for daemon with concurrent access, not for CLI. Rejected.
- **write-file-atomic npm package**: Adds a dependency for something achievable in ~5 lines. Rejected.
- **Direct `writeFile()`**: Not atomic; crash mid-write corrupts file. Rejected.

### 3. Zod for registry schema validation

**Decision**: Use Zod (^3.23.0, already in deps) for `clusters.json` schema.

**Rationale**: Consistent with the codebase pattern (credhelper uses Zod schemas, cluster-relay messages validated with Zod). Provides runtime validation on load, failing gracefully to an empty registry on corruption.

### 4. Node version check location

**Decision**: Perform the check in `bin/generacy.js` before any ESM imports.

**Rationale**: If the version check runs inside TypeScript source, Node might fail during module resolution (e.g., missing built-in APIs) before reaching the check. Placing it in the JS entry point with a synchronous `process.versions.node` comparison ensures it runs first.

**Implementation detail**: The check must use CommonJS-compatible syntax within the `#!/usr/bin/env node` script. However, since the package is `"type": "module"`, the entry point is already ESM. The version check will be a top-level statement before the dynamic `import()`.

### 5. Single file for placeholder commands

**Decision**: All 11 placeholder commands defined in one `placeholders.ts` file using a data-driven array.

**Rationale**: Each placeholder is identical except for name, description, and phase string. A separate file per placeholder would create 11 nearly-identical files. A data-driven approach keeps it DRY and makes adding/removing placeholders trivial.

### 6. Registry directory location

**Decision**: `~/.generacy/clusters.json` using `os.homedir()`.

**Rationale**: Standard XDG-like user config location. `~/.generacy/` is already the implied config directory for the CLI. Using `$XDG_CONFIG_HOME/generacy/` was considered but rejected for simplicity — the spec explicitly says `~/.generacy/clusters.json`.

### 7. Publishing pipeline

**Decision**: Use the existing changeset-based pipeline. No new `cli-v*` tag workflow.

**Rationale**: Per clarification Q1, the CLI lives in the existing `packages/generacy` package which already publishes via `publish-preview.yml` + `pnpm changeset version --snapshot`. Adding a separate publish workflow would create version drift between CLI and library exports.

## Implementation Patterns

### Placeholder Command Pattern
```typescript
// Data-driven: array of { name, description, phase } → map to Commander instances
const PLACEHOLDERS = [/* ... */];
export function placeholderCommands(): Command[] {
  return PLACEHOLDERS.map(def => {
    const cmd = new Command(def.name)
      .description(def.description)
      .allowUnknownOption(true)
      .action(() => {
        console.log(`"${def.name}" is not yet implemented in this preview — landing in a future v1.5 ${def.phase} issue.`);
      });
    return cmd;
  });
}
```

### Registry Atomic Write Pattern
```typescript
// Same pattern used in credhelper-daemon's file-store.ts, simplified (no locking)
const tmpPath = registryPath + '.tmp';
await writeFile(tmpPath, content, 'utf-8');
// fsync not strictly needed for single-user CLI, but rename() is atomic
await rename(tmpPath, registryPath);
```

### Longest-Prefix-Match Pattern
```typescript
// Filter clusters whose path is a prefix of cwd, return the deepest match
for (const cluster of registry.clusters) {
  const p = resolve(cluster.path);
  if (cwd === p || cwd.startsWith(p + '/')) {
    if (p.length > bestLen) { best = cluster; bestLen = p.length; }
  }
}
```

## Key Sources / References

- **Existing CLI**: `packages/generacy/src/cli/index.ts` — Commander.js setup pattern
- **Existing logger**: `packages/generacy/src/cli/utils/logger.ts` — Pino configuration
- **Atomic write reference**: `packages/credhelper-daemon/src/backends/file-store.ts` — tmp+fsync+rename pattern
- **Zod schema reference**: `packages/cluster-relay/src/messages.ts` — discriminated union validation
- **Clarifications**: `specs/493-context-v1-5-introduces/clarifications.md` — Q1 (publishing), Q2 (placeholder behavior), Q3 (prefix matching)

---

*Generated by speckit*
