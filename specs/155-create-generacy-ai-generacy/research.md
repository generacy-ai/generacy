# Research: @generacy-ai/generacy

Technology decisions and implementation patterns for the headless workflow execution package.

## Technology Decisions

### 1. CLI Framework: Commander.js

**Choice**: Commander.js v12+

**Alternatives Considered**:
- **yargs** - Feature-rich but heavier, more complex API
- **oclif** - Full framework, overkill for 3 commands
- **cac** - Lightweight but less ecosystem support
- **citty** - Modern but newer/less mature

**Rationale**:
- Simple, declarative API for subcommands
- Well-documented with TypeScript support
- Tree-shakeable for minimal bundle size
- 30K GitHub stars, battle-tested
- Used by many popular CLIs (Vue CLI, webpack-cli)

**Usage Pattern**:
```typescript
import { program } from 'commander';

program
  .name('generacy')
  .description('Headless workflow execution')
  .version('0.1.0');

program
  .command('run <workflow>')
  .description('Run a workflow file')
  .option('-i, --input <key=value...>', 'Input variables')
  .action(runCommand);
```

### 2. Logging: Pino

**Choice**: Pino v9+

**Alternatives Considered**:
- **winston** - Feature-rich but heavier, slower
- **bunyan** - Good JSON logging but less maintained
- **consola** - Pretty console but less structured
- **signale** - Pretty but no JSON mode

**Rationale**:
- Fastest JSON logger (benchmarked)
- Native TypeScript support
- Structured logging for container environments
- `pino-pretty` for human-readable local output
- Child loggers for component isolation

**Usage Pattern**:
```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty' }
    : undefined
});

logger.child({ component: 'orchestrator' }).info('Connecting');
```

### 3. HTTP Client: Native Fetch

**Choice**: Node.js native fetch API

**Alternatives Considered**:
- **axios** - Popular but adds ~30KB
- **got** - Full-featured but heavier
- **undici** - Fast but complex API
- **ky** - Fetch wrapper, unnecessary layer

**Rationale**:
- Built into Node.js 20+ (no dependencies)
- Standard web API (portable code)
- Sufficient for REST + polling pattern
- AbortController integration built-in

**Usage Pattern**:
```typescript
const response = await fetch(`${baseUrl}/api/queue/jobs/next`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workerId }),
  signal: AbortSignal.timeout(30000)
});
```

### 4. Schema Validation: Zod

**Choice**: Zod v3.23+ (already used in orchestrator)

**Rationale**:
- Already used across the monorepo
- TypeScript inference from schemas
- Runtime validation for API responses
- Composable schema definitions

### 5. Orchestrator Communication: REST + Polling

**Choice**: HTTP REST API with polling for job dispatch

**Alternatives Considered**:
- **WebSocket** - Real-time but complex reconnection
- **gRPC** - Fast but requires code generation
- **Server-Sent Events** - One-way, not bidirectional

**Rationale**:
- Existing orchestrator already exposes REST API
- Polling interval configurable (e.g., 5 seconds)
- Simpler error handling and retry logic
- No persistent connection management
- Easier debugging and monitoring

**Polling Pattern**:
```typescript
async function pollForJobs(client: OrchestratorClient) {
  const pollInterval = 5000; // 5 seconds

  while (!signal.aborted) {
    const job = await client.pollForJob();
    if (job) {
      await processJob(job);
    }
    await sleep(pollInterval);
  }
}
```

### 6. Agency Connection: Dual Mode

**Choice**: Support both subprocess stdio and network HTTP modes

**Subprocess Mode (Default)**:
- Launch Agency MCP as child process
- Communicate via stdio (stdin/stdout)
- MCP default transport
- Best for single-agent containers

**Network Mode (Optional)**:
- Connect to Agency running as HTTP service
- Uses HTTP-based MCP transport
- Best for shared Agency instances
- Enables Agency scaling separate from workers

**Selection Pattern**:
```typescript
const agency = config.agencyUrl
  ? new NetworkAgency(config.agencyUrl)
  : new SubprocessAgency(config.agencyPath);
```

## Implementation Patterns

### 1. Dependency Injection for Testability

The workflow engine uses constructor injection for all external dependencies:

```typescript
interface ExecutorDependencies {
  logger: Logger;
  actionRegistry: ActionRegistry;
  signalProvider?: () => AbortSignal;
}

class WorkflowExecutor {
  constructor(deps: ExecutorDependencies) {
    this.logger = deps.logger;
    this.actions = deps.actionRegistry;
    this.signal = deps.signalProvider?.() ?? new AbortController().signal;
  }
}
```

### 2. Event-Driven Execution Tracking

The executor emits events for all state changes:

```typescript
type ExecutorEvent =
  | 'workflow:start'
  | 'workflow:complete'
  | 'workflow:error'
  | 'phase:start'
  | 'phase:complete'
  | 'step:start'
  | 'step:complete'
  | 'step:retry';

executor.on('step:complete', ({ step, result, duration }) => {
  logger.info({ step: step.id, status: result.status, duration }, 'Step completed');
});
```

### 3. Graceful Shutdown

Handle SIGTERM/SIGINT for container orchestration:

```typescript
const controller = new AbortController();

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  controller.abort();
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully');
  controller.abort();
});

// Pass signal to all async operations
await executor.execute(workflow, { signal: controller.signal });
```

### 4. Health Check Pattern

Simple HTTP endpoint for container health probes:

```typescript
import { createServer } from 'http';

const healthServer = createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    const status = worker.isHealthy() ? 200 : 503;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: worker.isHealthy() ? 'healthy' : 'unhealthy',
      uptime: process.uptime(),
      lastHeartbeat: worker.lastHeartbeat
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(config.healthPort || 8080);
```

### 5. Action Handler Plugin Pattern

Extensible action system via registry:

```typescript
interface ActionHandler {
  type: string;
  canHandle(step: WorkflowStep): boolean;
  execute(step: WorkflowStep, context: ActionContext): Promise<ActionResult>;
}

const registry = new ActionRegistry();
registry.register(new WorkspacePrepareAction());
registry.register(new AgentInvokeAction());
registry.register(new ShellAction()); // Fallback

// Lookup with priority
const handler = registry.getHandler(step);
```

### 6. Interpolation Pattern

Variable substitution using path-based references:

```typescript
// Pattern: ${source.path.to.value}
const patterns = {
  inputs: (key: string) => context.inputs[key],
  steps: (path: string) => getDeepValue(context.stepOutputs, path),
  env: (key: string) => process.env[key]
};

function interpolate(template: string, context: ExecutionContext): string {
  return template.replace(/\$\{(\w+)\.([^}]+)\}/g, (_, source, path) => {
    return patterns[source]?.(path) ?? '';
  });
}
```

## Key References

1. **MCP Specification** - https://spec.modelcontextprotocol.io/
2. **Commander.js Docs** - https://github.com/tj/commander.js
3. **Pino Documentation** - https://getpino.io/
4. **Node.js Fetch API** - https://nodejs.org/api/globals.html#fetch
5. **Zod Documentation** - https://zod.dev/

## Existing Code Analysis

### Files to Extract from VS Code Extension

| File | Lines | VS Code Deps | Extraction Difficulty |
|------|-------|--------------|----------------------|
| `executor.ts` | 935 | AbortController only | Easy |
| `types.ts` | 207 | None | Trivial |
| `actions/base-action.ts` | 201 | None | Trivial |
| `actions/index.ts` | 151 | None | Trivial |
| `actions/types.ts` | 322 | None | Trivial |
| `actions/cli-utils.ts` | 289 | None | Trivial |
| `interpolation/*` | ~640 | None | Trivial |
| `retry/*` | ~500 | None | Trivial |

### VS Code-Specific Files (Not Extracted)

| File | Purpose | Replacement in CLI |
|------|---------|-------------------|
| `terminal.ts` | VS Code terminal | Console output |
| `output-channel.ts` | VS Code output panel | Pino logger |
| `debug-integration.ts` | Debug adapter | N/A (no debugging) |

### Orchestrator API Endpoints (Existing)

From `packages/orchestrator/src/types/api.ts`:

```typescript
// Agent registration
POST /api/agents/register
POST /api/agents/heartbeat
POST /api/agents/unregister

// Job queue
POST /api/queue/jobs/next      // Poll for next job
PUT  /api/queue/jobs/:id       // Update job status
POST /api/queue/jobs/:id/result // Report result

// Workflow execution
POST /api/workflows            // Create workflow
GET  /api/workflows/:id        // Get status
POST /api/workflows/:id/cancel // Cancel workflow
```

---

*Generated by speckit*
