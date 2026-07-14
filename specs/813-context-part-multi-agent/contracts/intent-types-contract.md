# Contract: Intent Types Ownership

## Ownership

The following intent types are owned by `packages/orchestrator/src/launcher/types.ts`:

- `GenericSubprocessIntent` (already there)
- `ShellIntent` (already there)
- `PhaseIntent` (**moved from** `packages/generacy-plugin-claude-code/src/launch/types.ts`)
- `PrFeedbackIntent` (moved)
- `ValidateFixIntent` (moved)
- `MergeConflictIntent` (moved)
- `ConversationTurnIntent` (moved)
- `InvokeIntent` (moved)

The `ClaudeCodeIntent` alias — the six-way union of the agent intents — is **deleted**. Nothing in orchestrator core mentions "Claude Code" post-change.

## Field additions on move

- `PhaseIntent` gains optional `model?: string`.
- `PrFeedbackIntent` gains optional `model?: string`.
- All other intents preserve their existing shape byte-for-byte.

## Import direction

Post-change:

```
packages/orchestrator/src/launcher/types.ts       ── owns intent types
   ▲                                                          ▲
   │ import type                                              │ import type
   │                                                          │
packages/generacy-plugin-claude-code/src/launch/    packages/generacy-plugin-claude-code/src/index.ts
   claude-code-launch-plugin.ts                     (re-exports intent types for downstream consumers)
```

The Claude plugin imports intent types **as types only** (`import type { PhaseIntent, ... } from '@generacy-ai/orchestrator/launcher/types'`). No runtime cycle.

`packages/generacy-plugin-claude-code/src/launch/types.ts` is deleted. Anywhere in the plugin package that referenced it now imports directly from the orchestrator via `import type` and re-exports through `index.ts`.

## Forbidden import

`packages/orchestrator/src/launcher/types.ts` **must not** import anything from `@generacy-ai/generacy-plugin-claude-code`. Spec acceptance criterion #5.

Enforcement: one test greps the source of `packages/orchestrator/src/launcher/types.ts` for the substring `generacy-plugin-claude-code` and asserts zero matches. (Kept as a source-grep rather than a resolved-import test so it survives module reorganizations.)

## Downstream re-exports

`packages/generacy-plugin-claude-code/src/index.ts` continues to re-export the six intent types for backward compatibility with any external consumer:

```ts
export type {
  PhaseIntent,
  PrFeedbackIntent,
  ValidateFixIntent,
  MergeConflictIntent,
  ConversationTurnIntent,
  InvokeIntent,
  // ClaudeCodeIntent alias removed — Wave 3 can reintroduce a provider-scoped alias if useful
} from '@generacy-ai/orchestrator/launcher/types';
```

## `orchestrator-types` mirror

`packages/orchestrator-types/src/launcher-types.ts` continues to expose the subset union `LaunchIntent = GenericSubprocessIntent | ShellIntent` (per the existing comment). The agent intents are **not** propagated to this interface package. Rationale: research.md D-8.
