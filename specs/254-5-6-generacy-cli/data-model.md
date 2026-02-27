# Data Model: `generacy doctor`

## Core Types

### CheckDefinition

The fundamental unit of the doctor system. Each health check is a `CheckDefinition` registered in the check registry.

```typescript
interface CheckDefinition {
  /** Unique identifier used in --check/--skip flags. Kebab-case. */
  id: string;

  /** Human-readable label for output display */
  label: string;

  /** Grouping category for output organization */
  category: CheckCategory;

  /** IDs of checks that must pass before this one runs */
  dependencies: string[];

  /** P1 = core checks; P2 = optional/enhanced checks */
  priority: 'P1' | 'P2';

  /** The async check function */
  run: (context: CheckContext) => Promise<CheckResult>;

  /** Optional auto-fix function (future use) */
  fix?: (context: CheckContext) => Promise<FixResult>;
}
```

### CheckCategory

Categories control output grouping order.

```typescript
type CheckCategory = 'system' | 'config' | 'credentials' | 'packages' | 'services';
```

Display order: system → config → credentials → packages → services

### CheckContext

Mutable shared context passed to all checks. Enriched by earlier checks for downstream consumers.

```typescript
interface CheckContext {
  /** Resolved config file path, set by 'config' check */
  configPath: string | null;

  /** Parsed and validated config, set by 'config' check */
  config: GeneracyConfig | null;

  /** Parsed env vars from .generacy/generacy.env, set by 'env-file' check */
  envVars: Record<string, string> | null;

  /** Whether currently running inside a dev container */
  inDevContainer: boolean;

  /** Whether --verbose flag was passed */
  verbose: boolean;

  /** Project root directory (where .generacy/ lives) */
  projectRoot: string | null;
}
```

### CheckResult

Return value from each check's `run()` function.

```typescript
interface CheckResult {
  /** Outcome of the check */
  status: 'pass' | 'fail' | 'warn' | 'skip';

  /** Human-readable description of the result */
  message: string;

  /** Actionable fix suggestion, shown on fail/warn */
  suggestion?: string;

  /** Extra detail shown only in --verbose mode */
  detail?: string;

  /** Duration of the check in milliseconds */
  duration?: number;
}
```

### DoctorOptions

CLI options parsed by Commander.js.

```typescript
interface DoctorOptions {
  /** Run only these specific checks (plus their dependencies) */
  check?: string[];

  /** Skip these specific checks */
  skip?: string[];

  /** Output as JSON */
  json?: boolean;

  /** Show verbose diagnostic output */
  verbose?: boolean;

  /** Attempt to auto-fix issues */
  fix?: boolean;
}
```

### DoctorReport

Aggregate result of all checks, used by the formatter.

```typescript
interface DoctorReport {
  /** Schema version for JSON output */
  version: number;

  /** ISO 8601 timestamp */
  timestamp: string;

  /** Aggregated counts */
  summary: {
    passed: number;
    failed: number;
    warnings: number;
    skipped: number;
    total: number;
  };

  /** Ordered list of check results */
  checks: Array<{
    id: string;
    label: string;
    category: CheckCategory;
    status: CheckResult['status'];
    message: string;
    suggestion?: string;
    detail?: string;
    duration_ms: number;
  }>;

  /** Exit code to use */
  exitCode: 0 | 1 | 2;
}
```

### FixResult (future)

```typescript
interface FixResult {
  success: boolean;
  message: string;
}
```

## Check Registry

All checks with their IDs, categories, and dependency chains:

| ID | Label | Category | Dependencies | Priority |
|----|-------|----------|-------------|----------|
| `docker` | Docker | system | — | P1 |
| `devcontainer` | Dev Container | system | — | P2 |
| `config` | Config File | config | — | P1 |
| `env-file` | Env File | config | `config` | P1 |
| `github-token` | GitHub Token | credentials | `env-file` | P1 |
| `anthropic-key` | Anthropic Key | credentials | `env-file` | P1 |
| `npm-packages` | npm Packages | packages | — | P2 |
| `agency-mcp` | Agency MCP | services | — | P2 |

## Exit Codes

| Code | Meaning | When |
|------|---------|------|
| 0 | All checks passed | Every check returned `pass` or `skip` |
| 1 | Check(s) failed | At least one check returned `fail` |
| 2 | Runtime error | Unhandled exception in doctor itself |
