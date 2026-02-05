# @generacy-ai/workflow-engine

Core workflow execution engine for Generacy. Provides workflow loading, validation, and execution with extensible action handlers.

## Installation

```bash
npm install @generacy-ai/workflow-engine
```

## Features

- **YAML Workflow Definitions**: Define workflows in easy-to-read YAML format
- **Validation**: Zod-based schema validation with detailed error messages
- **Interpolation**: Variable substitution with `${inputs.*}`, `${steps.*}`, `${env.*}`
- **Retry System**: Configurable retry with constant, linear, and exponential backoff
- **Action Handlers**: Extensible action system for custom integrations
- **Event System**: Subscribe to execution events for monitoring
- **Cancellation**: AbortController support for graceful cancellation

## Usage

### Loading and Executing a Workflow

```typescript
import {
  loadWorkflow,
  prepareWorkflow,
  WorkflowExecutor,
  registerBuiltinActions,
  ConsoleLogger,
} from '@generacy-ai/workflow-engine';

// Register built-in action handlers
registerBuiltinActions();

// Load workflow from file
const definition = await loadWorkflow('./workflow.yaml');

// Prepare for execution
const workflow = prepareWorkflow(definition);

// Create executor
const executor = new WorkflowExecutor({
  logger: new ConsoleLogger(),
});

// Execute with inputs
const result = await executor.execute(
  workflow,
  {
    workdir: process.cwd(),
    env: process.env,
  },
  {
    projectName: 'my-project',
  }
);

console.log('Status:', result.status);
```

### Workflow Definition Format

```yaml
name: build-and-test
description: Build and test a Node.js project

inputs:
  nodeVersion:
    type: string
    default: "20"
    description: Node.js version to use

phases:
  - name: setup
    steps:
      - name: install-deps
        action: shell
        command: npm ci
        env:
          NODE_VERSION: ${inputs.nodeVersion}

  - name: test
    steps:
      - name: run-tests
        action: verification.check
        command: npm test
        retry:
          maxAttempts: 3
          backoff: exponential
          delay: 1s
```

### Custom Action Handlers

```typescript
import {
  BaseAction,
  registerActionHandler,
  type ActionContext,
  type ActionResult,
  type StepDefinition,
} from '@generacy-ai/workflow-engine';

class MyCustomAction extends BaseAction {
  readonly type = 'my.custom';

  canHandle(step: StepDefinition): boolean {
    return step.action === 'my.custom';
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input = this.getInput<string>(step, context, 'message');

    // Do something custom
    context.logger.info(`Custom action: ${input}`);

    return this.successResult({ processed: true });
  }
}

// Register the handler
registerActionHandler(new MyCustomAction());
```

### Event Subscription

```typescript
const executor = new WorkflowExecutor({ logger });

executor.addEventListener((event) => {
  switch (event.type) {
    case 'workflow:start':
      console.log(`Starting workflow: ${event.workflowName}`);
      break;
    case 'step:complete':
      console.log(`Step completed: ${event.stepName}`);
      break;
    case 'workflow:error':
      console.error(`Workflow failed: ${event.message}`);
      break;
  }
});
```

### Interpolation

The engine supports variable interpolation in step configurations:

- `${inputs.name}` - Access workflow inputs
- `${steps.stepName.output.field}` - Access output from previous steps
- `${env.VAR_NAME}` - Access environment variables

### Retry Configuration

Steps can be configured with retry settings:

```yaml
retry:
  maxAttempts: 5
  backoff: exponential  # constant, linear, or exponential
  delay: 1s             # Initial delay
  maxDelay: 30s         # Maximum delay (for exponential)
  jitter: true          # Add randomness to delays
```

## Built-in Actions

- **shell**: Execute shell commands
- **workspace.prepare**: Git checkout/branch operations
- **agent.invoke**: Invoke Claude CLI for AI tasks
- **verification.check**: Run tests and linting
- **github.pr-create**: Create GitHub pull requests
- **speckit.\***: Spec-driven development methodology operations

### Speckit Actions

The speckit action handler implements a spec-driven development methodology with the following operations:

**Deterministic Operations** (direct library calls):
- `speckit.create_feature` - Create feature branch and initialize spec directory
- `speckit.get_paths` - Get feature directory paths from branch name
- `speckit.check_prereqs` - Validate required spec files exist
- `speckit.copy_template` - Copy template files to feature directory

**AI-Dependent Operations** (agent delegation via Claude CLI):
- `speckit.specify` - Generate spec.md from feature description
- `speckit.clarify` - Generate clarification questions and post to issue
- `speckit.plan` - Generate implementation plan from spec
- `speckit.tasks` - Generate task list from plan
- `speckit.implement` - Execute tasks with progress tracking

**Example usage:**

```yaml
phases:
  - name: setup
    steps:
      - name: create-feature
        uses: speckit.create_feature
        with:
          description: "Add user authentication"

  - name: specification
    steps:
      - name: specify
        uses: speckit.specify
        with:
          feature_dir: ${{ steps.create-feature.output.feature_dir }}
        gate: spec-review  # Optional review checkpoint

  - name: planning
    steps:
      - name: plan
        uses: speckit.plan
        with:
          feature_dir: ${{ steps.create-feature.output.feature_dir }}
        gate: plan-review
```

**Gate Configuration:**

Steps can include a `gate` field to pause workflow for human review:
- `spec-review` - Review specification before proceeding
- `plan-review` - Review implementation plan
- `tasks-review` - Review task breakdown

See `workflows/speckit-feature.yaml` for a complete example workflow.

## API Reference

### Main Exports

```typescript
// Executor
export { WorkflowExecutor, ExecutionEventEmitter };

// Loader
export { loadWorkflow, loadWorkflowFromString, prepareWorkflow, validateWorkflow };

// Actions
export { registerActionHandler, getActionHandler, BaseAction };

// Interpolation
export { interpolate, ExecutionContext };

// Retry
export { RetryManager, withTimeout };

// Types
export type {
  WorkflowDefinition,
  ExecutionResult,
  ActionHandler,
  // ... and more
};
```

## License

MIT
