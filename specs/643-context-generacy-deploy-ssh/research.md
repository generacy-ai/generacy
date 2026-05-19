# Research: Deploy SSH — Registry Credential Authentication

## Technology Decisions

### 1. Remote File Write Mechanism

**Decision**: Use `ssh ... 'cat > <path>'` with stdin pipe for writing Docker config.

**Alternatives Considered**:
- **SCP file**: Requires writing a temp file locally first, then transferring. Extra I/O step.
- **SSH echo/heredoc**: Risk of shell escaping issues with base64 content containing special chars.
- **`ssh ... 'docker login'`**: Exposes password in process arguments visible via `ps`. Security concern.

**Chosen approach**: Pipe content via stdin to avoid shell escaping:
```typescript
execSync(`ssh ${sshArgs} 'mkdir -p "${remotePath}/.docker" && cat > "${remotePath}/.docker/config.json" && chmod 600 "${remotePath}/.docker/config.json"'`, {
  input: configJson,
});
```

This avoids both temp files and shell escaping issues. The `cat` reads from stdin which is provided by `execSync`'s `input` option.

### 2. DOCKER_CONFIG Environment Variable Scoping

**Decision**: Pass `DOCKER_CONFIG` inline in the SSH command for `docker compose pull`.

**Pattern**:
```bash
DOCKER_CONFIG="${remotePath}/.docker" docker compose pull
```

**Why not alternatives**:
- Setting it in `.env` file: Would persist beyond the pull phase and be visible to containers.
- `docker login` on the remote: Modifies `~/.docker/config.json` (user-wide, not scoped).
- Docker credential helpers: Require installation on remote; out of scope.

### 3. Docker config.json Format

**Standard format** (all supported Docker versions):
```json
{
  "auths": {
    "ghcr.io": {
      "auth": "<base64(username:password)>"
    },
    "registry.example.com": {
      "auth": "<base64(username:password)>"
    }
  }
}
```

Multiple registries supported natively in a single file. No Docker version compatibility concerns — this format is stable since Docker 1.7+.

### 4. Credential Forwarding via SSH + Docker Exec

**Decision**: Reuse the same `docker compose exec orchestrator curl --unix-socket` pattern from launch.

**Wire format** (PUT body to control-plane):
```json
{
  "type": "registry",
  "value": "<base64(username:password)>"
}
```

**Credential ID derivation**: `registry-${host}` (e.g., `registry-ghcr.io`).

**SSH wrapping**:
```bash
ssh user@host -p port 'cd /path && docker compose exec -T orchestrator curl --unix-socket /run/generacy-control-plane/control.sock -s -X PUT http://localhost/credentials/registry-ghcr.io -H "Content-Type: application/json" -d '"'"'{"type":"registry","value":"..."}'"'"''
```

Note: `-T` disables TTY allocation for non-interactive exec. Single quotes with escape for JSON body.

### 5. Error Detection and Messaging

**Auth failure detection**: Docker compose pull outputs `unauthorized` or `denied` in stderr on auth failures. Pattern match these to provide specific error messages referencing credentials.

**Timeout handling**: SSH commands inherit a default timeout from the SSH client config. For credential forwarding, a 30-second timeout per credential is reasonable.

### 6. Cleanup Idempotency

**Pattern**: `rm -f` (force, no error if missing) ensures idempotent cleanup:
```bash
ssh user@host 'rm -f "${remotePath}/.docker/config.json" && rmdir "${remotePath}/.docker" 2>/dev/null || true'
```

The `rmdir` silently fails if directory is non-empty or doesn't exist — safe.

## Implementation Patterns

### Launch Command Reference (Local)

The local launch uses:
1. `materializeScopedDockerConfig()` → writes `.generacy/.docker/config.json` locally
2. `execSync('docker compose pull', { env: { ...process.env, DOCKER_CONFIG: '...' } })`
3. `cleanupScopedDockerConfig()` in finally block
4. After cluster up: `forwardRegistryCredentials()` via `docker compose exec`

Deploy adapts this to remote execution by wrapping each step in SSH.

### SSH Execution Pattern (Existing)

From `ssh-client.ts`:
```typescript
function sshExec(target: SshTarget, command: string): string {
  const args = buildSshArgs(target);
  return execSync(`ssh ${args.join(' ')} '${command}'`, { encoding: 'utf-8' });
}
```

New credential functions will use this same helper, with `input` option for stdin-piped content.

## Key Sources

- Docker config.json spec: https://docs.docker.com/engine/reference/commandline/cli/#docker-cli-configuration-file-dockerconfigjson
- Launch credential handling: `packages/generacy/src/cli/commands/launch/compose.ts`
- Launch credential forwarding: `packages/generacy/src/cli/commands/launch/credential-forward.ts`
- Control-plane PUT /credentials: `packages/control-plane/src/routes/credentials.ts`
- SSH client helpers: `packages/generacy/src/cli/commands/deploy/ssh-client.ts`
