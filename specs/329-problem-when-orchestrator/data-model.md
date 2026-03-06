# Data Model: Pre-Validate Dependency Installation

## Configuration Changes

### WorkerConfig (extended)

```typescript
interface WorkerConfig {
  phaseTimeoutMs: number;              // Default: 600,000ms (10 min)
  workspaceDir: string;                // Default: '/tmp/orchestrator-workspaces'
  shutdownGracePeriodMs: number;       // Default: 5,000ms
  validateCommand: string;             // Default: 'pnpm test && pnpm build'
  preValidateCommand: string;          // NEW — Default: 'pnpm install'
  gates: Record<string, GateDefinition[]>;
}
```

### New Constant

```typescript
/** Default timeout for pre-validate dependency installation (5 minutes). */
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;
```

## No New Entities

This fix modifies existing configuration and execution flow only. No new data models, database schemas, or API contracts are introduced.

## Validation Rules

| Field | Type | Default | Validation |
|-------|------|---------|------------|
| `preValidateCommand` | `string` | `'pnpm install'` | Zod `z.string().default('pnpm install')` |

- Empty string (`''`) is valid and means "skip pre-validate installation"
- Any non-empty string is executed as `sh -c <command>` in the checkout directory
