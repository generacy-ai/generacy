# Quickstart: Migrate SubprocessAgency to AgentLauncher

## Prerequisites

- Node.js 20+
- pnpm installed
- Dependencies installed: `pnpm install`

## Running Tests

### All tests
```bash
pnpm test
```

### Orchestrator tests only (GenericSubprocessPlugin changes)
```bash
cd packages/orchestrator
pnpm test -- --run src/launcher/__tests__/generic-subprocess-plugin.test.ts
```

### Generacy tests only (SubprocessAgency changes)
```bash
cd packages/generacy
pnpm test -- --run src/agency/__tests__/subprocess.test.ts
pnpm test -- --run src/agency/__tests__/subprocess-snapshot.test.ts
```

## Verifying the Migration

### 1. Type signature check
The `SubprocessAgencyOptions` type must not have changed. The snapshot/type test will verify this automatically.

### 2. Snapshot parity check
The snapshot test creates an `AgentLauncher` with `RecordingProcessFactory`, runs `SubprocessAgency.connect()` through it, and asserts the resulting `{command, args, cwd, env}` are byte-identical to what direct `spawn()` would have produced.

### 3. Spawn error behavior
The integration test verifies that an ENOENT spawn error produces an immediate rejection from `connect()`, not a 30-second timeout.

### 4. Fallback behavior
Unit tests verify that when no `AgentLauncher` is provided, `SubprocessAgency` falls back to direct `child_process.spawn` exactly as before.

## Usage

### With AgentLauncher (new path)
```typescript
import { AgentLauncher, GenericSubprocessPlugin } from '@generacy-ai/orchestrator';
import { SubprocessAgency } from '@generacy-ai/generacy';

const launcher = new AgentLauncher(new Map([
  ['default', defaultProcessFactory],
  ['interactive', conversationProcessFactory],
]));
launcher.registerPlugin(new GenericSubprocessPlugin());

const agency = new SubprocessAgency(
  { command: 'npx', args: ['@anthropic-ai/agency'], logger },
  launcher  // optional second parameter
);
await agency.connect();
```

### Without AgentLauncher (fallback — backward compatible)
```typescript
import { SubprocessAgency } from '@generacy-ai/generacy';

// Existing code unchanged — no launcher, falls back to direct spawn
const agency = new SubprocessAgency({
  command: 'npx',
  args: ['@anthropic-ai/agency'],
  logger,
});
await agency.connect();
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Unknown stdio profile "interactive"` | AgentLauncher not configured with interactive factory | Register conversationProcessFactory under `'interactive'` key |
| `Unknown intent kind "generic-subprocess"` | Plugin not registered | Call `launcher.registerPlugin(new GenericSubprocessPlugin())` |
| stdin writes fail / `Process not started` | Wrong stdio profile (stdin is null) | Ensure intent uses `stdioProfile: 'interactive'`, not `'default'` |
| Connect timeout instead of immediate ENOENT | #426 not merged (exitPromise doesn't reject on spawn errors) | Merge #426 first, or use fallback (no launcher) |
