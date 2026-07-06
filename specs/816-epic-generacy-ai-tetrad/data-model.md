# Data Model: Wire cockpit slash commands in `generacy setup build`

This change introduces **no new persistent data model**, **no new configuration surface**, and **no new schemas**. It is a mechanical mirror of the existing spec-kit copy block against a different npm package name and a different destination subdirectory.

The types below describe the internal function contracts and file-system artifacts touched by the change, for reference during implementation and testing.

## Types (internal, TypeScript)

### `BuildConfig` (existing, unchanged)

Defined in `packages/generacy/src/cli/commands/setup/build.ts:24-32`.

```ts
interface BuildConfig {
  skipCleanup: boolean;
  skipAgency: boolean;
  skipGeneracy: boolean;
  agencyDir: string;    // consumed by resolver — tier-1 workspace path
  generacyDir: string;  // consumed by resolver — tier-1 node_modules
  latencyDir: string;
  latestPlugin: boolean;
}
```

The cockpit block reads only `agencyDir` and `generacyDir`. No new fields added.

### `resolveCockpitCommandsDir` (new)

```ts
function resolveCockpitCommandsDir(config: BuildConfig): string | null;
```

**Contract**:
- **Input**: `BuildConfig` with populated `agencyDir` and `generacyDir`.
- **Output**: absolute path (string) of the first existing directory in the 4-tier resolution order, or `null` if none exist.
- **Purity**: Reads `fs.existsSync` and shells out via `execSafe` (through `resolveNpmGlobalRoot`). No writes. No throws — `execSafe` swallows non-zero exits.
- **Side effects (logging only)**: On resolution, calls `logger.info(...)` with the chosen path and a tier-identifying message. On non-resolution, returns `null` without logging (the caller emits the `warn`).

### Resolution order (4-tier)

| Tier | Path | Behavior on match |
|---|---|---|
| 1a | `<agencyDir>/packages/claude-plugin-cockpit/commands` | Return path. |
| 1b | `<generacyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/commands` | Return path. |
| 1c | `<agencyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/commands` | Return path. |
| 2 | `/shared-packages/node_modules/@generacy-ai/claude-plugin-cockpit/commands` | Return path. |
| 3 | `{npm root -g}/@generacy-ai/claude-plugin-cockpit/commands` | Return path. |
| — | (none match) | Return `null`. |

Tier-1 paths are tried in the listed order (a → b → c). This exactly mirrors `resolveSpeckitCommandsDir`.

## File-system artifacts

### Read (via resolver)

- Any of the five paths above. Reads are `existsSync` only — content is only read via `readdirSync` after resolution.
- `readdirSync(commandsDir)` — filtered to entries ending in `.md`.

### Written (by copy block)

| Path | Operation | Mode |
|---|---|---|
| `~/.claude/commands/cockpit/` | `mkdirSync({ recursive: true })` | Default (respects umask). |
| `~/.claude/commands/cockpit/<name>.md` | `copyFileSync(source, dest)` — one per `.md` in source. | Preserved from source. |

**Not written**:
- Nothing in `~/.claude/commands/*.md` (top-level) — that path is owned by the spec-kit block.
- Nothing in `~/.claude/plugins/**` — marketplace registration is out of scope.
- Nothing in `~/.claude.json` — MCP configuration is Step 3, unchanged.

## Validation Rules

- **File filter**: only entries where `f.endsWith('.md')` are copied. Non-`.md` files in the source `commands/` directory are ignored (matches spec-kit's filter).
- **Idempotence**: `copyFileSync` overwrites the destination on each run — expected for `setup build` re-runs.
- **Directory guarantee**: `mkdirSync(..., { recursive: true })` ensures `~/.claude/commands/cockpit/` exists even on first run.
- **No collision with spec-kit**: The `cockpit/` subdirectory boundary guarantees no shared file namespace with spec-kit's flat top-level copy. Enforced structurally, not by check.

## Log-line contracts (assertable)

### On resolution (info)

```
{ count: <number>, source: <resolved-path>, dest: <userCockpitDir> }
"Copied cockpit command files"
```

### On absence (warn)

```
{
  checkedPaths: [
    "<agencyDir>/packages/claude-plugin-cockpit/commands",
    "<generacyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/commands",
    "<agencyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/commands",
    "/shared-packages/node_modules/@generacy-ai/claude-plugin-cockpit/commands",
    "{npm root -g}/@generacy-ai/claude-plugin-cockpit/commands",
  ]
}
"@generacy-ai/claude-plugin-cockpit not found — install it locally or globally to enable cockpit commands"
```

The message is a fixed string constant; the `checkedPaths` array contents are template-substituted from `BuildConfig`. Tests assert the exact message and the array shape.

## Relationships / Coupling

- **Upstream (data producer)**: A-S2 defines the `@generacy-ai/claude-plugin-cockpit` package's `commands/` directory contents. This module only reads that directory.
- **Downstream (data consumer)**: Claude Code's command loader reads `~/.claude/commands/cockpit/*.md` on session start and exposes them as `/cockpit:<name>` slash commands.
- **Adjacent**: The spec-kit block writes to `~/.claude/commands/*.md`; the MCP configuration writes to `~/.claude.json`. Both are unaffected by this change.
