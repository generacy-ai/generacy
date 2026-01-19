# Quickstart: Workflow Engine

## Installation

```bash
# Install dependencies
npm install

# Build the project
npm run build
```

## Basic Usage

### Creating a Workflow Engine

```typescript
import { WorkflowEngine } from 'generacy';

// Create engine with default SQLite storage
const engine = new WorkflowEngine();
await engine.initialize();

// Engine is ready to use
```

### Defining a Workflow

```typescript
import { WorkflowDefinition } from 'generacy';

const reviewWorkflow: WorkflowDefinition = {
  name: 'code-review',
  version: '1.0.0',
  steps: [
    {
      id: 'analyze',
      type: 'agent',
      config: {
        command: '/analyze-code',
        mode: 'research',
      },
      next: 'human-review',
    },
    {
      id: 'human-review',
      type: 'human',
      config: {
        action: 'review',
        urgency: 'blocking_soon',
        prompt: 'Review the analysis and approve or request changes',
      },
      next: 'check-approval',
    },
    {
      id: 'check-approval',
      type: 'condition',
      config: {
        expression: 'context.outputs.approval == true',
        then: 'merge',
        else: 'revise',
      },
    },
    {
      id: 'merge',
      type: 'agent',
      config: {
        command: '/merge-pr',
        mode: 'coding',
      },
      // No next - terminal step
    },
    {
      id: 'revise',
      type: 'agent',
      config: {
        command: '/request-changes',
        mode: 'coding',
      },
      next: 'human-review',
    },
  ],
  timeout: 3600000, // 1 hour
};
```

### Starting a Workflow

```typescript
// Provide initial context
const context = {
  input: {
    prNumber: 42,
    repository: 'owner/repo',
  },
  outputs: {},
  data: {},
  metadata: {
    initiator: 'user@example.com',
  },
};

// Start the workflow
const workflowId = await engine.startWorkflow(reviewWorkflow, context);
console.log(`Started workflow: ${workflowId}`);
```

### Subscribing to Events

```typescript
// Listen for all events
engine.onWorkflowEvent((event) => {
  console.log(`[${event.timestamp}] ${event.type}: ${event.workflowId}`);

  if (event.type === 'step:waiting') {
    console.log(`Human action required: ${event.payload.prompt}`);
  }
});
```

### Resuming a Human Step

```typescript
// When human provides input
await engine.resumeWorkflow(workflowId, {
  approval: true,
  comment: 'Looks good!',
});
```

### Querying Workflows

```typescript
// Get a specific workflow
const workflow = await engine.getWorkflow(workflowId);
console.log(`Status: ${workflow?.status}`);

// List all running workflows
const running = await engine.listWorkflows({ status: 'running' });
console.log(`${running.length} workflows running`);

// List waiting for human input
const waiting = await engine.listWorkflows({ status: 'waiting' });
for (const wf of waiting) {
  console.log(`Workflow ${wf.id} waiting for input`);
}
```

### Cancelling a Workflow

```typescript
await engine.cancelWorkflow(workflowId);
```

### Cleanup

```typescript
await engine.shutdown();
```

## Configuration Options

### Custom Storage Adapter

```typescript
import { WorkflowEngine, InMemoryStorageAdapter } from 'generacy';

// For testing: use in-memory storage
const engine = new WorkflowEngine({
  storage: new InMemoryStorageAdapter(),
});
```

### Custom Error Handler

```typescript
import { WorkflowDefinition, ErrorHandler } from 'generacy';

const customErrorHandler: ErrorHandler = {
  onError: (error, step, context) => {
    // Retry transient errors
    if (error.message.includes('timeout')) {
      return { type: 'retry', delay: 5000, maxAttempts: 3 };
    }

    // Escalate critical errors
    if (step.type === 'agent') {
      return { type: 'escalate', urgency: 'blocking_now' };
    }

    // Default: abort
    return { type: 'abort', reason: error.message };
  },
};

const workflow: WorkflowDefinition = {
  name: 'robust-workflow',
  version: '1.0.0',
  steps: [...],
  onError: customErrorHandler,
};
```

## Available Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build the project |
| `npm test` | Run unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage |
| `npm run lint` | Run ESLint |
| `npm run format` | Format with Prettier |

## Troubleshooting

### Workflow Not Persisting

Ensure the storage adapter is properly initialized:

```typescript
const engine = new WorkflowEngine();
await engine.initialize(); // Don't forget this!
```

### Human Step Not Resuming

Make sure you're passing the human input when resuming:

```typescript
// Wrong: no input
await engine.resumeWorkflow(workflowId);

// Correct: with input
await engine.resumeWorkflow(workflowId, {
  decision: 'approved',
});
```

### Condition Not Evaluating

Check your expression syntax:

```typescript
// Correct: quotes around string values
expression: "context.status == 'approved'"

// Wrong: missing quotes
expression: "context.status == approved"
```

### SQLite Database Location

By default, the SQLite database is created at `./workflow-engine.db`. You can customize this:

```typescript
import { SQLiteStorageAdapter } from 'generacy';

const storage = new SQLiteStorageAdapter({
  path: '/custom/path/workflows.db',
});

const engine = new WorkflowEngine({ storage });
```

---

*Generated by speckit*
