# Tasks: Wire cockpit slash commands in `generacy setup build`

**Input**: Design documents from `/specs/816-epic-generacy-ai-tetrad/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/cockpit-copy-block.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

All tasks touch only `packages/generacy/src/cli/commands/setup/build.ts` and its co-located tests at `packages/generacy/src/__tests__/setup/build.test.ts` (FR-007 / SC-005 isolation).

## Phase 1: Baseline

- [X] **T001** Read `packages/generacy/src/cli/commands/setup/build.ts` and locate the anchor points:
  - `resolveSpeckitCommandsDir` (~lines 278-315) — the resolver to mirror.
  - `SHARED_PACKAGES_DIR` constant (~line 268) — reused as-is.
  - `resolveNpmGlobalRoot()` (~lines 255-261) — reused as-is.
  - spec-kit copy block inside `installClaudeCodeIntegration` (~lines 328-356) — the copy block to mirror.
  - Step 3 MCP-configuration block (~line 358+) — must still run after cockpit block.

- [X] **T002** Read `packages/generacy/src/__tests__/setup/build.test.ts` and locate:
  - The existing spec-kit resolver tests (structural template to mirror for cockpit resolver).
  - The `installClaudeCodeIntegration` tests exercising the spec-kit copy block (structural template to mirror for cockpit copy block).
  - The shared `fs`/`os`/`logger`/`child_process` mock harness (reuse as-is).

## Phase 2: Tests First (TDD)

Write these tests BEFORE implementation. They must fail against the current codebase (no cockpit resolver/block exists yet) and pass after Phase 3.

- [X] **T010** [US1] In `packages/generacy/src/__tests__/setup/build.test.ts`, add a `describe('resolveCockpitCommandsDir')` block with six cases (mirrors spec-kit resolver tests):
  - **T010.1** Tier-1a: only `<agencyDir>/packages/claude-plugin-cockpit/commands` exists → returns that path.
  - **T010.2** Tier-1b: only `<generacyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/commands` exists → returns that path.
  - **T010.3** Tier-1c: only `<agencyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/commands` exists → returns that path.
  - **T010.4** Tier-2: only `/shared-packages/node_modules/@generacy-ai/claude-plugin-cockpit/commands` exists → returns that path.
  - **T010.5** Tier-3: only `{npmRoot}/@generacy-ai/claude-plugin-cockpit/commands` exists (mock `execSafe`/`child_process` for `npm root -g`) → returns that path.
  - **T010.6** No path exists → returns `null`.

- [X] **T011** [US1] In the same test file, add tests for the cockpit copy branch inside `installClaudeCodeIntegration`:
  - **T011.1 (happy path)**: resolver returns a directory containing `a.md`, `b.md`, `c.md`, plus one non-`.md` file. Assert `mkdirSync` called with `join(home, '.claude', 'commands', 'cockpit')` and `{ recursive: true }`; assert `copyFileSync` called exactly three times with the correct src/dst pairs; assert `logger.info` called once with `{ count: 3, source, dest }` and message `'Copied cockpit command files'`.
  - **T011.2 (non-`.md` filter)**: resolver returns a directory with only `README.txt` → `copyFileSync` NOT called; `logger.info` called with `count: 0`.
  - **T011.3 (absent branch)**: resolver returns `null` → `logger.warn` called exactly once with the byte-exact message `'@generacy-ai/claude-plugin-cockpit not found — install it locally or globally to enable cockpit commands'` and `checkedPaths` array with exactly these five entries in order:
    1. `<agencyDir>/packages/claude-plugin-cockpit/commands`
    2. `<generacyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/commands`
    3. `<agencyDir>/node_modules/@generacy-ai/claude-plugin-cockpit/commands`
    4. `/shared-packages/node_modules/@generacy-ai/claude-plugin-cockpit/commands`
    5. `'{npm root -g}/@generacy-ai/claude-plugin-cockpit/commands'` (literal string).
  - **T011.4 (absent branch does not error)**: `logger.error` NOT called by cockpit block.

- [X] **T012** [US1] Add isolation/coexistence tests:
  - **T012.1**: With both spec-kit and cockpit resolvers returning paths, spec-kit still copies to `~/.claude/commands/*.md` (top-level) unchanged; cockpit copies to `~/.claude/commands/cockpit/*.md`. No cross-overwrite.
  - **T012.2**: With cockpit resolver returning `null` but spec-kit present, spec-kit block still runs and Step 3 MCP configuration still executes.
  - **T012.3**: With spec-kit resolver returning `null` but cockpit present, cockpit block still runs and Step 3 MCP configuration still executes (FR-005).

- [X] **T013** [US1] Run `pnpm --filter @generacy-ai/generacy test build.test` (or repo-standard `vitest` invocation) and confirm all new tests in T010–T012 fail (implementation not yet added). Baseline for TDD.

## Phase 3: Implementation

- [X] **T020** [US1] In `packages/generacy/src/cli/commands/setup/build.ts`, add `resolveCockpitCommandsDir(config: BuildConfig): string | null` immediately after `resolveSpeckitCommandsDir`. Mirror its 4-tier structure exactly, substituting:
  - Package scope+name → `@generacy-ai/claude-plugin-cockpit`.
  - Tier-1 workspace source dir → `join(config.agencyDir, 'packages', 'claude-plugin-cockpit', 'commands')`.
  - Tier-1b/1c/2/3 → `join(<base>, 'node_modules', '@generacy-ai', 'claude-plugin-cockpit', 'commands')`.
  - `logger.info` tier-identifying log line matches the spec-kit resolver's shape.

- [X] **T021** [US1] In `installClaudeCodeIntegration`, insert the cockpit copy block immediately after the spec-kit block (~line 356), before Step 3. Structure:
  ```ts
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
  Use `logger.warn` (NOT `logger.error`) per FR-004. Message string is byte-for-byte (U+2014 EM DASH).

- [X] **T022** [US1] Run the new tests from T010–T012 and confirm they now pass. Iterate until green.

## Phase 4: Validation & Isolation Check

- [X] **T030** Run the full `build.test.ts` suite and confirm all pre-existing spec-kit tests still pass (regression guard).

- [X] **T031** Run type-check (`pnpm --filter @generacy-ai/generacy typecheck` or repo standard) and lint. Fix any issues.

- [X] **T032** Run `git diff --name-only develop...HEAD` and confirm only these two paths appear (SC-005 isolation):
  - `packages/generacy/src/cli/commands/setup/build.ts`
  - `packages/generacy/src/__tests__/setup/build.test.ts`

- [X] **T033** Byte-diff the spec-kit block (~lines 328-356 pre-change) against the post-change file to confirm it is byte-identical (FR-007 / SC-004). One-liner: verify the lines in the pre-change hunk appear verbatim in the post-change file.

## Dependencies & Execution Order

- **Phase 1 (T001–T002)** — sequential; both are read-only baseline. May run in either order but must complete before Phase 2.
- **Phase 2 (T010–T013)** — TDD gate. T010, T011, T012 edit the same test file; do them sequentially (or as one batched edit) but before T013. T013 (baseline run) must confirm failure before Phase 3.
- **Phase 3 (T020–T022)** — T020 and T021 edit the same `build.ts`; sequential. T022 depends on both.
- **Phase 4 (T030–T033)** — post-implementation validation; T030 can run in parallel with T031 [P]. T032 and T033 must run after implementation is complete.

Parallel opportunities are limited because the change is intentionally scoped to two files (isolation requirement).

## Suggested next step

Run `/speckit:implement` (or the equivalent implementation skill) to execute the tasks in order, starting with T001.

---

*Generated by /speckit:tasks — standard mode (fine-grained tasks)*
