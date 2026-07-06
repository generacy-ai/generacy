# Clarifications

## Batch 1 — 2026-07-06

### Q1: Destination path & /cockpit: namespacing
**Context**: `installClaudeCodeIntegration` in `build.ts` currently copies the spec-kit `.md` files **flat** into `~/.claude/commands/` — there is no `/speckit:` prefix applied at copy time. Both packages ship files with the same base names (`clarify.md`, `plan.md`), so a flat copy of both packages would silently overwrite one. FR-003 requires cockpit commands to resolve as `/cockpit:<name>` in Claude Code; the mechanism producing that namespace at runtime is not visible in `build.ts` and must be pinned down before implementation.

**Question**: Where should the cockpit `.md` files be copied to so that (a) they resolve as `/cockpit:<name>` in a fresh Claude Code session and (b) the files that share names with spec-kit commands (`clarify.md`, `plan.md`) don't collide?

**Options**:
- A: Copy into a per-plugin subdirectory the plugin loader knows about (e.g. `~/.claude/plugins/cockpit/commands/<name>.md`), leaving the spec-kit flat-copy block untouched. Requires knowing the plugin loader path.
- B: Copy into `~/.claude/commands/cockpit/<name>.md` (subfolder under existing commands dir) — asymmetric with spec-kit's flat copy but keeps spec-kit block unchanged per FR-007.
- C: Copy flat into `~/.claude/commands/` with filename prefix on copy (e.g. `cockpit-<name>.md`), accepting that this changes the file names on disk.
- D: Copy flat into `~/.claude/commands/`, matching spec-kit exactly, and accept that `clarify.md`/`plan.md` collisions are resolved by copy order (last-writer wins) — collisions are considered acceptable for this issue.
- E: Other (please describe, including the exact destination path).

**Answer**: *Pending*

### Q2: Log level for absent package
**Context**: FR-004 explicitly requires the cockpit "not found" branch to be a non-fatal warning and NOT `logger.error`. However, the existing spec-kit block at `build.ts:344` calls `logger.error(...)` (non-fatally — execution continues). Behavioral parity ("same non-fatal warning") is in tension with the "not `logger.error` at fatal level" wording of FR-004, and FR-007 forbids modifying files outside the cockpit scope (so the spec-kit block cannot be changed to `logger.warn` in the same PR).

**Question**: Which log call should the cockpit "not found" branch use?

**Options**:
- A: `logger.warn(...)` — matches FR-004 wording literally; cockpit branch will be asymmetric with the spec-kit branch's `logger.error` call in the same function.
- B: `logger.error(...)` — matches spec-kit branch structurally (both are non-fatal); accepts wording drift with FR-004.
- C: `logger.warn(...)` AND additionally change spec-kit's `logger.error` to `logger.warn` in the same PR (relaxes FR-007's isolation rule for that one-line change).

**Answer**: *Pending*

### Q3: Tier-1 workspace source path
**Context**: `resolveSpeckitCommandsDir` tier-1 checks the source directory `<agencyDir>/packages/agency-plugin-spec-kit/commands` (in addition to `node_modules` paths). The cockpit package lives at `packages/claude-plugin-cockpit/commands` (different subpath — no `agency-plugin-` prefix). FR-001 requires "same 4-tier search order" but the exact tier-1 path for cockpit is not stated.

**Question**: Should the cockpit resolver's tier-1 workspace source-directory check be `<agencyDir>/packages/claude-plugin-cockpit/commands`, mirroring spec-kit's tier-1 exact-path convention with the correct package folder name?

**Options**:
- A: Yes — hardcode `<agencyDir>/packages/claude-plugin-cockpit/commands` as the tier-1 source-directory path (in addition to the `node_modules/@generacy-ai/claude-plugin-cockpit/commands` paths in `generacyDir` and `agencyDir`).
- B: No — check only `node_modules` at tier 1 (`generacyDir/node_modules/...` and `agencyDir/node_modules/...`); skip the source-directory check. This differs from the spec-kit resolver.
- C: Other (please describe).

**Answer**: *Pending*

### Q4: "Not found" warning wording
**Context**: FR-004 states cockpit's warning should match "the wording style of the existing spec-kit branch." SC-004 asks for the two blocks to be "structurally symmetric." The spec-kit line reads: `"@generacy-ai/agency-plugin-spec-kit not found — install it locally or globally to enable speckit commands"`. It is unclear whether the cockpit line must be a byte-for-byte template substitution or whether semantic parity is enough.

**Question**: Which wording is required for the cockpit branch's "not found" log line?

**Options**:
- A: Byte-for-byte template of the spec-kit line, substituting `@generacy-ai/agency-plugin-spec-kit`→`@generacy-ai/claude-plugin-cockpit` and `speckit commands`→`cockpit commands`. Exact string: `"@generacy-ai/claude-plugin-cockpit not found — install it locally or globally to enable cockpit commands"`.
- B: Semantic parity is enough — any message that conveys "package not found; install to enable cockpit commands" is acceptable.

**Answer**: *Pending*
