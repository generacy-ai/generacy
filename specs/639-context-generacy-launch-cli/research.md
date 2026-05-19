# Research: Scoped Private-Registry Credentials

## Docker `DOCKER_CONFIG` Mechanism

Docker CLI reads auth from `$DOCKER_CONFIG/config.json` (default: `~/.docker/config.json`). Setting this env var scopes auth to a specific directory without affecting machine-wide config. This is a well-documented, stable Docker feature used by CI systems.

**Key facts**:
- `DOCKER_CONFIG` must point to a **directory**, not a file
- Docker Compose inherits the env var and passes it through to the daemon client
- The `config.json` format uses `"auths": { "<registry>": { "auth": "<base64>" } }`
- Base64 value is `username:password` encoded

## Alternatives Considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| `DOCKER_CONFIG` env override | Standard, well-supported, process-scoped | Must clean up temp dir | **Selected** |
| `docker login --password-stdin` | No file to clean up | Modifies `~/.docker/config.json` globally | Rejected (violates FR-003) |
| Pass creds via Docker BuildKit secret | Doesn't touch fs | Not applicable to `compose pull` | Rejected |
| Docker credential helper plugin | Native Docker pattern | Over-engineered for single pull | Rejected |

## Implementation Pattern

```typescript
// Pseudocode for scoped auth
const dockerConfigDir = join(projectDir, '.docker');
const configPath = join(dockerConfigDir, 'config.json');

mkdirSync(dockerConfigDir, { recursive: true });
writeFileSync(configPath, JSON.stringify({
  auths: { [registryUrl]: { auth: Buffer.from(`${username}:${password}`).toString('base64') } }
}), { mode: 0o600 });

try {
  execSync('docker compose pull', {
    env: { ...process.env, DOCKER_CONFIG: dockerConfigDir }
  });
} finally {
  rmSync(dockerConfigDir, { recursive: true, force: true });
}
```

## Error Detection Patterns

Docker pull errors appear in stderr with identifiable patterns:
- **401/Unauthorized**: `unauthorized: authentication required` or `denied: requested access to the resource is denied`
- **404/Not Found**: `manifest unknown` or `not found`

These can be detected via string matching on the caught error message (which includes stderr from `execSync`).

## Registry URL Extraction

The `registryCredentials.url` field contains the full registry hostname (e.g., `ghcr.io`, `registry.example.com`). This is used directly as the key in the `auths` object — no URL parsing needed beyond what the cloud provides.

## Security Considerations

- File written with mode `0600` (owner-read-only)
- Lifetime: only exists during `docker compose pull` execution
- Cleanup guaranteed via `finally` block
- Never falls back to reading `~/.docker/config.json` when scoped config is active
- Credentials are never logged (already follows existing pattern of redacting sensitive values)
