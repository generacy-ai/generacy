# Quickstart: Workflow Step Execution Engine

## Overview

The workflow step execution engine enables running workflows locally in VS Code. It executes workflow steps sequentially, captures outputs for variable interpolation, and supports debugging with breakpoints.

## Prerequisites

- Node.js 18+
- VS Code 1.85+
- Git CLI installed
- GitHub CLI (`gh`) installed (for PR actions)
- Claude Code CLI installed (for agent invocation)

## Installation

The workflow runner is part of the Generacy VS Code extension:

```bash
# Install dependencies
cd packages/generacy-extension
npm install

# Build the extension
npm run build
```

## Usage

### Basic Workflow Execution

```typescript
import { getWorkflowExecutor } from './views/local/runner';

const executor = getWorkflowExecutor();

// Define a workflow
const workflow = {
  name: 'feature-branch',
  phases: [{
    name: 'setup',
    steps: [{
      name: 'create-branch',
      action: 'workspace.prepare',
      with: {
        branch: 'feature/my-feature',
        baseBranch: 'main'
      }
    }]
  }]
};

// Execute
const result = await executor.execute(workflow, { mode: 'normal' });
console.log(result.status); // 'completed' or 'failed'
```

### With Variable Interpolation

```typescript
const workflow = {
  name: 'with-variables',
  phases: [{
    name: 'test',
    steps: [
      {
        name: 'run-tests',
        action: 'verification.check',
        with: { command: 'npm test' }
      },
      {
        name: 'report',
        action: 'shell',
        command: 'echo "Tests passed: ${steps.run-tests.output.testsPassed}"'
      }
    ]
  }]
};

// Pass inputs
const result = await executor.execute(workflow, { mode: 'normal' }, {
  issueNumber: 42
});
```

### Dry Run Mode

```typescript
const result = await executor.execute(workflow, { mode: 'dry-run' });
// Steps are validated but not executed
```

### With Event Listeners

```typescript
const disposable = executor.addEventListener((event) => {
  switch (event.type) {
    case 'step:start':
      console.log(`Starting: ${event.stepName}`);
      break;
    case 'step:complete':
      console.log(`Completed: ${event.stepName}`);
      break;
    case 'step:error':
      console.error(`Failed: ${event.stepName} - ${event.message}`);
      break;
  }
});

// Cleanup
disposable.dispose();
```

## Available Commands

### Action Types

| Action | Description | Required Inputs |
|--------|-------------|-----------------|
| `workspace.prepare` | Git branch operations | `branch` |
| `agent.invoke` | Claude Code CLI | `prompt` |
| `verification.check` | Test/lint execution | `command` |
| `pr.create` | GitHub PR creation | `title` |
| `shell` | Generic shell command | `command` or `script` |

### Executor Methods

```typescript
// Check status
executor.getStatus()        // 'idle' | 'running' | 'completed' | 'failed'
executor.isRunning()        // boolean
executor.getCurrentExecution()  // ExecutionResult | undefined

// Control execution
executor.cancel()           // Cancel running workflow
executor.validate(workflow) // Dry-run validation

// Event handling
executor.addEventListener(listener)  // Returns Disposable
```

## Configuration Options

### ExecutionOptions

```typescript
interface ExecutionOptions {
  mode: 'normal' | 'dry-run';
  env?: Record<string, string>;    // Environment variables
  cwd?: string;                    // Working directory
  startPhase?: string;             // Resume from phase
  startStep?: string;              // Resume from step
  verbose?: boolean;               // Enable verbose logging
}
```

### Retry Configuration

```typescript
// Per-step retry
{
  name: 'flaky-step',
  action: 'verification.check',
  with: { command: 'npm test' },
  retry: {
    maxAttempts: 3,
    delay: 1000,        // 1 second
    backoff: 'exponential',
    maxDelay: 30000,    // 30 seconds max
    jitter: 0.1         // 10% randomness
  }
}
```

## Troubleshooting

### CLI Not Found

```
Error: Claude Code CLI is not available
```

**Solution**: Install Claude Code CLI:
```bash
npm install -g @anthropic/claude-code
```

### GitHub CLI Authentication

```
Error: gh: Not logged in
```

**Solution**: Authenticate with GitHub:
```bash
gh auth login
```

### Timeout Errors

```
Error: Process killed due to timeout
```

**Solution**: Increase step timeout:
```typescript
{
  name: 'long-running',
  action: 'agent.invoke',
  with: { prompt: '...' },
  timeout: 600000  // 10 minutes
}
```

### Git Branch Errors

```
Error: Failed to checkout branch: fatal: A branch named 'X' already exists
```

**Solution**: Use force checkout:
```typescript
{
  name: 'checkout',
  action: 'workspace.prepare',
  with: { branch: 'feature/X', force: true }
}
```

## Debugging

### Enable Debug Hooks

```typescript
import { getDebugHooks } from './views/local/runner/debug-integration';

const hooks = getDebugHooks();
hooks.enable();

// Add breakpoint
hooks.addBreakpoint({
  id: 'bp1',
  stepName: 'run-tests',
  enabled: true
});

// Resume when paused
hooks.resume();
```

### Step Inspection

```typescript
hooks.setCallbacks({
  onPause: (state, breakpoint) => {
    console.log('Paused at:', state.step.name);
    console.log('Step index:', state.stepIndex);
  },
  onAfterStep: (state) => {
    console.log('Result:', state.result);
  }
});
```

## Example Workflow

Complete example with all action types:

```typescript
const fullWorkflow = {
  name: 'complete-feature',
  env: {
    NODE_ENV: 'test'
  },
  phases: [
    {
      name: 'setup',
      steps: [{
        name: 'create-branch',
        action: 'workspace.prepare',
        with: {
          branch: '${inputs.branchName}',
          baseBranch: 'develop'
        }
      }]
    },
    {
      name: 'develop',
      steps: [{
        name: 'implement',
        action: 'agent.invoke',
        with: {
          prompt: 'Implement feature: ${inputs.featureDescription}',
          maxTurns: 10
        },
        timeout: 300000
      }]
    },
    {
      name: 'verify',
      steps: [
        {
          name: 'test',
          action: 'verification.check',
          with: { command: 'npm test' },
          retry: { maxAttempts: 2, delay: 5000 }
        },
        {
          name: 'lint',
          action: 'verification.check',
          with: { command: 'npm run lint' }
        }
      ]
    },
    {
      name: 'publish',
      condition: 'success()',
      steps: [{
        name: 'create-pr',
        action: 'pr.create',
        with: {
          title: 'Feature: ${inputs.featureTitle}',
          body: '${steps.implement.output.summary}',
          draft: true
        }
      }]
    }
  ]
};

// Execute with inputs
await executor.execute(fullWorkflow, { mode: 'normal' }, {
  branchName: 'feature/user-auth',
  featureDescription: 'Add user authentication with JWT',
  featureTitle: 'User Authentication'
});
```
