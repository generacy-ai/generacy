# Data Model: Validate phase fix

## Schema Change

The only data model change is the default value of a single Zod schema field.

### WorkerConfigSchema (packages/orchestrator/src/worker/config.ts)

```typescript
// WorkerConfig type — unchanged shape, only default differs
interface WorkerConfig {
  phaseTimeoutMs: number;          // default: 600_000
  workspaceDir: string;            // default: '/tmp/orchestrator-workspaces'
  shutdownGracePeriodMs: number;   // default: 5000
  validateCommand: string;         // default: 'pnpm test && pnpm build'
  preValidateCommand: string;      // default: 'pnpm install && pnpm -r --filter ./packages/* build'  ← CHANGED
  maxImplementRetries: number;     // default: 2
  gates: Record<string, GateDefinition[]>;
}
```

### Before → After

| Field | Before | After |
|-------|--------|-------|
| `preValidateCommand` default | `'pnpm install'` | `'pnpm install && pnpm -r --filter ./packages/* build'` |

No new types, interfaces, or entities introduced.
