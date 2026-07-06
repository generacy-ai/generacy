# Contract: Cockpit copy block in `installClaudeCodeIntegration`

Defines the observable behavior of the cockpit-plugin copy block added to `build.ts`. Consumed by the acceptance tests generated in the tasks phase.

## Function contract

### `resolveCockpitCommandsDir(config: BuildConfig): string | null`

**Input**: `BuildConfig` (existing shape).

**Behavior**:
1. Check `<agencyDir>/packages/claude-plugin-cockpit/commands` — if exists, return it.
2. Check `<generacyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/commands` — if exists, return it.
3. Check `<agencyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/commands` — if exists, return it.
4. Check `/shared-packages/node_modules/@generacy-ai/claude-plugin-cockpit/commands` — if exists, return it.
5. Query `npm root -g`; if that succeeds, check `<root>/@generacy-ai/claude-plugin-cockpit/commands` — if exists, return it.
6. Otherwise return `null`.

**Purity**: Reads `existsSync` and shells to `npm root -g` via `execSafe`. No writes.

**Logging**: On resolution, emits one `logger.info` line naming the tier the path was resolved from. On non-resolution, does not log (caller logs).

## Copy-block contract

### When resolver returns a path

**Precondition**: `resolveCockpitCommandsDir(config)` returned a non-null string `P`.

**Behavior**:
1. Compute `dest = join(homedir(), '.claude', 'commands', 'cockpit')`.
2. `mkdirSync(dest, { recursive: true })`.
3. `files = readdirSync(P).filter(f => f.endsWith('.md'))`.
4. For each `file` in `files`, `copyFileSync(join(P, file), join(dest, file))`.
5. Emit `logger.info({ count: files.length, source: P, dest }, 'Copied cockpit command files')`.

**Postconditions**:
- `dest` exists as a directory.
- For every `.md` file in `P`, a byte-identical copy exists at `<dest>/<basename>`.
- No writes outside `dest`.
- No writes to `~/.claude/commands/*.md` (top-level) — that path is spec-kit's.

### When resolver returns `null`

**Behavior**:
1. Emit `logger.warn({ checkedPaths: [...] }, '@generacy-ai/claude-plugin-cockpit not found — install it locally or globally to enable cockpit commands')`.
2. Execution continues past the block. `installClaudeCodeIntegration` proceeds to Step 3 (MCP configuration).

**Message**: exact string `@generacy-ai/claude-plugin-cockpit not found — install it locally or globally to enable cockpit commands` (U+2014 EM DASH between `found` and `install`).

**`checkedPaths` array** (exact contents, order-sensitive):

```
[
  "<agencyDir>/packages/claude-plugin-cockpit/commands",
  "<generacyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/commands",
  "<agencyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/commands",
  "/shared-packages/node_modules/@generacy-ai/claude-plugin-cockpit/commands",
  "{npm root -g}/@generacy-ai/claude-plugin-cockpit/commands"
]
```

The literal `{npm root -g}` string is used regardless of whether `resolveNpmGlobalRoot()` succeeded — this mirrors the spec-kit block.

**Postconditions**:
- No `logger.error` call from the cockpit block.
- No `logger.warn` calls other than the one specified.
- `~/.claude/commands/cockpit/` may or may not exist after the block runs (no `mkdirSync` in the absent branch); tests should not assert on its state in this branch.

## Isolation contract

- No file outside `packages/generacy/src/cli/commands/setup/build.ts` and `packages/generacy/src/__tests__/setup/build.test.ts` is modified.
- The spec-kit block (`build.ts` ~lines 328-356 pre-change) is byte-identical after the change.
- The Step 3 MCP-configuration block (`build.ts` ~line 358+) is byte-identical after the change and still executes.

## Test surface

Assertions the acceptance tests must make:

| Assertion | Notes |
|---|---|
| Resolver returns tier-1a path when only workspace source dir exists. | `existsSync` mock returns true only for the workspace path. |
| Resolver returns tier-1b path when only `generacyDir` node_modules exists. | |
| Resolver returns tier-1c path when only `agencyDir` node_modules exists. | |
| Resolver returns tier-2 path when only shared-packages path exists. | |
| Resolver returns tier-3 path when only npm-global path exists. | Also mock `execSafe`/`execSync` for `npm root -g`. |
| Resolver returns `null` when no path exists. | |
| Copy block calls `mkdirSync` with the `cockpit/` subdir and `{ recursive: true }`. | Present-path case. |
| Copy block calls `copyFileSync` once per `.md` file, correct src/dst. | |
| Copy block filters out non-`.md` files. | |
| Copy block emits one `logger.info` with `{ count, source, dest }` and the exact message. | |
| Absent-path branch emits exactly one `logger.warn` with the exact message and 5-element `checkedPaths`. | |
| Absent-path branch does not call `logger.error`. | |
| Both branches allow Step 3 (MCP configuration) to execute. | |
| Spec-kit block behavior is unchanged: still copies to `~/.claude/commands/*.md` (top-level). | Cross-check against pre-existing tests. |
