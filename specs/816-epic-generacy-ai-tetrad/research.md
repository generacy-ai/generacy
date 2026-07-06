# Research: Wire cockpit slash commands in `generacy setup build`

## Decisions

### D1 — Destination path: `~/.claude/commands/cockpit/<name>.md`

**Decision**: Copy cockpit `.md` files into `~/.claude/commands/cockpit/`, using a subdirectory rather than a flat copy.

**Rationale**: Claude Code resolves commands under `~/.claude/commands/<subdir>/<name>.md` as `/<subdir>:<name>`. Subdirectory placement is the mechanism that produces the required `/cockpit:` prefix (spec Q1 answer). It also sidesteps filename collisions between `@generacy-ai/agency-plugin-spec-kit` (which ships `clarify.md`, `plan.md`) and `@generacy-ai/claude-plugin-cockpit` (which also ships `.md` files with potentially overlapping base names). Both plugins can coexist without either overwriting the other, and the change requires no modification to the spec-kit block (FR-007 isolation).

**Alternatives considered**:
- **`~/.claude/plugins/cockpit/commands/<name>.md`** — Rejected: this path is only loaded when the plugin is marketplace-registered and enabled (`enabledPlugins` gate). Bare files copied there without registration don't load.
- **Filename-prefixed flat copy (`cockpit-<name>.md`)** — Rejected: mangles source filenames on disk; produces `/cockpit-watch` (with hyphen), not `/cockpit:watch` (with colon namespace); asymmetric with spec-kit's flat copy shape.
- **Flat copy accepting collisions** — Rejected: overwriting `clarify.md`/`plan.md` breaks spec-kit; also produces bare `/watch` (no `/cockpit:` prefix), failing FR-002.

### D2 — Log level for absent package: `logger.warn`

**Decision**: Use `logger.warn` for the "not found" branch.

**Rationale**: FR-004 explicitly requires `logger.warn` (spec Q2 answer, option A). An absent optional plugin is not an error condition; execution continues, and setup completes successfully. Accepts asymmetry with the spec-kit block's pre-existing `logger.error` call in the same function.

**Alternatives considered**:
- **`logger.error`** — Rejected: parity is behavioral (both non-fatal), not stylistic. Q2's option B was declined in the clarifications phase.
- **Change spec-kit's `logger.error` to `logger.warn` in the same PR** — Rejected: violates FR-007's isolation rule (spec Q2, option C declined).

### D3 — Tier-1 workspace source-directory check

**Decision**: The cockpit resolver's tier-1 workspace source path is `<agencyDir>/packages/claude-plugin-cockpit/commands`.

**Rationale**: Mirrors spec-kit's tier-1 pattern (`<agencyDir>/packages/agency-plugin-spec-kit/commands`) with the correct package folder name. Enables source-checkout dev clusters (agency cloned, cockpit not yet npm-installed) to work identically to spec-kit dev flow. Confirmed in spec Q3 (option A).

**Alternatives considered**:
- **Skip the source-directory check, use only `node_modules` at tier 1** — Rejected: makes cockpit second-class in the source-checkout dev environment (Q3, option B declined).

### D4 — "Not found" warning wording: byte-for-byte template

**Decision**: The exact string `"@generacy-ai/claude-plugin-cockpit not found — install it locally or globally to enable cockpit commands"`.

**Rationale**: FR-004 and Q4 answer (option A) require byte-for-byte template substitution of the spec-kit warning. Deterministic and directly assertable in a Vitest string equality check. Uses U+2014 EM DASH (`—`), matching the spec-kit source line exactly.

**Alternatives considered**:
- **Semantic parity** (Q4, option B) — Rejected: unreliable in tests, drifts over time.

### D5 — No new helpers beyond `resolveCockpitCommandsDir`

**Decision**: Reuse `resolveNpmGlobalRoot()` and `SHARED_PACKAGES_DIR` unchanged.

**Rationale**: Both are pure utilities with no cockpit-specific state. Duplication would violate DRY and increase the diff scope beyond isolation intent.

**Alternatives considered**:
- **Extract a shared `resolvePluginCommandsDir(pkgName, sourceSubdir, config)` factory** — Rejected: cross-cutting refactor violates FR-007. Symmetric duplication is the smaller change and easier to review.

### D6 — Placement of the cockpit block: immediately after spec-kit, before MCP

**Decision**: Insert the cockpit copy block after the spec-kit block, before Step 3 (MCP configuration).

**Rationale**: Preserves the "install commands, then configure MCP" narrative of `installClaudeCodeIntegration`. Spec FR-006 permits either placement so long as MCP still runs; putting cockpit adjacent to spec-kit makes the mirrored structure obvious to reviewers.

## Implementation Patterns Referenced

- `resolveSpeckitCommandsDir` (`build.ts:278-315`) — resolver structure.
- `installClaudeCodeIntegration` spec-kit copy block (`build.ts:328-356`) — copy structure and log shape.
- `resolveNpmGlobalRoot` (`build.ts:255-261`) — shared utility.
- `packages/generacy/src/__tests__/setup/build.test.ts` — mock harness (fs, os, logger, child_process) already covers everything the new tests need.

## Key References

- Spec: `specs/816-epic-generacy-ai-tetrad/spec.md`
- Clarifications: `specs/816-epic-generacy-ai-tetrad/clarifications.md`
- Existing module: `packages/generacy/src/cli/commands/setup/build.ts`
- Test suite: `packages/generacy/src/__tests__/setup/build.test.ts`
- Claude Code convention: `commands/<ns>/<name>.md` → `/<ns>:<name>` (spec assumption, validated in C-S1/T-S2).
- Upstream package layout: `@generacy-ai/claude-plugin-cockpit` — defined by A-S2.
- Epic plan: `docs/epic-cockpit-plan.md` in `generacy-ai/tetrad-development` (S6 / G-S5).
