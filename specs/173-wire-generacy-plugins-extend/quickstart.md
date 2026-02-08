# Quickstart: Extending Latency Base Classes

## Prerequisites

- pnpm workspace with Latency packages available
- TypeScript 5.6+
- Node.js 20+

## Quick Reference

### Step 1: Add Dependency

```json
// package.json
{
  "dependencies": {
    "@generacy-ai/latency-plugin-dev-agent": "workspace:*"
  }
}
```

Then run:
```bash
pnpm install
```

### Step 2: Update Plugin Class

**Before:**
```typescript
export class MyPlugin implements MyPluginInterface {
  async invoke(prompt: string): Promise<Result> {
    // All logic here
  }
}
```

**After:**
```typescript
import { AbstractDevAgentPlugin } from '@generacy-ai/latency-plugin-dev-agent';

export class MyPlugin extends AbstractDevAgentPlugin {
  protected async doInvoke(
    prompt: string,
    options: InternalInvokeOptions
  ): Promise<AgentResult> {
    // Only provider-specific logic here
  }

  protected async *doInvokeStream(
    prompt: string,
    options: InternalInvokeOptions
  ): AsyncIterableIterator<StreamChunk> {
    // Streaming implementation
  }

  protected async doGetCapabilities(): Promise<AgentCapabilities> {
    return {
      supportsStreaming: true,
      supportsCancel: true,
    };
  }
}
```

### Step 3: Remove Duplicated Code

- Delete local interface definitions that Latency provides
- Remove manual error handling (base class handles it)
- Remove caching logic (for issue trackers)
- Remove timeout management (for dev agents)

## Base Class Quick Reference

| Plugin Type | Base Class | Package |
|-------------|-----------|---------|
| Dev Agent | `AbstractDevAgentPlugin` | `@generacy-ai/latency-plugin-dev-agent` |
| CI/CD | `AbstractCICDPlugin` | `@generacy-ai/latency-plugin-ci-cd` |
| Issue Tracker | `AbstractIssueTrackerPlugin` | `@generacy-ai/latency-plugin-issue-tracker` |

## Testing

After refactoring, verify:

```bash
# Build the package
pnpm --filter @generacy-ai/generacy-plugin-<name> build

# Run tests
pnpm --filter @generacy-ai/generacy-plugin-<name> test
```

## Common Patterns

### Error Handling
```typescript
// Base class catches and normalizes errors
// Just throw standard errors, they become FacetError
protected async doInvoke(...) {
  const result = await this.client.call();
  if (!result.ok) {
    throw new Error(`API error: ${result.message}`);
  }
  return result;
}
```

### Accessing Options
```typescript
protected async doInvoke(prompt: string, options: InternalInvokeOptions) {
  // InternalInvokeOptions includes invocationId for tracking
  const { invocationId, timeoutMs, cancellationToken } = options;

  // Check cancellation
  if (cancellationToken?.isCancelled) {
    throw new Error('Operation cancelled');
  }
}
```

### Overriding Validation
```typescript
// For issue trackers, override validation if needed
protected validateIssueSpec(spec: IssueSpec): void {
  super.validateIssueSpec(spec);
  // Add custom validation
  if (!spec.projectKey) {
    throw new Error('projectKey is required for Jira');
  }
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Cannot find module" | Run `pnpm install` to link workspace dependencies |
| Type errors | Ensure types are exported from Latency package |
| Tests fail | Check if mocking needs to target `do*` methods instead of public methods |
