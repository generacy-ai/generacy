# Feature Specification: Epic: generacy-ai/tetrad-development#85 | Phase: S6 | Tier: v1-delivery | Issue: G-S5

Extend `generacy setup build` Phase 4 to wire the cockpit slash commands the same way it wires spec-kit's

**Branch**: `816-epic-generacy-ai-tetrad` | **Date**: 2026-07-06 | **Status**: Draft

## Summary

Epic: generacy-ai/tetrad-development#85 | Phase: S6 | Tier: v1-delivery | Issue: G-S5

Extend `generacy setup build` Phase 4 to wire the cockpit slash commands the same way it wires spec-kit's. In packages/generacy/src/cli/commands/setup/build.ts (spec-kit block at ~348-355), add an equivalent block for @generacy-ai/claude-plugin-cockpit: same search-path pattern (generacyDir / agencyDir / SHARED_PACKAGES_DIR node_modules + `{npm root -g}`), source subdir commands/, target the /cockpit: command namespace (match however spec-kit commands acquire their /speckit: namespace). Package absent → the same non-fatal "not found — install it to enable cockpit commands" warning, not an error.

Owns (isolation): packages/generacy/src/cli/commands/setup/build.ts + its tests

Acceptance: with @generacy-ai/claude-plugin-cockpit installed globally, `generacy setup build` copies the six cockpit commands and /cockpit:* resolves in a fresh Claude Code session; without it, setup build completes with only the warning.

Depends on: A-S2 for the package name/layout (may merge in parallel; end-to-end verified in C-S1/T-S2) (see the epic checklist for issue numbers)

---
Part of the Epic Cockpit. Plan: docs/epic-cockpit-plan.md in tetrad-development (S6 / G-S5).


## User Stories

### US1: Developer bootstraps cockpit commands via `generacy setup build`

**As a** developer working on a Generacy epic,
**I want** `generacy setup build` to wire `/cockpit:*` slash commands into Claude Code alongside `/speckit:*`,
**So that** the cockpit developer-workflow commands (`breakdown`, `bug`, `clarify`, `file`, `merge`, `plan`, `queue`, `review`, `status`, `watch`) are immediately available in a fresh Claude Code session without any per-user manual step.

**Acceptance Criteria**:
- [ ] With `@generacy-ai/claude-plugin-cockpit` installed (locally, in `SHARED_PACKAGES_DIR`, or globally), `generacy setup build` copies the cockpit command files to the same destination Phase 4 uses for spec-kit commands.
- [ ] The copied commands resolve as `/cockpit:<name>` in a fresh Claude Code session using the same namespace mechanism spec-kit uses for `/speckit:<name>`.
- [ ] The resolver walks the same tier order as `resolveSpeckitCommandsDir`: `generacyDir` → `agencyDir` → `SHARED_PACKAGES_DIR/node_modules` → `{npm root -g}`.
- [ ] Structured `logger.info` line records the resolved cockpit commands path and file count on success (matching the spec-kit log line shape).
- [ ] Phase 4 continues to install spec-kit and Agency MCP unchanged when cockpit is or is not present.

### US2: Cockpit absence degrades gracefully

**As a** developer on a machine that has not installed `@generacy-ai/claude-plugin-cockpit`,
**I want** `generacy setup build` to complete with a single non-fatal warning listing the paths it checked,
**So that** setup does not fail and I can decide whether to install the package.

**Acceptance Criteria**:
- [ ] Absence of `@generacy-ai/claude-plugin-cockpit` at every tier produces exactly one warning-level (not error) log line, worded like the spec-kit "not found — install it to enable ... commands" line.
- [ ] The warning enumerates the same four tier paths that were checked (matching the spec-kit error's `checkedPaths` shape).
- [ ] `generacy setup build` exits successfully (non-zero exit only on unrelated failures).

## Functional Requirements

| ID    | Requirement | Priority | Notes |
|-------|-------------|----------|-------|
| FR-001 | Add a `resolveCockpitCommandsDir(config)` helper mirroring `resolveSpeckitCommandsDir` (build.ts ~271-315) but targeting package `@generacy-ai/claude-plugin-cockpit` with source subdir `commands/`. | P1 | Same 4-tier search order and same structured `logger.info` lines. |
| FR-002 | In `installClaudeCodeIntegration` (build.ts ~322-356), after the existing spec-kit block (~328-356), add an analogous block that resolves cockpit commands and copies `.md` files into the cockpit namespace destination. | P1 | Must sit inside Phase 4, not create a new phase. |
| FR-003 | The destination path/method must match whatever mechanism causes `/speckit:*` namespaced resolution today. | P1 | Namespace mechanism ambiguous in current code; see Assumptions. Candidate for `/clarify`. |
| FR-004 | Cockpit absence must produce a non-fatal warning (not `logger.error` at fatal level; not thrown), matching the wording style of the existing spec-kit branch. | P1 | Behavioral parity requirement from the issue. |
| FR-005 | Cockpit resolution and copy failure must not prevent the subsequent Agency MCP configuration step from running. | P1 | Phase 4's remaining Agency MCP work continues regardless. |
| FR-006 | Tests in `packages/generacy/src/cli/commands/setup/build.test.ts` (or peer) cover: (a) resolution from each of the 4 tiers, (b) copy success with file count assertion, (c) absent-package warning path, (d) presence of both `/speckit:*` and `/cockpit:*` after a combined run. | P1 | Owned scope per the issue: `build.ts + its tests`. |
| FR-007 | No other files or packages are modified. | P1 | Isolation boundary. |

## Success Criteria

| ID    | Metric | Target | Measurement |
|-------|--------|--------|-------------|
| SC-001 | Cockpit commands available after fresh `generacy setup build` on a machine with the plugin installed. | 100% of the cockpit `commands/*.md` files copied; each resolves as `/cockpit:<name>` in a new Claude Code session. | Manual verification in a fresh session; test assertion counts installed files against source. |
| SC-002 | Setup does not fail when the plugin is absent. | `generacy setup build` exits 0 and emits exactly one non-fatal warning naming the checked paths. | Automated test that stubs all 4 tiers as missing. |
| SC-003 | Spec-kit behavior is unchanged. | Zero regressions to `/speckit:*` resolution or Agency MCP setup. | Existing spec-kit and MCP tests continue to pass without modification. |
| SC-004 | Cockpit and spec-kit blocks stay structurally symmetric. | Cockpit block reuses the same tier order, same logger call shape, same absent-package wording pattern. | Code review checklist; diff comparison of the two blocks. |

## Assumptions

- The `/speckit:*` and `/cockpit:*` namespaces are provided by Claude Code's plugin discovery (see the sibling `.claude-plugin/plugin.json` files in `@generacy-ai/claude-plugin-agency-spec-kit` and `@generacy-ai/claude-plugin-cockpit`) rather than by any prefix logic in `build.ts` itself. The current spec-kit block simply copies files into `~/.claude/commands/`; the cockpit block should use the same target mechanism.
- The cockpit `commands/` directory ships with 10 `.md` files at time of writing (`breakdown`, `bug`, `clarify`, `file`, `merge`, `plan`, `queue`, `review`, `status`, `watch`). The issue references "six cockpit commands"; the implementation must copy whatever `.md` files are present, not a hard-coded count.
- `SHARED_PACKAGES_DIR` and `resolveNpmGlobalRoot()` are already exported from `build.ts` and reusable by the new resolver.
- The dependency on A-S2 (package name/layout for `@generacy-ai/claude-plugin-cockpit`) is satisfied — the package exists at `/workspaces/agency/packages/claude-plugin-cockpit` with `commands/` populated.

## Out of Scope

- Changing the destination directory or namespace mechanism for spec-kit commands.
- Publishing or versioning `@generacy-ai/claude-plugin-cockpit` (owned by A-S2).
- End-to-end verification across the epic (owned by C-S1/T-S2).
- Any change to Agency MCP wiring in Phase 4.
- Files outside `packages/generacy/src/cli/commands/setup/build.ts` and its tests.

---

*Generated by speckit*
