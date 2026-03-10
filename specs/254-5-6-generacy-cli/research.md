# Research: `generacy doctor` Technical Decisions

## 1. ANSI Color Output Without External Dependencies

Node 20+ supports ANSI escape sequences natively. Rather than adding `chalk` (~50KB), we use direct escape codes:

```typescript
const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
```

Must respect `NO_COLOR` env var (https://no-color.org/) and `--no-pretty` CLI flag. When disabled, symbols change to text: `[PASS]`, `[FAIL]`, `[WARN]`, `[SKIP]`.

## 2. Native `fetch()` for API Validation

Node 20+ includes a stable, global `fetch()` based on Undici. No need for `node-fetch` or `axios`.

### Anthropic API validation
```typescript
const response = await fetch('https://api.anthropic.com/v1/models', {
  method: 'GET',
  headers: {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  },
  signal: AbortSignal.timeout(5000),
});
```

- 200 → key is valid
- 401 → key is invalid
- Other → network/server error (still exit code 1, not 2)

### GitHub API validation
```typescript
const response = await fetch('https://api.github.com/user', {
  headers: { 'Authorization': `Bearer ${token}` },
  signal: AbortSignal.timeout(5000),
});
const scopes = response.headers.get('x-oauth-scopes')?.split(', ') ?? [];
```

Required scopes: `repo`, `workflow`. The `x-oauth-scopes` header is returned on every authenticated request.

## 3. `dotenv.parse()` for Env File Parsing

The `dotenv` package's `parse()` function is standalone — it parses a string and returns `Record<string, string>`. It does NOT modify `process.env`. This is exactly what we need:

```typescript
import { parse as parseDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';

const content = readFileSync(envPath, 'utf-8');
const vars = parseDotenv(content);
// vars: { GITHUB_TOKEN: '...', ANTHROPIC_API_KEY: '...', ... }
```

This handles comments (`#`), quoted values (`KEY="value"`), and is the same parser that will consume the file at runtime.

## 4. Docker Three-Way Detection

`docker info` produces distinct error patterns:

| Failure Mode | stderr Pattern | Fix |
|---|---|---|
| Not installed | Exit code 127 / "command not found" | Install Docker Desktop |
| Daemon not running | "Cannot connect to the Docker daemon" | Start Docker Desktop |
| Permission denied | "permission denied" on socket | `sudo usermod -aG docker $USER` |

Implementation:
```typescript
const result = execSafe('docker info');
if (result.ok) return pass(/* extract version */);
if (result.stderr.includes('not found') || /* exit 127 */) return fail('not installed');
if (result.stderr.includes('Cannot connect')) return fail('daemon not running');
if (result.stderr.includes('permission denied')) return fail('permissions');
return fail('unknown docker error');
```

## 5. Dependency Resolution Algorithm

Topological sort using Kahn's algorithm:

1. Build adjacency list from `dependencies` fields
2. Calculate in-degree for each check
3. Start with checks that have in-degree 0 (no dependencies)
4. Process in tiers: all checks with in-degree 0 form a tier and can run concurrently
5. After a tier completes, reduce in-degree for dependents; next tier is the new zero-in-degree set
6. If the graph isn't fully processed, there's a cycle → throw error at registration time

This naturally produces the execution tiers shown in the plan.

## 6. Concurrent Execution with Timeout

```typescript
async function runWithTimeout(
  check: CheckDefinition,
  context: CheckContext,
  timeoutMs: number = 5000
): Promise<CheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await Promise.race([
      check.run(context),
      new Promise<CheckResult>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(`Check '${check.id}' timed out after ${timeoutMs}ms`));
        });
      }),
    ]);
  } catch (error) {
    return {
      status: 'fail',
      message: `Timed out after ${timeoutMs / 1000}s`,
      suggestion: 'Check your network connection and try again',
    };
  } finally {
    clearTimeout(timer);
  }
}
```

Checks within the same tier run via `Promise.all()`, but results are always displayed in the predefined category order regardless of completion order.

## 7. Context Passing Between Checks

The `CheckContext` object is mutable and shared. When a check completes with status `pass`, it can enrich the context for downstream checks:

- `config` check: sets `context.configPath` and `context.config`
- `env-file` check: sets `context.envVars`

If a check fails, its dependents are automatically skipped with message "Skipped — dependency '{id}' failed". The runner checks dependency results before executing each tier.

## 8. JSON Output Schema

```json
{
  "version": 1,
  "timestamp": "2026-02-26T12:00:00.000Z",
  "summary": {
    "passed": 7,
    "failed": 1,
    "warnings": 0,
    "skipped": 1,
    "total": 9
  },
  "checks": [
    {
      "id": "docker",
      "label": "Docker",
      "category": "system",
      "status": "pass",
      "message": "Docker daemon is running (v27.0.3)",
      "duration_ms": 120
    },
    {
      "id": "anthropic-key",
      "label": "Anthropic Key",
      "category": "credentials",
      "status": "fail",
      "message": "API key is invalid (401 Unauthorized)",
      "suggestion": "Set a valid ANTHROPIC_API_KEY in .generacy/generacy.env",
      "duration_ms": 1200
    }
  ],
  "exitCode": 1
}
```

This schema is versioned (`version: 1`) to allow future changes without breaking consumers.

## 9. Dev Container Detection

To determine if the CLI is running inside a dev container (for conditional checks like Agency MCP):

```typescript
const inDevContainer =
  process.env['REMOTE_CONTAINERS'] === 'true' ||
  process.env['CODESPACES'] === 'true' ||
  existsSync('/.dockerenv');
```

This covers VS Code Remote Containers, GitHub Codespaces, and generic Docker environments.

## 10. `--fix` Flag Future Implementation

The `--fix` flag is registered in Phase 3 but actual fix implementations are deferred. Each check can optionally define a `fix` function:

```typescript
interface CheckDefinition {
  // ... existing fields ...
  fix?: (context: CheckContext) => Promise<FixResult>;
}

interface FixResult {
  success: boolean;
  message: string;
}
```

For Phase 1, when `--fix` is passed and a check fails, the output shows: "Auto-fix not yet available for this check." This avoids scope creep while keeping the CLI interface stable.
