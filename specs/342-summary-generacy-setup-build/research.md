# Research: Fix `generacy setup build` Phase 4

## Technology Decisions

### Decision 1: npm-global fallback (Option D from spec)

**Choice**: Add a third fallback path that copies `.md` files from the globally-installed npm package.

**Rationale**:
- External projects already have `@generacy-ai/agency` installed globally via the Dockerfile (`npm install -g @generacy-ai/agency`)
- No new infrastructure required — leverages existing npm distribution
- Graceful degradation: marketplace → source → npm → warning
- Non-breaking: existing paths remain unchanged

**Alternatives considered**:
- **Option A only** (include `.md` in npm): Requires agency repo change but no generacy change. However, the files need to be actively copied to `~/.claude/commands/` — they aren't auto-discovered from npm.
- **Option B** (bundle in generacy): Couples slash command updates to generacy releases. Commands are owned by agency, not generacy.
- **Option C** (public marketplace repo): Best long-term solution but requires maintaining a separate public repo and GitHub network access at build time.

### Decision 2: Flat `commands/` directory structure

**Choice**: Expect `.md` files at `<npm-pkg-root>/commands/` rather than mirroring the monorepo structure.

**Rationale**:
- Simpler, shorter path
- Consistent with how the file-copy fallback already works (copies from `packages/claude-plugin-agency-spec-kit/commands/`)
- The npm package is a distribution artifact — internal monorepo structure shouldn't leak

### Decision 3: Extract `resolveNpmGlobalRoot()` helper

**Choice**: Extract the `npm root -g` call into a shared function.

**Rationale**:
- The same shell command is needed twice: once for command file fallback, once for MCP CLI resolution (line 377)
- Avoids duplicate `execSafe` calls and keeps the code DRY
- Single point of failure handling

## Implementation Patterns

### Pattern: Cascading fallback with logging

The existing code already uses a cascading pattern (marketplace → source copy). The new code extends this chain. Each level:
1. Attempts the installation
2. Logs success or failure
3. Falls through to the next level on failure

### Pattern: `execSafe` for non-critical operations

All npm/claude CLI calls use `execSafe()` which returns `{ ok, stdout, stderr }` without throwing. This is critical for fallback chains where failure is expected and handled.

## Key Sources

- Current implementation: `packages/generacy/src/cli/commands/setup/build.ts:271-418`
- Exec utilities: `packages/generacy/src/cli/utils/exec.ts`
- Spec: `specs/342-summary-generacy-setup-build/spec.md`
- Related issues: generacy-ai/cluster-templates#9, generacy-ai/cluster-templates#8
