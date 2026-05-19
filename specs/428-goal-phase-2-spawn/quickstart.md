# Quickstart: ClaudeCodeLaunchPlugin (Phase 2)

**Feature**: #428 — Create ClaudeCodeLaunchPlugin
**Date**: 2026-04-12

## Prerequisites

- Wave 1 merged: `AgentLauncher`, `GenericSubprocessPlugin`, snapshot harness (#425, #427)
- Node.js + pnpm installed
- Monorepo dependencies installed (`pnpm install`)

## Running Tests

```bash
# Run plugin package tests only
pnpm --filter @generacy-ai/generacy-plugin-claude-code test

# Run orchestrator tests (verify nothing broken)
pnpm --filter @generacy-ai/orchestrator test

# Update snapshots after verifying changes are intentional
pnpm --filter @generacy-ai/generacy-plugin-claude-code test -- --update
```

## Usage Examples

### Plugin Registration (at orchestrator boot)

```typescript
import { AgentLauncher } from './launcher/agent-launcher.js';
import { GenericSubprocessPlugin } from './launcher/generic-subprocess-plugin.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

const launcher = new AgentLauncher(factoryMap);
launcher.registerPlugin(new GenericSubprocessPlugin());
launcher.registerPlugin(new ClaudeCodeLaunchPlugin());
```

### Launching a Phase (Wave 3 caller pattern)

```typescript
const handle = launcher.launch({
  intent: {
    kind: 'phase',
    phase: 'implement',
    prompt: '/implement https://github.com/org/repo/issues/42',
    sessionId: previousSessionId, // optional resume
  },
  cwd: '/workspace/repo',
  env: { CLAUDE_CODE_MAX_TURNS: '50' },
});
```

### Launching PR Feedback (Wave 3 caller pattern)

```typescript
const handle = launcher.launch({
  intent: {
    kind: 'pr-feedback',
    prNumber: 123,
    prompt: buildFeedbackPrompt(comments),
  },
  cwd: checkoutPath,
});
```

### Launching a Conversation Turn (Wave 3 caller pattern)

```typescript
const handle = launcher.launch({
  intent: {
    kind: 'conversation-turn',
    message: 'Fix the failing test in utils.test.ts',
    sessionId: existingSessionId,
    model: 'claude-sonnet-4-6',
    skipPermissions: true,
  },
  cwd: '/workspace/repo',
});
```

### Direct Plugin Usage (for testing)

```typescript
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

const plugin = new ClaudeCodeLaunchPlugin();

// Inspect the composed command without spawning
const spec = plugin.buildLaunch({
  kind: 'phase',
  phase: 'clarify',
  prompt: '/clarify https://github.com/org/repo/issues/99',
});

console.log(spec.command); // 'claude'
console.log(spec.args);    // ['-p', '--output-format', 'stream-json', ...]
console.log(spec.stdioProfile); // 'default'
```

## Verifying Snapshot Parity

The critical acceptance criterion is that plugin output matches existing direct-spawn behavior byte-for-byte.

```bash
# 1. Run snapshot tests (compares plugin vs direct-spawn baselines)
pnpm --filter @generacy-ai/generacy-plugin-claude-code test -- --run claude-code-launch-plugin

# 2. If snapshots fail, inspect the diff
pnpm --filter @generacy-ai/generacy-plugin-claude-code test -- --run claude-code-launch-plugin 2>&1 | head -100

# 3. If diff is intentional (e.g., flag ordering), update snapshots
pnpm --filter @generacy-ai/generacy-plugin-claude-code test -- --update
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Unknown intent kind "phase"` at runtime | `ClaudeCodeLaunchPlugin` not registered — check `claude-cli-worker.ts` constructor |
| Snapshot mismatch on env keys | Use `normalizeSpawnRecords()` from `test-utils/spawn-snapshot.ts` to sort env |
| Type error on `createOutputParser(intent)` | Ensure orchestrator `launcher/types.ts` has updated signature with `intent` param |
| Circular dependency error | Plugin must use type-only imports (`import type { ... }`) from orchestrator |
