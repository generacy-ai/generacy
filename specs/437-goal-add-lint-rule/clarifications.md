# Clarifications for #437: Add lint rule forbidding direct child_process.spawn

## Batch 1 — 2026-04-12

### Q1: Synchronous Variants
**Context**: The spec lists `spawn`, `exec`, `execFile`, and `fork` as forbidden APIs. However, Node.js also provides synchronous variants (`spawnSync`, `execSync`, `execFileSync`) that equally bypass `ProcessFactory`/`AgentLauncher`. Omitting them would leave a loophole.
**Question**: Should the lint rule also forbid `spawnSync`, `execSync`, and `execFileSync`?
**Options**:
- A: Yes, forbid all sync variants alongside the async ones
- B: No, only forbid async variants as listed in the spec

**Answer**: *Pending*

### Q2: Allow-List Path for Launcher Directory
**Context**: The spec references "any new files under an `agent-launcher/` internals directory" as allow-listed. However, the actual directory in the codebase is `packages/orchestrator/src/launcher/` (containing `agent-launcher.ts`, `launcher-setup.ts`, `generic-subprocess-plugin.ts`, etc.), not `agent-launcher/`. The launcher directory currently does NOT directly use `child_process` (it delegates to `ProcessFactory`), but the spec still includes it in the allow-list.
**Question**: Should the allow-list reference the actual `packages/orchestrator/src/launcher/**` path? And should it be included at all, given that launcher files currently don't import `child_process` directly?
**Options**:
- A: Use actual path `packages/orchestrator/src/launcher/**` and include in allow-list (future-proofing)
- B: Use actual path but exclude from allow-list since launcher doesn't need direct spawn access
- C: Only add it to the allow-list if/when a launcher file actually needs direct `child_process` access

**Answer**: *Pending*

### Q3: Monorepo Rule Scope
**Context**: This is a monorepo. The root `.eslintrc.json` applies globally, but lint scripts are per-package (`packages/orchestrator/` has its own `pnpm lint`). The `child_process` restriction is primarily relevant to the orchestrator package, but other packages could also introduce direct spawn calls. It's unclear whether the rule should live in the root ESLint config (enforcing across all packages) or in a new orchestrator-specific ESLint override/config.
**Question**: Should the lint rule be configured at the root level (applying to all packages) or scoped only to the orchestrator package?
**Options**:
- A: Root level — forbid `child_process` everywhere, with allow-list exceptions only in orchestrator paths
- B: Orchestrator only — add the rule in an ESLint override scoped to `packages/orchestrator/**`
- C: Root level, but with potential per-package allow-lists if other packages need it

**Answer**: *Pending*
