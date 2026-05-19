# Data Model: Orchestrator GitHub Monitors Credential Resolution

## Type Changes

### GitHubClientFactory (modified)

**File**: `packages/workflow-engine/src/actions/github/client/interface.ts`

```typescript
// BEFORE
export type GitHubClientFactory = (workdir?: string) => GitHubClient;

// AFTER
export type GitHubClientFactory = (
  workdir?: string,
  tokenProvider?: () => Promise<string | undefined>,
) => GitHubClient;
```

**Notes**: `tokenProvider` is optional at the factory call level — callers that don't need token injection (worker processes) pass `undefined`. The factory itself remains a synchronous function; token resolution is deferred to each `gh` CLI invocation.

### GhCliGitHubClient Constructor (modified)

**File**: `packages/workflow-engine/src/actions/github/client/gh-cli.ts`

```typescript
// BEFORE
export class GhCliGitHubClient implements GitHubClient {
  private workdir: string;
  constructor(workdir?: string) {
    this.workdir = workdir ?? process.cwd();
  }
}

// AFTER
export class GhCliGitHubClient implements GitHubClient {
  private workdir: string;
  private tokenProvider?: () => Promise<string | undefined>;

  constructor(
    workdir?: string,
    tokenProvider?: () => Promise<string | undefined>,
  ) {
    this.workdir = workdir ?? process.cwd();
    this.tokenProvider = tokenProvider;
  }
}
```

### createGitHubClient Factory (modified)

**File**: `packages/workflow-engine/src/actions/github/client/index.ts`

```typescript
// BEFORE
export function createGitHubClient(workdir?: string): GitHubClient {
  return new GhCliGitHubClient(workdir);
}

// AFTER
export function createGitHubClient(
  workdir?: string,
  tokenProvider?: () => Promise<string | undefined>,
): GitHubClient {
  return new GhCliGitHubClient(workdir, tokenProvider);
}
```

### Token Provider Function Type (new)

**File**: `packages/orchestrator/src/services/wizard-creds-token-provider.ts`

```typescript
import type { Logger } from 'pino';

export type TokenProvider = () => Promise<string | undefined>;

export function createWizardCredsTokenProvider(
  envFilePath: string,
  logger: Logger,
): TokenProvider;
```

**Return type**: `string | undefined` — `undefined` signals resolution failure (file missing, `GH_TOKEN` not found). Callers must handle `undefined` by skipping the operation.

## Env File Format

**Path**: `/var/lib/generacy/wizard-credentials.env`

```env
GH_TOKEN=ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- Written by `wizard-env-writer.ts:formatEnvFile()` — simple `KEY=VALUE\n` format
- No quoting, no `export` prefix, no comments
- Mode `0600`, owned by orchestrator process uid

## Entity Relationships

```
wizard-credentials.env  ──read by──>  WizardCredsTokenProvider
                                            │
                                      () => Promise<string | undefined>
                                            │
                        ┌───────────────────┼───────────────────┐
                        ▼                   ▼                   ▼
              PrFeedbackMonitor    LabelMonitor         LabelSync
              Service              Service              Service
                        │                   │                   │
                        ▼                   ▼                   ▼
              GitHubClientFactory(workdir, tokenProvider)
                        │
                        ▼
              GhCliGitHubClient
                        │
              resolveTokenEnv() → { GH_TOKEN: token }
                        │
                        ▼
              executeCommand('gh', args, { env: { GH_TOKEN } })

WebhookSetupService ──resolve token──> executeCommand('gh', args, { env: { GH_TOKEN } })

Worker processes (claude-cli-worker, pr-feedback-handler):
  createGitHubClient(checkoutPath, undefined)  →  no token injection (credhelper session env)
```

## Validation Rules

| Field | Rule | Error Behavior |
|-------|------|----------------|
| `envFilePath` | Must be absolute path | Throw at provider creation time |
| `GH_TOKEN` value | Non-empty string after parse | Return `undefined` (token resolution failed) |
| Env file existence | `fs.stat()` check | Return `undefined`, log state transition |
| Env file permissions | Trusted (written by control-plane with mode 0600) | No validation needed |
