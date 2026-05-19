# Quickstart: Spawn Snapshot Test Harness

## Installation

No additional dependencies required — uses Vitest (already installed) and project-internal utilities.

## Usage

### 1. Import the harness

```typescript
import {
  RecordingProcessFactory,
  normalizeSpawnRecords,
} from '../test-utils/index.js';
```

### 2. Create a RecordingProcessFactory

```typescript
const factory = new RecordingProcessFactory(); // exits with code 0
// or
const factory = new RecordingProcessFactory(1); // exits with code 1
```

### 3. Use it with CliSpawner

```typescript
import { CliSpawner } from '../cli-spawner.js';

const spawner = new CliSpawner(factory, mockLogger);
await spawner.spawnPhase('specify', options, capture);
```

### 4. Assert spawn records against snapshots

```typescript
const normalized = normalizeSpawnRecords(factory.calls);
expect(normalized).toMatchSnapshot();
```

Or with inline snapshots for small assertions:

```typescript
expect(normalized).toMatchInlineSnapshot(`
  [
    {
      "args": ["-p", "--output-format", "stream-json", ...],
      "command": "claude",
      "cwd": "/workspace",
      "env": { "KEY": "value" },
    },
  ]
`);
```

### 5. Reset between tests

```typescript
afterEach(() => {
  factory.reset();
});
```

## Writing Wave 2-3 Snapshot Tests

When migrating spawn behavior in Waves 2-3:

1. **Before refactoring**: Run the existing snapshot test to confirm it passes with the current code
2. **After refactoring**: Run the same test — if the snapshot matches, parity is confirmed
3. **If the snapshot changes intentionally**: Run `pnpm --filter orchestrator test -- --update` to update snapshots, then review the diff in your PR

## Running Tests

```bash
# Run all orchestrator tests
pnpm --filter orchestrator test

# Run only snapshot tests
pnpm --filter orchestrator test -- cli-spawner-snapshot

# Update snapshots after intentional changes
pnpm --filter orchestrator test -- cli-spawner-snapshot --update
```

## Troubleshooting

**Snapshot mismatch after unrelated change**: Check if a new CLI flag was added to `spawnPhase()`. If intentional, update the snapshot.

**Import errors**: Ensure imports use `.js` extension (ESM convention): `from '../test-utils/index.js'`

**Test hangs**: The dummy `ChildProcessHandle` resolves `exitPromise` immediately. If a test hangs, the issue is likely in the code under test (e.g., awaiting stdout data that the dummy never emits). Emit `'end'` on the dummy's stdout/stderr EventEmitters if needed.
