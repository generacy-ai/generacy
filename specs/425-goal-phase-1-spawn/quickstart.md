# Quickstart: AgentLauncher + GenericSubprocessPlugin (Phase 1)

**Feature**: #425 | **Date**: 2026-04-12

## Overview

Phase 1 introduces the `AgentLauncher` as an internal module inside `@generacy-ai/orchestrator`. No existing callers are modified — this is purely additive code that later waves will migrate callers onto.

## Usage

### Creating an AgentLauncher

```typescript
import { AgentLauncher } from '../launcher/agent-launcher.js';
import { GenericSubprocessPlugin } from '../launcher/generic-subprocess-plugin.js';
import type { ProcessFactory } from '../worker/types.js';

// Map stdio profiles to ProcessFactory instances
const factories = new Map<string, ProcessFactory>([
  ['default', defaultProcessFactory],
  ['interactive', conversationProcessFactory],
]);

const launcher = new AgentLauncher(factories);
launcher.registerPlugin(new GenericSubprocessPlugin());
```

### Launching a generic subprocess

```typescript
import type { LaunchRequest } from '../launcher/types.js';

const request: LaunchRequest = {
  intent: {
    kind: 'generic-subprocess',
    command: 'node',
    args: ['script.js', '--verbose'],
    env: { NODE_ENV: 'production' },
  },
  cwd: '/path/to/working/dir',
  env: { CUSTOM_VAR: 'value' },  // Caller overrides (highest priority)
  signal: abortController.signal,
};

const handle = launcher.launch(request);

// Access the child process
console.log('PID:', handle.process.pid);

// Wait for exit
const exitCode = await handle.process.exitPromise;

// Flush output parser
handle.outputParser.flush();
```

### Launching a shell command

```typescript
const request: LaunchRequest = {
  intent: {
    kind: 'shell',
    command: 'pnpm test && pnpm build',
    env: { CI: 'true' },
  },
  cwd: '/path/to/repo',
};

const handle = launcher.launch(request);
const exitCode = await handle.process.exitPromise;
```

### Cancelling a launch

```typescript
const controller = new AbortController();

const handle = launcher.launch({
  intent: { kind: 'generic-subprocess', command: 'long-task', args: [] },
  cwd: '/tmp',
  signal: controller.signal,
});

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);
```

## Environment Merge Order

The launcher merges environment variables in this order (later wins):

1. `process.env` — base system environment
2. Plugin env — from `LaunchSpec.env` (returned by `buildLaunch()`)
3. Caller env — from `LaunchRequest.env`

```
Final env = { ...process.env, ...pluginEnv, ...callerEnv }
```

## Running Tests

```bash
# Run only the launcher tests
pnpm --filter @generacy-ai/orchestrator test -- --testPathPattern launcher

# Run all orchestrator tests (verifies zero regression)
pnpm --filter @generacy-ai/orchestrator test

# Update snapshots if GenericSubprocessPlugin output changes
pnpm --filter @generacy-ai/orchestrator test -- --testPathPattern generic-subprocess -u
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `Error: No plugin registered for intent kind "X"` | Intent kind not registered | Ensure the plugin handling that kind is registered via `launcher.registerPlugin()` |
| `Error: No ProcessFactory registered for stdio profile "X"` | Plugin returned unknown `stdioProfile` | Add the profile to the `factories` map passed to `AgentLauncher` constructor |
| `Error: Intent kind "X" already registered by plugin "Y"` | Two plugins claim the same kind | Ensure each intent kind is handled by exactly one plugin |
| Existing tests fail | Accidental modification to existing code | Verify `git diff develop -- packages/orchestrator/src/worker/ packages/orchestrator/src/conversation/` shows only additive changes |

## What's Next

- **`/speckit:tasks`** — Generate the task list with dependency ordering
- **Wave 2** — `ClaudeCodeLaunchPlugin` + migrate `CliSpawner` and `ConversationSpawner` to use `AgentLauncher`
- **Wave 3** — Lifecycle consolidation in `LaunchHandle` + shell validators
