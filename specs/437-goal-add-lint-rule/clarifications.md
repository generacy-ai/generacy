# Clarifications for #437: Add lint rule forbidding direct child_process.spawn

## Batch 1 — 2026-04-12

### Q1: Synchronous Variants
**Context**: The spec lists `spawn`, `exec`, `execFile`, and `fork` as forbidden APIs. However, Node.js also provides synchronous variants (`spawnSync`, `execSync`, `execFileSync`) that equally bypass `ProcessFactory`/`AgentLauncher`. Omitting them would leave a loophole.
**Question**: Should the lint rule also forbid `spawnSync`, `execSync`, and `execFileSync`?
**Options**:
- A: Yes, forbid all sync variants alongside the async ones
- B: No, only forbid async variants as listed in the spec

**Answer**: A — Yes, forbid all sync variants alongside the async ones

`spawnSync`, `execSync`, and `execFileSync` bypass `ProcessFactory`/`AgentLauncher` just as completely as their async counterparts. Omitting them leaves a loophole that someone will eventually walk through — especially `execSync`, which is the most tempting shortcut for "just run a quick command."

The forbidden list should be: `spawn`, `spawnSync`, `exec`, `execSync`, `execFile`, `execFileSync`, `fork`. Match on both `import { spawn } from 'child_process'` and `require('child_process')` patterns.

### Q2: Allow-List Path for Launcher Directory
**Context**: The spec references "any new files under an `agent-launcher/` internals directory" as allow-listed. However, the actual directory in the codebase is `packages/orchestrator/src/launcher/` (containing `agent-launcher.ts`, `launcher-setup.ts`, `generic-subprocess-plugin.ts`, etc.), not `agent-launcher/`. The launcher directory currently does NOT directly use `child_process` (it delegates to `ProcessFactory`), but the spec still includes it in the allow-list.
**Question**: Should the allow-list reference the actual `packages/orchestrator/src/launcher/**` path? And should it be included at all, given that launcher files currently don't import `child_process` directly?
**Options**:
- A: Use actual path `packages/orchestrator/src/launcher/**` and include in allow-list (future-proofing)
- B: Use actual path but exclude from allow-list since launcher doesn't need direct spawn access
- C: Only add it to the allow-list if/when a launcher file actually needs direct `child_process` access

**Answer**: C — Only add launcher directory to the allow-list if/when a file there actually imports `child_process`

The launcher delegates to `ProcessFactory` — it currently has zero `child_process` imports and shouldn't need any. Pre-allowing `packages/orchestrator/src/launcher/**` would silently permit future direct-spawn regressions in the exact module designed to prevent them.

If a launcher file ever needs direct access (unlikely), adding it to the allow-list is a 1-line diff with a clear PR explanation. That friction is the point — it forces a conversation about why the launcher is bypassing its own primitive.

### Q3: Monorepo Rule Scope
**Context**: This is a monorepo. The root `.eslintrc.json` applies globally, but lint scripts are per-package (`packages/orchestrator/` has its own `pnpm lint`). The `child_process` restriction is primarily relevant to the orchestrator package, but other packages could also introduce direct spawn calls. It's unclear whether the rule should live in the root ESLint config (enforcing across all packages) or in a new orchestrator-specific ESLint override/config.
**Question**: Should the lint rule be configured at the root level (applying to all packages) or scoped only to the orchestrator package?
**Options**:
- A: Root level — forbid `child_process` everywhere, with allow-list exceptions only in orchestrator paths
- B: Orchestrator only — add the rule in an ESLint override scoped to `packages/orchestrator/**`
- C: Root level, but with potential per-package allow-lists if other packages need it

**Answer**: C — Root level, with a comprehensive allow-list including grandfathered files

The refactor only migrates 9 spawn sites, but the codebase has many more direct `child_process` users that are out of scope:

**Sanctioned (permanent allow-list):**
- `packages/orchestrator/src/worker/claude-cli-worker.ts` (defaultProcessFactory)
- `packages/orchestrator/src/conversation/process-factory.ts` (conversationProcessFactory)
- `packages/workflow-engine/src/actions/cli-utils.ts` (fallback path for external consumers, per #430 Q3)

**Grandfathered (not migrated by this refactor, allow-listed with TODO comments):**
- `packages/orchestrator/src/services/relay-bridge.ts`
- `packages/orchestrator/src/worker/repo-checkout.ts`
- `packages/orchestrator/src/services/identity.ts`
- `packages/cluster-relay/src/metadata.ts`
- `packages/workflow-engine/src/actions/epic/create-pr.ts`
- `packages/generacy/src/cli/commands/setup/services.ts`
- `packages/generacy/src/cli/utils/exec.ts`
- `packages/generacy-extension/src/views/local/runner/actions/cli-utils.ts`

**Test files:** allowed by glob (`**/__tests__/**`, `**/tests/**`, `**/*.test.ts`)

A root-level rule with this allow-list prevents growth (new files are forbidden by default) while acknowledging the current reality. Each grandfathered file gets a `// TODO: migrate to AgentLauncher/ProcessFactory` comment in the allow-list config. Future cleanup work can shrink the list incrementally.

Scoping to orchestrator-only (option B) would miss `packages/generacy` and `packages/workflow-engine`, where new direct spawns could appear uncaught.
