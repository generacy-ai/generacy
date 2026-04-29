# Research: CLI claude-login and open commands

**Feature**: #496 | **Date**: 2026-04-29

## Technology Decisions

### 1. URL Detection Strategy

**Decision**: Regex scan on piped stdout with `Transform` stream

**Rationale**: `claude /login` prints a URL to stdout that the user must open in a browser. Since Docker Desktop doesn't auto-open URLs from inside containers, the CLI is the right interception point.

**Pattern**: Simple regex `https?://\S+` applied line-by-line on the stdout pipe. First match wins — subsequent URLs are ignored (the first is always the auth URL). The scanner forwards all data to `process.stdout` unchanged.

**Alternatives considered**:
- **Full `stdio: 'inherit'`** — Simpler but no URL interception possible. Rejected per clarification Q6.
- **`node-pty`** — Full PTY emulation preserves TTY colors but adds a native dependency. Rejected as over-engineering for this use case.
- **Post-hoc URL extraction** — Buffer all output, scan after exit. Rejected because the user needs to see output in real-time.

### 2. Cross-Platform Browser Launch

**Decision**: Platform-specific `child_process.exec` calls

**Implementation**:
- macOS: `exec('open "<url>"')`
- Windows: `exec('start "" "<url>"')`
- Linux: Print URL with instructions (no auto-open per architecture doc Open-question #3)

**Alternatives considered**:
- **`open` npm package** — Popular but unnecessary dependency for 3 lines of platform-specific code.
- **`xdg-open` on Linux** — Possible but explicitly excluded by architecture decision. Linux Docker hosts may not have a display server.

### 3. Cluster Context Resolution

**Decision**: Walk-up directory search + file-based registry lookup

**Algorithm**:
1. Start from `cwd`, walk up parent directories looking for `.generacy/cluster.json`
2. Parse the file for `cluster_id` (validated with Zod)
3. Optionally read `~/.generacy/clusters.json` for additional metadata (`cloudUrl`, `path`, status)
4. Return a `ClusterContext` object with all resolved fields

**Why not Docker introspection**: Per clarification Q1, the host-side registry and project files are authoritative. No need to `docker exec` into running containers.

### 4. Docker Compose Invocation

**Decision**: `child_process.spawn('docker', ['compose', 'exec', '-it', 'orchestrator', 'claude', '/login'])`

**Key details**:
- Use `docker compose` (V2 plugin syntax), not `docker-compose` (legacy binary)
- `--project-name` set to `cluster_id` (which is the compose project name per #494)
- `--project-directory` set to the cluster's project path from registry
- `stdio: ['inherit', 'pipe', 'inherit']` — stdin/stderr inherited, stdout piped for URL scanning

### 5. Error Handling Strategy

**Decision**: Fail-fast with clear user-facing messages

| Scenario | Error Message |
|----------|---------------|
| No `.generacy/` found in cwd ancestry | `No Generacy cluster found in {cwd} or any parent directory. Run 'generacy init' first.` |
| `.generacy/cluster.json` missing/invalid | `Cluster configuration is corrupted. Re-run 'generacy init'.` |
| `--cluster <id>` not in registry | `Cluster '{id}' not found in registry. Run 'generacy status' to see available clusters.` |
| Docker not running | `Docker is not running. Start Docker and try again.` |
| Orchestrator container not running | `Cluster '{id}' is not running. Run 'generacy up' to start it.` |
| `claude /login` exits non-zero | Forward the exit code; Docker error messages are sufficient |

### 6. Testing Strategy

**Unit tests**:
- `cluster-context.test.ts` — Mock filesystem (`memfs` or manual mocks) to test walk-up resolution, missing files, invalid JSON, `--cluster` registry lookup
- `url-scanner.test.ts` — Feed test strings through the transform stream, verify URL extraction and passthrough
- `open.test.ts` — Mock `cluster-context` and `browser` utils, verify URL construction
- `browser.test.ts` — Mock `child_process.exec` and `os.platform()`, verify correct command per platform

**Integration tests**:
- `claude-login.test.ts` — Create a fake `claude` script that prints a URL, spawn the command against it, verify URL is detected and browser open is attempted. Use a temp docker-compose.yml or mock `docker compose exec`.

## Implementation Patterns

### Command Registration

Follow the established pattern from `run.ts`:

```typescript
export function claudeLoginCommand(): Command {
  const command = new Command('claude-login');
  command
    .description('Authenticate Claude inside the orchestrator container')
    .action(async () => { /* ... */ });
  return command;
}
```

Register in `packages/generacy/src/cli/index.ts`:
```typescript
program.addCommand(claudeLoginCommand());
program.addCommand(openCommand());
```

### Shared Utility Pattern

Follow existing utils pattern (`exec.ts`, `logger.ts`, `config.ts`) — exported functions with structured logging via `getLogger()`.

## References

- [Dev Cluster Architecture](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/dev-cluster-architecture.md) — CLI design, Open-question #3
- [#494 Cluster Lifecycle Commands](https://github.com/generacy-ai/generacy/issues/494) — Host-side registry definition
- [Orchestrator Activation Types](../../packages/orchestrator/src/activation/types.ts) — `ClusterJson` schema
- [Clarifications](./clarifications.md) — Q1-Q6 resolved decisions
