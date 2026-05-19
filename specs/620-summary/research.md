# Research: Orchestrator GitHub Monitors Credential Resolution

## Technology Decisions

### Token Provider Pattern: Function vs Class

**Decision**: Use a simple factory function returning a `() => Promise<string>` closure.

**Rationale**: The token provider has two responsibilities — read a file and parse an env var. A class would over-structure this. A closure captures the file path and caching state cleanly. Matches existing patterns in the codebase (e.g., `createGitHubClient` is a function, not a class factory).

**Alternative rejected**: Class-based `TokenProvider` with `resolve()` method — adds interface overhead for a single-method contract; no benefit over a bare async function.

### File Parsing: Custom vs `dotenv`

**Decision**: Custom line-by-line parser for the env file.

**Rationale**: The `wizard-credentials.env` file is simple `KEY=VALUE` format written by `formatEnvFile()` in `wizard-env-writer.ts`. Adding `dotenv` as a dependency to `@generacy-ai/orchestrator` is unnecessary for parsing 2-3 lines. A 10-line parser handles `KEY=VALUE`, `export KEY=VALUE`, comments, and empty lines.

**Alternative rejected**: `dotenv.parse()` — adds a runtime dependency for trivial parsing.

### File Caching Strategy

**Decision**: Stat-based cache invalidation with short TTL floor.

**Rationale**: Rather than re-reading the file on every `gh` invocation (multiple calls per poll cycle), cache the parsed content. Re-read when `mtime` changes or TTL expires. TTL of 5 seconds ensures freshness while avoiding unnecessary I/O during burst calls (a single poll cycle may invoke `gh` 3-4 times in quick succession).

**Alternative rejected**: No caching — safe but wasteful; reads file 4x per poll cycle per repo. LRU cache with file watcher — over-engineered for a single file.

### GhCliGitHubClient Token Injection Point

**Decision**: Resolve token inside each `gh` CLI method (before `executeCommand`), pass via `env` option.

**Rationale**: `executeCommand` already accepts `{ env }` in options, which gets merged with `process.env` in the spawn call. Setting `GH_TOKEN` here is the minimal, correct injection point. The `gh` CLI checks `GH_TOKEN` env var before falling back to `hosts.yml`.

**Alternative rejected**: Wrapping `executeCommand` globally — too broad; would affect non-GitHub commands. Setting `process.env.GH_TOKEN` globally — race-prone in concurrent poll cycles.

### WebhookSetupService Integration

**Decision**: Pass `tokenProvider` to `WebhookSetupService` constructor; resolve token before each `executeCommand('gh', ...)` call.

**Rationale**: `WebhookSetupService` calls `executeCommand('gh', ...)` directly (not via `GitHubClient`). It needs the same token injection pattern but applied at the `executeCommand` call level rather than through the client abstraction.

### State-Transition Logging

**Decision**: Track `lastTokenResolutionFailed: boolean` state in the token provider; emit log only on transitions.

**Rationale**: Per the clarification (Q4 answer), log one warning when token resolution starts failing and one info when it resumes. This prevents log spam during extended outages (240 warnings/hr at 15s poll interval) while maintaining visibility.

**Implementation**: The token provider function returns `string | undefined`. On `undefined`, callers skip the poll cycle. The provider internally logs state transitions.

## Implementation Patterns

### Pattern: Token Provider Composition

```typescript
// wizard-creds-token-provider.ts
export function createWizardCredsTokenProvider(
  envFilePath: string,
  logger: Logger,
): () => Promise<string | undefined> {
  let cachedToken: string | undefined;
  let lastMtime: number = 0;
  let lastFailed = false;

  return async () => {
    try {
      const stat = await fs.stat(envFilePath);
      if (stat.mtimeMs !== lastMtime) {
        const content = await fs.readFile(envFilePath, 'utf-8');
        cachedToken = parseEnvValue(content, 'GH_TOKEN');
        lastMtime = stat.mtimeMs;
      }
      if (lastFailed) {
        logger.info('GitHub token resolution resumed');
        lastFailed = false;
      }
      return cachedToken;
    } catch {
      if (!lastFailed) {
        logger.warn('GitHub token resolution failed — monitors will skip cycle');
        lastFailed = true;
      }
      return undefined;
    }
  };
}
```

### Pattern: GhCliGitHubClient Token Injection

```typescript
// gh-cli.ts — each method
async listOpenPullRequests(owner: string, repo: string): Promise<PullRequest[]> {
  const env = await this.resolveTokenEnv();
  const result = await executeCommand('gh', [...args], { cwd: this.workdir, env });
  // ...
}

private async resolveTokenEnv(): Promise<Record<string, string> | undefined> {
  if (!this.tokenProvider) return undefined;
  const token = await this.tokenProvider();
  return token ? { GH_TOKEN: token } : undefined;
}
```

## Key References

- `gh` CLI token precedence: `GH_TOKEN` env var > `GH_ENTERPRISE_TOKEN` > `~/.config/gh/hosts.yml` ([gh docs](https://cli.github.com/manual/gh_help_environment))
- `executeCommand` in `cli-utils.ts:110-162` — env merge pattern: `{ ...process.env, ...env }`
- `wizard-env-writer.ts` — `formatEnvFile()` produces `KEY=VALUE\n` format (no quoting, no export prefix)
- `handlePutCredential` in `credentials.ts` — triggers `writeWizardEnvFile()` on credential update, keeping the file fresh post-bootstrap
