# Research: CLI deploy ssh://host command

## Technology Decisions

### SSH Execution Strategy

**Decision**: Shell out to host `ssh`/`scp` binaries via `node:child_process`.

**Alternatives considered**:
- **ssh2 npm package**: Pure JS SSH client. Would avoid host dependency but adds ~500KB, doesn't integrate with SSH agent/config, and requires manual key management. Too much surface area for v1.
- **Docker context with SSH**: `docker context create --docker "host=ssh://..."` then `docker compose`. Elegant but requires Docker >= 20.10 on the local machine and doesn't give fine-grained control over file transfer.

**Rationale**: Target users are technical/cloud power users who already have SSH configured. Shelling out to `ssh`/`scp` respects their `~/.ssh/config`, agent forwarding, ProxyJump, and key selection. Zero additional dependencies.

### Device-Flow Activation Sharing

**Decision**: New `@generacy-ai/activation-client` package with protocol-level client only.

**Alternatives considered**:
- **Import from orchestrator package**: Would pull in all orchestrator dependencies (launcher, plugins, etc.) into the CLI.
- **Copy/paste**: Fast but creates drift risk when the cloud API evolves.

**Rationale**: The protocol client is ~200 LOC with zero dependencies beyond `node:http`/`node:https` and `zod`. A thin shared package keeps both consumers in sync without coupling.

### Remote Log Streaming

**Decision**: `ssh ... 'docker compose logs -f'` streamed to local stdout, with parallel cloud-status polling for the success signal.

**Alternatives considered**:
- **Parse log patterns**: Fragile — log format can change, buffering can delay or miss patterns.
- **WebSocket relay status**: Would require the CLI to authenticate to the relay, adding complexity.

**Rationale**: Cloud-side cluster status is the authoritative registration signal. Log streaming is supplementary UX. Polling is simple and reliable.

### SSH Target URL Parsing

**Decision**: Custom parser for `ssh://[user@]host[:port][/path]` using `URL` constructor with fallback.

**Alternatives considered**:
- **Node `URL` class directly**: Works for `ssh://user@host:22/path` but fails for bare `ssh://host` (port becomes empty string, not default). Needs normalization.
- **Regex**: Brittle for edge cases like IPv6 hosts.

**Rationale**: Use `new URL(target)` for structured parsing, then normalize defaults (user → current user, port → 22, path → `~/generacy-clusters/<project-id>`). Clean and handles edge cases.

### Compose Template Sourcing

**Decision**: Fetch from cloud's `GET /api/clusters/launch-config?claim=<code>` endpoint after device-flow completion.

**Alternatives considered**:
- **Bundle default template in CLI**: Would go stale as the compose schema evolves. Requires CLI releases for template changes.
- **Generate from scratch**: Complex, error-prone, needs deep knowledge of all compose services.

**Rationale**: Reuses the exact same endpoint as `generacy launch` (#495). Cloud controls the template, image tags, and service configuration. CLI just templates and transfers.

## Implementation Patterns

### SSH Command Construction

```typescript
function buildSshArgs(target: SshTarget, command: string): string[] {
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (target.port !== 22) args.push('-p', String(target.port));
  args.push(`${target.user}@${target.host}`, command);
  return args;
}
```

Key flags:
- `BatchMode=yes`: Fail immediately if password is needed (no interactive prompt)
- `StrictHostKeyChecking=accept-new`: Accept new host keys, reject changed ones

### SCP Bundle Transfer

Transfer strategy: create a temp directory locally with the bootstrap files, then `scp -r` the directory to the remote. This is simpler than multiple `scp` calls and handles the `.generacy/` directory structure naturally.

```
local temp dir:
  .generacy/cluster.yaml
  .generacy/cluster.json
  docker-compose.yml

scp -r <temp>/.generacy <temp>/docker-compose.yml user@host:~/generacy-clusters/<project-id>/
```

### Status Polling Pattern

Reuse the exponential backoff pattern from the activation poller:
- Initial interval: 3 seconds
- Max interval: 15 seconds
- Backoff factor: 1.5x
- Timeout: 300 seconds (configurable)

```typescript
async function pollClusterStatus(cloudUrl: string, clusterId: string, apiKey: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let interval = 3000;
  while (Date.now() < deadline) {
    const status = await fetchClusterStatus(cloudUrl, clusterId, apiKey);
    if (status === 'connected') return;
    await sleep(interval);
    interval = Math.min(interval * 1.5, 15000);
  }
  throw new DeployError('Cluster did not register within timeout', 'REGISTRATION_TIMEOUT');
}
```

### Registry Extension

Add optional `managementEndpoint` field to `RegistryEntrySchema`:

```typescript
export const RegistryEntrySchema = z.object({
  // ... existing fields
  managementEndpoint: z.string().optional(), // e.g., "ssh://user@host:22/~/generacy-clusters/proj-123"
});
```

### Compose SSH Forwarding

When `managementEndpoint` starts with `ssh://`, lifecycle commands build an SSH command instead of running locally:

```typescript
function runCompose(ctx: ClusterContext, subcommand: string[]): ExecResult {
  if (ctx.managementEndpoint?.startsWith('ssh://')) {
    const target = parseSshTarget(ctx.managementEndpoint);
    const remoteCmd = `cd ${target.path} && docker compose ${subcommand.join(' ')}`;
    return execSafe(`ssh ${buildSshArgs(target, remoteCmd).join(' ')}`);
  }
  // existing local path
  return execSafe(`docker compose ${dockerComposeArgs(ctx).concat(subcommand).join(' ')}`);
}
```

## Key Sources

- RFC 8628: OAuth 2.0 Device Authorization Grant (device-flow protocol)
- Existing activation implementation: `packages/orchestrator/src/activation/`
- Existing launch command: `packages/generacy/src/cli/commands/launch/`
- Existing cluster lifecycle: `packages/generacy/src/cli/commands/cluster/`
- OpenSSH documentation: `BatchMode`, `StrictHostKeyChecking` options
