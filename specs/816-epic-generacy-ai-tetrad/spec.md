# Feature Specification: Epic: generacy-ai/tetrad-development#85 | Phase: S6 | Tier: v1-delivery | Issue: G-S5

Extend `generacy setup build` Phase 4 to wire the cockpit slash commands the same way it wires spec-kit's

**Branch**: `816-epic-generacy-ai-tetrad` | **Date**: 2026-07-06 | **Status**: Draft

## Summary

Epic: generacy-ai/tetrad-development#85 | Phase: S6 | Tier: v1-delivery | Issue: G-S5

Extend `generacy setup build` Phase 4 to wire the cockpit slash commands the same way it wires spec-kit's. In `packages/generacy/src/cli/commands/setup/build.ts` (spec-kit block at ~348-355), add an equivalent block for `@generacy-ai/claude-plugin-cockpit`: same search-path pattern (generacyDir / agencyDir / SHARED_PACKAGES_DIR node_modules + `{npm root -g}`), source subdir `commands/`, target the `/cockpit:` command namespace via Claude Code's subdirectory convention (commands/<ns>/<name>.md → /<ns>:<name>). Package absent → the same non-fatal "not found — install it to enable cockpit commands" warning, not an error.

Owns (isolation): `packages/generacy/src/cli/commands/setup/build.ts` + its tests

Acceptance: with `@generacy-ai/claude-plugin-cockpit` installed globally, `generacy setup build` copies the six cockpit commands and `/cockpit:*` resolves in a fresh Claude Code session; without it, setup build completes with only the warning.

Depends on: A-S2 for the package name/layout (may merge in parallel; end-to-end verified in C-S1/T-S2) (see the epic checklist for issue numbers)

---
Part of the Epic Cockpit. Plan: docs/epic-cockpit-plan.md in tetrad-development (S6 / G-S5).


## User Stories

### US1: Cockpit slash commands available after setup

**As a** developer using a Generacy cluster,
**I want** `generacy setup build` to install the `@generacy-ai/claude-plugin-cockpit` slash commands into my Claude Code config,
**So that** I can invoke `/cockpit:<name>` (e.g. `/cockpit:watch`) in a fresh Claude Code session without any manual copy step.

**Acceptance Criteria**:
- [ ] With `@generacy-ai/claude-plugin-cockpit` installed (globally, in shared packages, or in a local/workspace `node_modules`), `generacy setup build` copies every `.md` file from the package's `commands/` directory into `~/.claude/commands/cockpit/`.
- [ ] After setup, a fresh Claude Code session resolves each command as `/cockpit:<name>` (Q1 mechanism: subdirectory namespacing).
- [ ] Copied cockpit commands do NOT overwrite spec-kit commands sharing the same base name (e.g. `clarify.md`, `plan.md`); collisions are prevented by the subdirectory placement.
- [ ] When the package is absent from every checked path, `generacy setup build` exits successfully (non-fatal) after emitting exactly one `logger.warn` line with the template-substituted message.
- [ ] The spec-kit block (~348-355) is not modified by this change (FR-007 isolation).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add a `resolveCockpitCommandsDir(config)` helper in `build.ts` that mirrors `resolveSpeckitCommandsDir`'s 4-tier order, substituting the package name `@generacy-ai/claude-plugin-cockpit` and (tier-1 source path) `packages/claude-plugin-cockpit/commands`. | P1 | Q3: keeps parity with spec-kit resolver so source-checkout dev clusters work identically. |
| FR-002 | In `installClaudeCodeIntegration`, add a new block (below the existing spec-kit block) that calls `resolveCockpitCommandsDir`, copies every `.md` file into `~/.claude/commands/cockpit/`, and logs a `count/source/dest` info line matching the spec-kit block's shape. | P1 | Q1 (B): subdirectory `cockpit/` under `~/.claude/commands/` yields `/cockpit:<name>` via Claude Code's documented convention and sidesteps name collisions with spec-kit. |
| FR-003 | Ensure `~/.claude/commands/cockpit/` exists before copying (`mkdirSync(..., { recursive: true })`). Each `.md` file from the source dir is copied verbatim to `~/.claude/commands/cockpit/<same-basename>.md`. | P1 | Filenames are preserved; namespacing comes from the parent directory, not from a filename prefix. |
| FR-004 | When `resolveCockpitCommandsDir` returns `null`, call `logger.warn(...)` (NOT `logger.error`) with the exact message: `"@generacy-ai/claude-plugin-cockpit not found — install it locally or globally to enable cockpit commands"` and a `checkedPaths` array listing the four checked paths (workspace source, generacy `node_modules`, agency `node_modules`, shared packages, `{npm root -g}`). Execution continues; setup exits successfully. | P1 | Q2 (A) + Q4 (A): explicit `logger.warn`; byte-for-byte template substitution of the spec-kit message. |
| FR-005 | The cockpit block runs independently of the spec-kit block: spec-kit absent + cockpit present, or vice-versa, both succeed. Neither block short-circuits the other. | P1 | Preserves existing spec-kit behavior. |
| FR-006 | The Agency MCP configuration step (Step 3 in `installClaudeCodeIntegration`) is unaffected by this change. | P1 | Ordering: cockpit copy sits between spec-kit copy and MCP configuration, or immediately after spec-kit copy — either placement is acceptable so long as MCP configuration still runs. |
| FR-007 | No files outside `packages/generacy/src/cli/commands/setup/build.ts` and its co-located tests are modified. | P1 | Isolation rule from epic issue. |
| FR-008 | The number of cockpit `.md` files copied equals the number of `.md` files in the resolved `commands/` directory (six per the epic S6 spec, but the code does not hardcode "six"). | P2 | Symmetric with spec-kit's `readdirSync(...).filter(f => f.endsWith('.md'))` pattern. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Six cockpit commands resolvable in fresh Claude Code session | 6/6 `/cockpit:<name>` commands resolve | With `@generacy-ai/claude-plugin-cockpit` installed globally, run `generacy setup build`, open a fresh Claude Code session, invoke `/cockpit:` → all six commands appear and resolve. |
| SC-002 | Non-fatal absence path | `generacy setup build` exits 0; stderr contains exactly one warn line with the template-substituted message | Uninstall the cockpit package from every checked path, run `generacy setup build`, assert exit code and log line. |
| SC-003 | Zero collisions | No spec-kit command file in `~/.claude/commands/` is overwritten by cockpit copy | After running setup with both packages installed, checksums of spec-kit `.md` files at `~/.claude/commands/*.md` match the source spec-kit files. |
| SC-004 | Structural symmetry | New cockpit block is a near-identical mirror of the spec-kit block (same resolver shape, same copy shape, same log-shape) except for the four axes of difference: package name, tier-1 source path, destination subdirectory, and warn-vs-error log level | Code review of the diff; test file mirrors the spec-kit test structure. |
| SC-005 | Isolation | Diff touches only `packages/generacy/src/cli/commands/setup/build.ts` and its co-located test file(s) | `git diff --name-only develop...HEAD` returns only these paths. |

## Assumptions

- Claude Code's subdirectory namespacing convention (`~/.claude/commands/<ns>/<name>.md` → `/<ns>:<name>`) is the documented mechanism for producing the `/cockpit:` prefix; the acceptance test on a fresh Claude Code session validates this at runtime (Q1 grounding).
- `@generacy-ai/claude-plugin-cockpit` ships its command `.md` files under a top-level `commands/` directory (mirrors `@generacy-ai/agency-plugin-spec-kit`; dependency on A-S2 for exact layout).
- The spec-kit block's use of `logger.error` for a non-fatal absent-package branch is a pre-existing quirk; this issue does NOT correct it (FR-007 isolation). Alignment is a follow-up (Q2 answer).
- `SHARED_PACKAGES_DIR` (`/shared-packages`) and `resolveNpmGlobalRoot()` helpers are reused as-is; no new helpers needed except `resolveCockpitCommandsDir`.
- `BuildConfig.agencyDir` and `BuildConfig.generacyDir` are already populated by the time `installClaudeCodeIntegration` runs (existing invariant).

## Out of Scope

- Modifying the existing spec-kit block (log level, message, path, or ordering) — see FR-007 and Q2 answer.
- Registering the cockpit package as a Claude Code marketplace plugin (`~/.claude/plugins/**`) — explicitly rejected in Q1 (option A); files copied there without marketplace registration don't load.
- Any changes to the `@generacy-ai/claude-plugin-cockpit` package itself (owned by A-S2).
- End-to-end verification against a live Claude Code session (owned by C-S1/T-S2).
- Uninstall/cleanup semantics (removing cockpit files on package removal) — not part of `setup build`.

---

*Generated by speckit*
