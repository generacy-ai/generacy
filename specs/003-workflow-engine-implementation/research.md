# Research: Workflow Engine Implementation

## Technology Decisions

### 1. Storage: SQLite with better-sqlite3

**Choice**: SQLite via `better-sqlite3` as the default storage adapter

**Rationale**:
- Zero external dependencies (embedded database)
- Synchronous API simplifies transaction handling
- Excellent performance for single-node deployments
- Native JSON column support for workflow state
- Proven reliability for millions of workflows

**Alternatives Considered**:
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| better-sqlite3 | Fast, synchronous, no setup | Single node only | **Selected** |
| LevelDB | Key-value simplicity | Limited querying | Rejected |
| PostgreSQL | Scalable, full SQL | External dependency | Future adapter |
| File-based JSON | Simple implementation | No ACID, poor concurrency | Rejected |

### 2. Event System: Simple Event Emitter

**Choice**: Custom lightweight event emitter pattern

**Rationale**:
- TypeScript-first with strongly typed events
- No external dependencies
- Sufficient for initial needs
- Easy to upgrade to more robust solution if needed

**Event Types**:
```typescript
type WorkflowEventType =
  | 'workflow:created'
  | 'workflow:started'
  | 'workflow:paused'
  | 'workflow:resumed'
  | 'workflow:completed'
  | 'workflow:failed'
  | 'workflow:cancelled'
  | 'step:started'
  | 'step:completed'
  | 'step:failed'
  | 'step:waiting'    // Human step waiting for input
  | 'step:timeout';
```

### 3. Condition Evaluation: Property Path Syntax

**Choice**: Custom property path parser (no JavaScript eval)

**Rationale**:
- Security: No arbitrary code execution
- Predictability: Limited operator set is easy to reason about
- Debuggability: Clear error messages for invalid expressions
- Performance: Simple parsing, no runtime compilation

**Supported Syntax**:
```
property.path == value
property.path != value
property.path > value
property.path < value
property.path >= value
property.path <= value
property.path contains value
property.path exists
!property.path exists
```

**Parser Strategy**:
1. Split expression into path, operator, value
2. Resolve path against context object
3. Apply operator comparison
4. Return boolean result

### 4. Parallel Execution: Promise.all / Promise.race

**Choice**: Native Promise-based parallel execution

**Rationale**:
- Built-in to JavaScript runtime
- `Promise.all` for join: 'all' semantics
- `Promise.race` for join: 'any' semantics
- Error propagation handled naturally
- No additional dependencies

**Implementation Pattern**:
```typescript
async function executeParallel(branches: WorkflowStep[][], join: 'all' | 'any') {
  const branchPromises = branches.map(branch => executeBranch(branch));

  if (join === 'all') {
    return Promise.all(branchPromises);
  } else {
    return Promise.race(branchPromises);
  }
}
```

### 5. Build System: tsup

**Choice**: tsup for TypeScript compilation and bundling

**Rationale**:
- Zero-config for most use cases
- ESM-first with CJS fallback
- Fast builds via esbuild
- Type declaration generation
- Tree-shaking support

**Configuration**:
```typescript
// tsup.config.ts
export default {
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
};
```

### 6. Testing: Vitest

**Choice**: Vitest for unit and integration testing

**Rationale**:
- ESM-native, fast startup
- Jest-compatible API (familiar)
- Built-in TypeScript support
- Watch mode with smart re-runs
- Integrated coverage reporting

## Implementation Patterns

### State Machine Pattern

The workflow engine uses a finite state machine for workflow lifecycle:

```typescript
const transitions: Record<WorkflowStatus, WorkflowStatus[]> = {
  created: ['running', 'cancelled'],
  running: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  completed: [], // terminal
  failed: [],    // terminal
  cancelled: [], // terminal
};

function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return transitions[from]?.includes(to) ?? false;
}
```

### Repository Pattern for Storage

Clean separation between domain logic and persistence:

```typescript
interface StorageAdapter {
  // Core CRUD
  save(workflow: WorkflowState): Promise<void>;
  load(id: string): Promise<WorkflowState | undefined>;
  delete(id: string): Promise<void>;

  // Queries
  list(filter?: WorkflowFilter): Promise<WorkflowState[]>;

  // Lifecycle
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}
```

### Executor Strategy Pattern

Different step types handled by specialized executors:

```typescript
interface StepExecutor<T extends WorkflowStep = WorkflowStep> {
  execute(step: T, context: WorkflowContext): Promise<StepResult>;
  canHandle(step: WorkflowStep): step is T;
}

// Factory selects appropriate executor
function getExecutor(step: WorkflowStep): StepExecutor {
  const executor = executors.find(e => e.canHandle(step));
  if (!executor) throw new Error(`No executor for step type: ${step.type}`);
  return executor;
}
```

### Error Handling Strategy

Configurable error responses per workflow:

```typescript
interface ErrorHandler {
  onError(error: Error, step: WorkflowStep, context: WorkflowContext): ErrorAction;
}

// Default implementation
const defaultErrorHandler: ErrorHandler = {
  onError: (error, step) => ({
    type: 'abort',
    reason: `Step ${step.id} failed: ${error.message}`,
  }),
};

// With retries
const retryHandler: ErrorHandler = {
  onError: (error, step, context) => {
    const attempts = context.stepAttempts?.[step.id] ?? 0;
    if (attempts < (step.retries ?? 3)) {
      return { type: 'retry', delay: 1000 * Math.pow(2, attempts) };
    }
    return { type: 'escalate', urgency: 'blocking_soon' };
  },
};
```

## Key References

### Workflow Engine Patterns
- [Temporal.io documentation](https://docs.temporal.io/) - Industry-leading workflow orchestration patterns
- [XState documentation](https://xstate.js.org/docs/) - State machine patterns for JavaScript
- [AWS Step Functions](https://docs.aws.amazon.com/step-functions/) - Cloud workflow service patterns

### SQLite Best Practices
- [better-sqlite3 documentation](https://github.com/WiseLibs/better-sqlite3) - API reference
- [SQLite JSON1 extension](https://www.sqlite.org/json1.html) - JSON column operations

### TypeScript Patterns
- [TypeScript Deep Dive](https://basarat.gitbook.io/typescript/) - Advanced TypeScript patterns
- [Type-safe event emitters](https://github.com/andywer/typed-emitter) - Inspiration for typed events

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| SQLite lock contention | Write-ahead logging (WAL) mode |
| Memory pressure from large workflows | Lazy loading of step results |
| Orphaned workflows on crash | Startup recovery scan |
| Parallel branch race conditions | Isolated context per branch |

---

*Generated by speckit*
