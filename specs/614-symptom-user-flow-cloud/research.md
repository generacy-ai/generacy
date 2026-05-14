# Research: #614 Stale Credential Surface After Cluster Re-Add

## Technology Decisions

### Decision 1: `gh auth login --with-token` via stdin for live-refresh

**Chosen**: Shell out to `gh auth login --with-token` with token piped via stdin.

**Rationale**: The `gh` CLI reads `~/.config/gh/hosts.yml` on every invocation. The orchestrator's `GhCliGitHubClient` uses `gh` under the hood. Updating `hosts.yml` via `gh auth login` is the canonical, supported mechanism. Writing the file directly would require tracking the YAML schema across `gh` versions.

**Alternatives considered**:
- **Direct `hosts.yml` write**: Fragile — `gh` YAML structure has changed across versions (2.x → 3.x). Token field name, host nesting, and oauth_token vs token fields vary.
- **Restart orchestrator process**: Sledgehammer — would interrupt all in-flight monitors, queues, and WebSocket connections. Credential refresh should be hot.
- **Signal orchestrator via relay event**: Adds complexity — control-plane emits event, orchestrator subscribes, runs `gh auth`. More moving parts for same result. The control-plane already runs in the same container and can write `hosts.yml` directly.

**Security**: Token passed via stdin (not command-line arguments). `argv` is visible in `/proc/<pid>/cmdline`; stdin is not. `execFile` avoids shell injection.

### Decision 2: `docker run --rm -v ... alpine rm -f` for volume cleanup

**Chosen**: CLI runs an ephemeral Alpine container to surgically remove stale files from the named Docker volume.

**Rationale**: Docker named volumes are not directly accessible from the host filesystem (especially on Docker Desktop / macOS / Windows where Docker runs in a VM). `docker run --rm -v` is the standard cross-platform way to manipulate volume contents. Removing only `cluster-api-key` and `cluster.json` preserves the master encryption key, audit logs, and scratch directories.

**Alternatives considered**:
- **`docker volume rm`**: Destroys all state — master key, audit logs, encrypted credentials. Unacceptable data loss.
- **`FORCE_REACTIVATION=true` env var**: Requires orchestrator code change to check the env var and delete the key file. The volume-cleanup approach achieves the same result with zero orchestrator changes.
- **Sentinel file**: Orchestrator checks for a sentinel, deletes key if found. Same problem as env var — requires orchestrator changes.

### Decision 3: Non-fatal post-write refresh

**Chosen**: Both `writeWizardEnvFile` and `refreshGhAuth` failures in the credential PUT handler are logged but do not fail the PUT response.

**Rationale**: The primary write (`setSecret` + YAML metadata) has already succeeded. The refresh steps are best-effort optimizations. If `gh` is temporarily unavailable, the next container restart will pick up the env file. If the env file write fails, the `gh auth` call already updated the live config. Failing the PUT would cause the cloud to retry, creating unnecessary load.

## Implementation Patterns

### Pattern: Post-write side-effects in credential handler

The existing `handlePutCredential` follows a clean linear flow: parse → validate → write → respond. The refresh steps are added as post-write side-effects, gated on credential type.

```typescript
// After writeCredential() succeeds:
if (isGithubCredential(type)) {
  // These are best-effort — failures don't fail the PUT
  await refreshEnvFile(agencyDir);
  await refreshGhAuth(extractToken(type, value));
}
```

This pattern keeps the core write path unchanged and adds the refresh as an additive concern.

### Pattern: Token extraction reuse

`mapCredentialToEnvEntries` in `wizard-env-writer.ts` already knows how to extract the token from both `github-app` (JSON parse → `.token`) and `github-pat` (raw string) values. Rather than duplicating this logic, the credential handler extracts the token using the same approach:

```typescript
function extractGhToken(type: string, value: string): string | null {
  if (type === 'github-app') {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed.token === 'string' ? parsed.token : null;
    } catch { return null; }
  }
  if (type === 'github-pat') return value;
  return null;
}
```

### Pattern: Compose project name derivation for volume cleanup

The volume name follows Docker Compose's convention: `<project-name>_<volume-name>`. The project name is derived from `sanitizeComposeProjectName(projectName, clusterId)` in the shared scaffolder. The CLI reuses this same function to compute the volume name for cleanup:

```typescript
const composeName = sanitizeComposeProjectName(config.projectName, config.clusterId);
const volumeName = `${composeName}_generacy-data`;
```

## Key Sources

- `packages/control-plane/src/routes/credentials.ts` — Current PUT handler
- `packages/control-plane/src/services/wizard-env-writer.ts` — Env file writer with token extraction
- `packages/control-plane/src/routes/lifecycle.ts` — `bootstrap-complete` handler (only current consumer of `writeWizardEnvFile`)
- `packages/orchestrator/src/activation/index.ts` — Key-file gate at line 35-47
- `packages/generacy/src/cli/commands/launch/index.ts` — Launch action flow
- `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — `sanitizeComposeProjectName` and `scaffoldDockerCompose`
- `gh` CLI source: `gh auth login --with-token` reads from stdin, writes to `~/.config/gh/hosts.yml`
