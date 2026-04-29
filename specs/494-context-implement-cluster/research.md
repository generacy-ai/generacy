# Research: CLI Cluster Lifecycle Commands (#494)

## Technology Decisions

### Docker Compose v2 CLI

**Decision**: Use `docker compose` (v2, space-separated) not `docker-compose` (v1, hyphenated).

**Rationale**: Docker Compose v2 is the standard since Docker Desktop 3.4+ and standalone installs. v1 is deprecated. The spec assumes v2 is installed.

**Key commands used**:
| Command | Flags | Purpose |
|---------|-------|---------|
| `docker compose up -d` | `--project-name`, `--file` | Start cluster |
| `docker compose stop` | `--project-name`, `--file` | Stop containers (preserve) |
| `docker compose down` | `--project-name`, `--file`, optional `--volumes` | Remove containers |
| `docker compose down -v` | `--project-name`, `--file` | Remove containers + volumes |
| `docker compose pull` | `--project-name`, `--file` | Pull latest images |
| `docker compose ps` | `--project-name`, `--file`, `--format json` | Query state |

### Execution Strategy: `execSafe` (synchronous)

**Decision**: Use the existing `execSafe()` utility for all Docker Compose calls.

**Alternatives considered**:
- `exec()` (throws on failure) — rejected because we need structured error messages, not stack traces
- `child_process.spawn` (async streaming) — rejected because compose operations are fast enough for sync; output is small
- Direct Docker API via dockerode — rejected as over-engineered; compose CLI already provides the abstraction

**Rationale**: `execSafe` returns `{ok, stdout, stderr}` which maps cleanly to user-friendly error reporting. Logger captures the command at debug level for troubleshooting.

### Registry File Format

**Decision**: Simple JSON array at `~/.generacy/clusters.json`.

**Alternatives considered**:
- SQLite — rejected as heavyweight for a simple registry
- YAML — rejected for consistency with `cluster.json` which is also JSON
- JSON Lines — rejected since we need random access for updates/deletes

**Rationale**: The registry is small (dozens of entries at most). Full read-modify-write with atomic temp+rename is sufficient. No concurrent writers in normal operation.

### Interactive Prompts

**Decision**: Use `@clack/prompts` for the `destroy` confirmation.

**Rationale**: Consistent with the existing `init` command. `p.confirm()` provides a clean yes/no prompt. `p.isCancel()` handles Ctrl+C gracefully (exit 130).

### Directory Walk for Context Resolution

**Decision**: `getClusterContext(cwd)` walks upward from `cwd` looking for `.generacy/cluster.yaml`.

**Rationale**: Matches how tools like `git` find their root. Users can run `generacy up` from any subdirectory of their project.

**Implementation**: Use a simple loop: check `path.join(dir, '.generacy', 'cluster.yaml')` → if exists, return; else `dir = path.dirname(dir)` until root.

### Status Output: `docker compose ps --format json`

**Decision**: Parse JSON output from `docker compose ps`.

**Alternatives considered**:
- Parse tabular output — rejected as fragile across Docker versions
- Docker Engine API — rejected as too low-level (would bypass compose project grouping)

**Rationale**: `--format json` is stable in Compose v2.20+. Returns an array of objects with `Name`, `State`, `Status`, `Service` fields. If the format flag isn't supported (older v2), fall back to checking exit code of `docker compose ps` (non-zero = not running).

## Implementation Patterns

### Error Handling Flow

```
1. Check Docker availability: `docker compose version`
   → Not found: "Docker Compose is not installed or not in PATH"
   → Daemon not running: "Docker daemon is not running. Start Docker and try again."

2. Resolve cluster context: getClusterContext(cwd)
   → No .generacy/ found: "No cluster found. Run 'generacy init' first."
   → No docker-compose.yml: "Compose file missing at .generacy/docker-compose.yml"

3. Execute compose command
   → Non-zero exit: show stderr, suggest common fixes
```

### Registry Update Pattern

```
read registry → find entry by clusterId or path → update/insert → atomic write
```

The registry is keyed by `path` (absolute path to project root) as the primary identifier, with `clusterId` as secondary. This handles the case where `cluster.json` doesn't exist yet.

### Command Lifecycle

Each command follows the same skeleton:

```typescript
export function xCommand(): Command {
  return new Command('x')
    .description('...')
    .option('--flag', '...')
    .action(async (options) => {
      const logger = getLogger();
      ensureDocker();                    // 1. Fail fast
      const ctx = getClusterContext();   // 2. Resolve context
      runCompose(ctx, ['...']);           // 3. Execute
      updateRegistry(ctx);               // 4. Update registry (if applicable)
      logger.info('Done');               // 5. Report
    });
}
```
