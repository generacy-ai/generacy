# Implementation Plan: Wire cockpit slash commands in `generacy setup build`

**Feature**: Extend `generacy setup build` Phase 4 to copy `@generacy-ai/claude-plugin-cockpit` command `.md` files into `~/.claude/commands/cockpit/`, mirroring the existing spec-kit block.
**Branch**: `816-epic-generacy-ai-tetrad`
**Status**: Complete

## Summary

Add a cockpit-plugin copy block to `installClaudeCodeIntegration` in `packages/generacy/src/cli/commands/setup/build.ts`. The block is a near-clone of the existing spec-kit block (lines ~328-356) with four axes of difference: package name (`@generacy-ai/claude-plugin-cockpit`), tier-1 workspace source path (`packages/claude-plugin-cockpit/commands`), destination subdirectory (`~/.claude/commands/cockpit/`), and log level for the "not found" branch (`logger.warn` instead of `logger.error`).

The subdirectory placement leverages Claude Code's documented convention (`commands/<ns>/<name>.md` → `/<ns>:<name>`) to produce the `/cockpit:` prefix at runtime without touching the spec-kit block. Filename collisions between the two plugins (`clarify.md`, `plan.md`) are sidestepped by the subdirectory boundary.

Non-goals: modifying the spec-kit block, marketplace-registering the cockpit plugin, changes to the cockpit package itself, live-Claude verification (owned by other issues in the epic).

## Technical Context

- **Language**: TypeScript (Node >=22, ESM).
- **Module under test**: `packages/generacy/src/cli/commands/setup/build.ts`.
- **Test framework**: Vitest, co-located at `packages/generacy/src/__tests__/setup/build.test.ts`.
- **Runtime dependencies**: `node:fs` (`existsSync`, `mkdirSync`, `readdirSync`, `copyFileSync`), `node:os` (`homedir`), `node:path` (`join`). All already imported by `build.ts`. **No new dependencies.**
- **Logger**: `getLogger()` from `../../utils/logger.js` (pino). Existing pattern.
- **Helpers reused as-is**: `resolveNpmGlobalRoot()` (build.ts:255), `SHARED_PACKAGES_DIR` constant (build.ts:268).
- **Config surface**: `BuildConfig` type (build.ts:24) — no new fields required.

## Project Structure

```
packages/generacy/src/
├── cli/
│   └── commands/
│       └── setup/
│           └── build.ts                    # MODIFIED — add resolver + copy block
└── __tests__/
    └── setup/
        └── build.test.ts                   # MODIFIED — mirror spec-kit tests
```

**Files touched**: exactly two, per FR-007/SC-005.

## Design

### Resolver: `resolveCockpitCommandsDir(config: BuildConfig): string | null`

Mirror of `resolveSpeckitCommandsDir` (build.ts:278-315) with substitutions:

| Axis | spec-kit | cockpit |
|---|---|---|
| Package scope+name | `@generacy-ai/agency-plugin-spec-kit` | `@generacy-ai/claude-plugin-cockpit` |
| Tier-1 workspace source dir | `<agencyDir>/packages/agency-plugin-spec-kit/commands` | `<agencyDir>/packages/claude-plugin-cockpit/commands` |
| Tier-1 node_modules (generacy) | `<generacyDir>/node_modules/<pkgSubpath>` | same shape, cockpit pkgSubpath |
| Tier-1 node_modules (agency) | `<agencyDir>/node_modules/<pkgSubpath>` | same shape, cockpit pkgSubpath |
| Tier-2 shared volume | `/shared-packages/node_modules/<pkgSubpath>` | same shape, cockpit pkgSubpath |
| Tier-3 npm global | `{npm root -g}/<pkgSubpath>` | same shape, cockpit pkgSubpath |

Where `pkgSubpath = join('@generacy-ai', 'claude-plugin-cockpit', 'commands')`.

Return the first path that `existsSync` reports true; else `null`.

### Copy block (inside `installClaudeCodeIntegration`)

Placed **immediately after** the spec-kit block (before Step 3 MCP configuration) so ordering intent is preserved and MCP still runs.

```
const cockpitCommandsDir = resolveCockpitCommandsDir(config);
if (cockpitCommandsDir) {
  const userCockpitDir = join(home, '.claude', 'commands', 'cockpit');
  mkdirSync(userCockpitDir, { recursive: true });
  const files = readdirSync(cockpitCommandsDir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    copyFileSync(join(cockpitCommandsDir, file), join(userCockpitDir, file));
  }
  logger.info(
    { count: files.length, source: cockpitCommandsDir, dest: userCockpitDir },
    'Copied cockpit command files',
  );
} else {
  logger.warn(
    {
      checkedPaths: [
        join(config.agencyDir, 'packages', 'claude-plugin-cockpit', 'commands'),
        join(config.generacyDir, 'node_modules', '@generacy-ai', 'claude-plugin-cockpit', 'commands'),
        join(config.agencyDir, 'node_modules', '@generacy-ai', 'claude-plugin-cockpit', 'commands'),
        join(SHARED_PACKAGES_DIR, 'node_modules', '@generacy-ai', 'claude-plugin-cockpit', 'commands'),
        '{npm root -g}/@generacy-ai/claude-plugin-cockpit/commands',
      ],
    },
    '@generacy-ai/claude-plugin-cockpit not found — install it locally or globally to enable cockpit commands',
  );
}
```

Message string is byte-for-byte per Q4/FR-004. `logger.warn` (not `error`) per Q2/FR-004.

### Behavioral invariants

- Spec-kit block is untouched byte-for-byte (verified by `git diff` in review).
- The cockpit block never short-circuits on spec-kit absence and vice-versa (FR-005). Since neither reads the other's result, this is inherent — no explicit guard needed.
- Filename collisions across plugins do not overwrite one another: spec-kit copies to `~/.claude/commands/*.md`; cockpit copies to `~/.claude/commands/cockpit/*.md`. Different parent dirs.
- MCP configuration (Step 3, build.ts:358+) still runs after both blocks.

## Constitution Check

No `.specify/memory/constitution.md` in the repository at time of planning (only `templates/` sub-directory exists under `.specify/`). No project-level governance principles apply. The change conforms to the general repository conventions:

- ESM module boundaries preserved.
- No cross-package coupling introduced.
- Fail-open for optional dependency: absent package → warning, not error, per FR-004.
- Deterministic string outputs → assertable in tests.

## Test Plan (referenced, tasks generated separately)

- **Positive (resolver, tier by tier)**: For each of the four resolvable tiers (workspace source dir, generacy/agency `node_modules`, shared packages volume, npm global), mock `existsSync` so only the tier under test returns true and assert the resolver returns that path.
- **Negative (resolver)**: All checked paths absent → resolver returns `null`; `resolveNpmGlobalRoot()` failure gracefully handled.
- **Copy block (happy path)**: With resolver returning a directory of `.md` + non-`.md` files, assert `mkdirSync` called with the `cockpit/` subdirectory and `{ recursive: true }`, `copyFileSync` called once per `.md` file with correct src/dst paths, and `logger.info` called with `{ count, source, dest }`.
- **Copy block (absent)**: Resolver returns `null` → assert `logger.warn` called once with the exact message and `checkedPaths` array of five entries; assert `logger.error` NOT called by cockpit block (spec-kit block's error line, if triggered by its own resolver, is not the subject of these assertions).
- **Isolation**: Assert spec-kit `~/.claude/commands/*.md` writes still happen; assert MCP configuration still executes.
- **Symmetry**: Test file mirrors the shape/naming of spec-kit's existing tests (SC-004).

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Claude Code's subdirectory convention changes or is misdescribed. | Q1 answer cites the documented convention; end-to-end verification is owned by C-S1/T-S2 (out of scope here). |
| Silent overwrite if a future spec-kit release ships a `cockpit/` sub-directory. | Vanishingly unlikely (different owners); would only affect `~/.claude/commands/cockpit/`, still recoverable. |
| Wording drift in the warn message (breaks SC-002 log assertion). | Test asserts the exact byte-for-byte string. |
| Log-level asymmetry between blocks confuses reviewers. | Assumption noted in spec; alignment is a follow-up per Q2 answer. |

## Rollout

- Landable independently. No env-var flag or migration.
- Behavior is additive: on clusters without the cockpit package installed, one new `logger.warn` line appears — no other change.
- Reversible: `git revert` restores prior behavior; copied files at `~/.claude/commands/cockpit/*.md` remain but stop refreshing.

## Dependencies

- **A-S2** (upstream, may land in parallel): defines the `@generacy-ai/claude-plugin-cockpit` package layout under `packages/claude-plugin-cockpit/commands`. This plan assumes A-S2's chosen layout matches spec-kit's (`commands/*.md`, flat). If A-S2 diverges, the resolver's tier-1 source path and the `.md` filter would need adjustment.
- **C-S1 / T-S2** (downstream): live Claude Code end-to-end verification.
