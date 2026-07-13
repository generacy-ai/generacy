# Implementation Plan: Multi-Agent Provider — Phase 1, Issue 1 (Launcher Registry)

**Feature**: Widen `AgentLauncher` to host multiple agent plugins via `(provider, kind)` registry keying, with zero behavior change.
**Branch**: `813-context-part-multi-agent`
**Status**: Complete

## Summary

Today `AgentLauncher` keys its plugin registry on `intent.kind` alone (`packages/orchestrator/src/launcher/agent-launcher.ts:20, 34-44`). `ClaudeCodeLaunchPlugin` claims all six agent kinds (`phase`, `pr-feedback`, `conversation-turn`, `invoke`, `validate-fix`, `merge-conflict`), and orchestrator core imports `ClaudeCodeIntent` from the plugin package (`packages/orchestrator/src/launcher/types.ts:2, 33`). A second agent plugin (Codex, OpenCode) cannot register — `registerPlugin` throws on duplicate kinds — and no caller can express a provider.

This change:
1. Moves **all six** agent intent types into orchestrator core (`packages/orchestrator/src/launcher/types.ts`).
2. Adds optional `model?: string` to `PhaseIntent` and `PrFeedbackIntent`.
3. Adds optional `provider?: string` to `LaunchRequest` (default `'claude-code'`).
4. Re-keys the plugin registry uniformly on `(provider, kind)` for **all** plugins.
5. `GenericSubprocessPlugin` registers under a reserved internal `'system'` provider constant (not exported, not accepted in workflow config).
6. `AgentLaunchPlugin` gains `readonly provider: string`; plugins self-declare.
7. Introduces typed error classes `DuplicatePluginRegistrationError` and `UnknownProviderError`, both in `packages/orchestrator/src/launcher/`.
8. `ClaudeCodeLaunchPlugin` imports (or structurally matches) orchestrator-owned intent types instead of exporting them.

**No behavior change**: every call site omits `provider` and resolves to `'claude-code'`. Argv snapshot tests must pass byte-identical.

## Technical Context

- **Language**: TypeScript (ESM, Node ≥22)
- **Packages touched**:
  - `packages/orchestrator/src/launcher/` — registry + types + errors (primary change surface)
  - `packages/generacy-plugin-claude-code/src/launch/` — intent types imported (not exported); `provider = 'claude-code'` added to plugin
  - `packages/orchestrator-types/src/launcher-types.ts` — mirrored interface widening (external contract, no runtime code)
- **Dependencies**: no new runtime deps. Vitest for tests.
- **Registry key**: composed string `${provider}:${kind}` (private implementation detail — external API is `(provider, kind)` tuple).
- **Constants**: `SYSTEM_PROVIDER = 'system'` and `DEFAULT_PROVIDER = 'claude-code'` live inside `packages/orchestrator/src/launcher/` and are **not** re-exported.

## Project Structure

```
packages/orchestrator/src/launcher/
├── agent-launcher.ts                    # MODIFIED — tuple-keyed registry, typed errors, provider default
├── types.ts                             # MODIFIED — owns all 6 agent intents + LaunchRequest.provider + AgentLaunchPlugin.provider
├── errors.ts                            # NEW — UnknownProviderError, DuplicatePluginRegistrationError
├── constants.ts                         # NEW — SYSTEM_PROVIDER, DEFAULT_PROVIDER (internal)
├── generic-subprocess-plugin.ts         # MODIFIED — declares provider = SYSTEM_PROVIDER
├── launcher-setup.ts                    # UNCHANGED (call site unchanged — plugins self-declare)
├── index.ts                             # MODIFIED — export new intent types + typed errors
└── __tests__/
    ├── agent-launcher.test.ts           # MODIFIED — cover (provider, kind) tuple keying + typed errors
    └── multi-provider.test.ts           # NEW — fake plugin under provider 'test-agent' + kind 'phase'

packages/generacy-plugin-claude-code/src/launch/
├── types.ts                             # DELETED or reduced to re-exports from orchestrator (see research.md D-2)
├── claude-code-launch-plugin.ts         # MODIFIED — provider = 'claude-code' field; import intents from orchestrator types
└── constants.ts                         # UNCHANGED
packages/generacy-plugin-claude-code/src/
└── index.ts                             # MODIFIED — remove intent-type re-exports (moved to orchestrator)

packages/orchestrator-types/src/launcher-types.ts  # MODIFIED — mirror new fields (provider on plugin + request)
```

## Constitution Check

No `.specify/memory/constitution.md` present in the repo. Skipped.

## Non-Goals (repeated for emphasis)

- Config surface for provider selection (workflow YAML) — that is **#814** (Phase 1 issue 2).
- Output-parser seam — Wave 3.
- Any concrete second provider (Codex/OpenCode) — Phase 3.
- Changes to `.generacy/config.yaml` schema.

## Acceptance Gate (from spec)

- [ ] Existing argv snapshot tests pass byte-identical (no-config parity).
- [ ] Test registers a fake second plugin for `phase` under provider `test-agent`; dispatch by `provider` works.
- [ ] Unknown provider produces `UnknownProviderError` (`instanceof` true).
- [ ] Duplicate `(provider, kind)` produces `DuplicatePluginRegistrationError` (`instanceof` true).
- [ ] `packages/orchestrator/src/launcher/types.ts` has zero imports from `@generacy-ai/generacy-plugin-claude-code`.

## Next Step

Run `/speckit:tasks` to generate the ordered, parallelizable task list from this plan.
