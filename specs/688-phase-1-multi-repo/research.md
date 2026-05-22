# Research: Inject sibling-repo awareness into agent prompt

**Feature**: #688 — Phase 1 multi-repo
**Date**: 2026-05-22

## Technology Decisions

### TD-1: Prompt prepend vs. system prompt injection

**Decision**: Prompt prepend in `phase-loop.ts`
**Rationale**: The agent prompt (`context.issueUrl`) is the only user-controlled text that flows to `cliSpawner.spawnPhase()`. Prepending the sibling block here:
- Requires no changes to cli-spawner or agent-launcher
- Is visible in conversation logs for debugging
- Avoids mutating CLAUDE.md (which would dirty git state)
- Works identically for all phases (same code path)

**Alternatives rejected**:
- **CLAUDE.md mutation**: Would create uncommitted changes in the workspace, conflict with the repo's committed CLAUDE.md, and require cleanup logic
- **Per-task injection** (`buildTaskPrompt()` in implement skill): Wasteful repetition — the CLI conversation context persists, so the agent sees the block from the first message
- **Environment variable**: Claude Code doesn't read arbitrary env vars for prompt context

### TD-2: Data shape — `string[]` vs `Map<string, string>` vs structured objects

**Decision**: `string[]` of absolute paths
**Rationale**: The prompt needs basename (derived via `path.basename()`) and absolute path. A string array is the simplest shape that carries all needed info. A Map adds key-value semantics that aren't needed. Structured objects (`{ name, path, repo? }`) would be over-engineering for Phase 1.

**Forward compatibility**: If Phase 2+ needs repo URLs or metadata, the type can evolve to `Array<{ path: string; repo?: string }>` without changing the injection point.

### TD-3: Pure function extraction

**Decision**: Separate `sibling-prompt.ts` module with `buildSiblingPromptBlock()`
**Rationale**: Follows the codebase pattern of small, focused modules in the worker directory. Makes the formatting logic independently testable without mocking the entire phase-loop. The function is pure (no I/O, no side effects).

## Implementation Patterns

### Pattern: Optional context fields

The `WorkerContext` interface uses TypeScript optional fields (`field?: Type`) for data that may not be available at construction time. Example: `prUrl?: string` is set after a draft PR is created. `siblingWorkdirs` follows the same pattern — absent until Issue A provides the data.

### Pattern: Prompt assembly

The prompt flows through three layers:
1. **phase-loop.ts**: Owns the prompt content (`context.issueUrl` + sibling block)
2. **cli-spawner.ts**: Passes prompt as `options.prompt` to launcher (no transformation)
3. **claude-code-launch-plugin.ts**: Appends prompt after slash command (`/implement <prompt>`)

The injection happens at layer 1 only. Layers 2 and 3 are passthrough.

### Pattern: Conditional formatting

```typescript
const block = buildSiblingPromptBlock(context.siblingWorkdirs ?? []);
const prompt = block ? `${block}\n\n${context.issueUrl}` : context.issueUrl;
```

When no siblings: `block` is `undefined`, prompt equals `context.issueUrl` unchanged. This satisfies FR-003 (no "no siblings" noise) and SC-002 (identical prompt to today).

## Key Sources

- **Spec**: `specs/688-phase-1-multi-repo/spec.md`
- **Clarifications**: `specs/688-phase-1-multi-repo/clarifications.md`
- **Phase-loop source**: `packages/orchestrator/src/worker/phase-loop.ts` (line ~185)
- **WorkerContext type**: `packages/orchestrator/src/worker/types.ts` (line ~229)
- **Context assembly**: `packages/orchestrator/src/worker/claude-cli-worker.ts` (line ~301)
- **Multi-repo plan**: `tetrad-development/docs/multi-repo-workflows-plan.md`
