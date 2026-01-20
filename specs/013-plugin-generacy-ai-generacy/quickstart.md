# Quickstart: @generacy-ai/generacy-plugin-claude-code

## Installation

```bash
# From the monorepo root
npm install

# Or install the package directly (when published)
npm install @generacy-ai/generacy-plugin-claude-code
```

## Prerequisites

- Docker running on the host
- Claude Code installed in the container image
- Valid `ANTHROPIC_API_KEY` environment variable

## Basic Usage

### Simple Invocation

```typescript
import { ClaudeCodePlugin } from '@generacy-ai/generacy-plugin-claude-code';

const plugin = new ClaudeCodePlugin();

// Start a session with container config
const session = await plugin.startSession({
  image: 'generacy/dev-container:latest',
  workdir: '/workspace',
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
  mounts: [
    { source: '/path/to/project', target: '/workspace' },
  ],
  network: 'generacy-network',
});

// Invoke with a prompt
const result = await plugin.invoke({
  prompt: 'Create a hello world function in TypeScript',
  sessionId: session.id,
});

console.log(result.success); // true
console.log(result.filesModified); // ['src/hello.ts']

// End the session
await plugin.endSession(session.id);
```

### Streaming Output

```typescript
const session = await plugin.startSession({ /* config */ });

// Start invocation
plugin.invoke({
  prompt: 'Refactor the authentication module',
  sessionId: session.id,
});

// Stream output in real-time
for await (const chunk of plugin.streamOutput(session.id)) {
  switch (chunk.type) {
    case 'stdout':
      console.log('[OUT]', chunk.data);
      break;
    case 'tool_call':
      console.log('[TOOL]', chunk.metadata?.toolName, chunk.data);
      break;
    case 'error':
      console.error('[ERR]', chunk.data);
      break;
    case 'complete':
      console.log('Done!');
      break;
  }
}
```

### Handling Human Decisions

```typescript
for await (const chunk of plugin.streamOutput(session.id)) {
  if (chunk.type === 'question') {
    const question = chunk.data as QuestionPayload;

    console.log('Agent needs input:', question.question);
    console.log('Urgency:', question.urgency);

    // Get answer from user/system
    const answer = await getUserDecision(question);

    // Continue session with the answer
    await plugin.continueSession(session.id, answer);
  }
}
```

### Setting Agency Mode

```typescript
const session = await plugin.startSession({ /* config */ });

// Set mode before invocation
await plugin.setMode(session.id, 'agentic-full');

const result = await plugin.invoke({
  prompt: 'Implement the feature from the spec',
  sessionId: session.id,
  options: {
    context: JSON.stringify({ featureId: '013' }),
    issueNumber: 13,
  },
});
```

## Configuration Options

### Container Config

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `image` | string | Yes | Docker image with Claude Code |
| `workdir` | string | Yes | Working directory in container |
| `env` | Record<string, string> | No | Environment variables |
| `mounts` | Mount[] | No | Volume mounts |
| `network` | string | Yes | Docker network name |

### Invoke Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | string | - | Agency mode |
| `timeout` | number | 300000 | Max execution time (ms) |
| `tools` | string[] | all | Tool whitelist |
| `context` | string | - | Workflow context (JSON) |
| `issueNumber` | number | - | Associated issue |

## Error Handling

```typescript
import {
  ClaudeCodePlugin,
  InvocationError,
  SessionNotFoundError,
  ContainerStartError,
} from '@generacy-ai/generacy-plugin-claude-code';

try {
  const result = await plugin.invoke({ prompt: '...' });

  if (!result.success && result.error) {
    const error = result.error;

    switch (error.code) {
      case 'CONTAINER_CRASHED':
        // Transient, can retry
        console.log('Container crashed, retrying...');
        break;
      case 'RATE_LIMITED':
        // Transient, back off
        console.log('Rate limited, waiting...');
        break;
      case 'AUTH_FAILED':
        // Not transient, check API key
        throw new Error('Invalid API key');
    }
  }
} catch (e) {
  if (e instanceof SessionNotFoundError) {
    console.log('Session expired, create a new one');
  } else if (e instanceof ContainerStartError) {
    console.log('Docker issue:', e.message);
  }
}
```

## Troubleshooting

### Docker Connection Issues

```bash
# Verify Docker is running
docker info

# Check Docker socket permissions
ls -la /var/run/docker.sock

# Test container creation manually
docker run --rm generacy/dev-container:latest echo "hello"
```

### API Key Issues

```bash
# Verify API key is set
echo $ANTHROPIC_API_KEY

# Test Claude Code CLI directly
claude --version
```

### Session Timeout

```typescript
// Increase timeout for long-running tasks
const result = await plugin.invoke({
  prompt: 'Large refactoring task',
  sessionId: session.id,
  options: {
    timeout: 600000, // 10 minutes
  },
});
```

### Output Parsing Errors

If output parsing fails, raw stdout is returned as a chunk:

```typescript
for await (const chunk of plugin.streamOutput(session.id)) {
  if (chunk.type === 'stdout' && typeof chunk.data === 'string') {
    // Raw output, parsing failed
    console.log('Raw:', chunk.data);
  }
}
```

## Examples

### Integration with Workflow Engine

```typescript
async function executeWorkflowStep(
  plugin: ClaudeCodePlugin,
  step: WorkflowStep,
  context: WorkflowContext
): Promise<StepResult> {
  const session = await plugin.startSession(context.containerConfig);

  try {
    await plugin.setMode(session.id, step.mode);

    const result = await plugin.invoke({
      prompt: step.prompt,
      sessionId: session.id,
      options: {
        context: JSON.stringify(context.state),
        issueNumber: context.issueNumber,
        timeout: step.timeout,
      },
    });

    return {
      success: result.success,
      filesModified: result.filesModified,
      error: result.error,
    };
  } finally {
    await plugin.endSession(session.id);
  }
}
```

### Batch Processing

```typescript
async function processBatch(
  plugin: ClaudeCodePlugin,
  prompts: string[],
  containerConfig: ContainerConfig
): Promise<InvocationResult[]> {
  const results: InvocationResult[] = [];

  for (const prompt of prompts) {
    const session = await plugin.startSession(containerConfig);

    try {
      const result = await plugin.invoke({
        prompt,
        sessionId: session.id,
      });
      results.push(result);
    } finally {
      await plugin.endSession(session.id);
    }
  }

  return results;
}
```
