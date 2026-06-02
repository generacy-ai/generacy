# Data Model

This is a scaffolder bug fix; there is no application-level data model. The "data" here is: (a) the TypeScript input type, (b) the emitted `docker-compose.yml` shape, and (c) the on-disk `claude.json` artifact.

## TypeScript: `ScaffoldComposeInput` (unchanged)

Declared in `packages/generacy/src/cli/commands/cluster/scaffolder.ts:23-36`. No additions or removals required by this fix — `claudeConfigMode` already exists.

```ts
export interface ScaffoldComposeInput {
  imageTag: string;
  clusterId: string;
  projectId: string;
  projectName: string;
  cloudUrl: string;
  variant: 'cluster-base' | 'cluster-microservices';
  deploymentMode?: 'local' | 'cloud';
  orgId: string;
  workers?: number;
  channel?: 'stable' | 'preview';
  repoUrl?: string;
  claudeConfigMode?: 'bind' | 'volume';   // default: 'bind'
}
```

### Validation Rules

- `claudeConfigMode` is type-constrained at the boundary. No runtime guard added — internal callers (`launch`, `deploy`) hand-construct this object with literal strings.
- No new fields. The bind path in `volume` mode is deterministic from the scaffold directory and not exposed as a knob (see [research.md D1](./research.md), Q2 option C rejected).

## Emitted `docker-compose.yml` Shape

The relevant slice of the YAML emitted by `scaffoldDockerCompose`. Only the deltas vs. today are shown.

### `services.orchestrator.volumes`

| Mode    | Today (line ~125-128, ~149)                          | After fix                                            |
|---------|------------------------------------------------------|------------------------------------------------------|
| `bind`   | `~/.claude.json:/home/node/.claude.json`            | `~/.claude.json:/home/node/.claude.json` (unchanged) |
| `volume` | `claude-config:/home/node/.claude.json` (BROKEN)    | `./claude.json:/home/node/.claude.json`              |

### `services.worker.volumes`

Same as orchestrator — both services include `claudeConfigVolume` via the shared `sharedVolumes` array (scaffolder.ts:147-153). Both services must see the same fixed entry.

### Top-level `volumes:`

| Mode    | Today (scaffolder.ts:258)                           | After fix                                            |
|---------|------------------------------------------------------|------------------------------------------------------|
| `bind`   | No `claude-config:` entry                            | No `claude-config:` entry (unchanged)                |
| `volume` | `claude-config: null` (dead — points to broken mount)| No `claude-config:` entry                            |

### All other compose keys

Unchanged. The fix touches one volume string per service and one entry in the top-level volumes map. No service definitions, environment vars, ports, healthchecks, networks, or tmpfs mounts are modified.

## On-Disk Artifact: `claude.json`

A new file the scaffolder writes when `claudeConfigMode === 'volume'`.

### Path

`<scaffoldDir>/claude.json` — colocated with the emitted `docker-compose.yml`. The compose bind uses the compose-relative path `./claude.json`, so the file resolves correctly on whichever host runs `docker compose up`.

### Initial Contents

```json
{}
```

(Single line, trailing newline: literally `"{}\n"`.) This is the minimum valid JSON that Claude's CLI accepts as a config file at startup.

### Ownership / Mode

- **Ideal**: `uid=1000`, `gid=1000`, `mode=0600` (matches the in-container `node` user and the cloud-init `install -o 1000 -g 1000 -m 0600` pattern).
- **Best-effort**: scaffolder calls `chownSync(path, 1000, 1000)` after creation; on `EPERM`/`EACCES` it logs a warning and leaves ownership as the scaffolder process's uid. The container will mount the file regardless; the container's `node` user may not be able to *write* to it if ownership is wrong, but Claude will still read the empty `{}` on first launch.
- **Mode**: `writeFileSync` default mode (`0644`, masked by `umask`) is used; the fix does not call `chmodSync` because security-tightening to `0600` on hosts where chown also fails would be inconsistent. cloud-init handles this on the VM via the remote `install` (D4).

### Lifecycle / Idempotency

| Event                         | Action                                                                 |
|-------------------------------|------------------------------------------------------------------------|
| First scaffold (file missing) | Create with `{}\n`, best-effort chown.                                |
| Re-scaffold (file exists)     | Skip — leave file untouched (`existsSync` guard).                      |
| File contains real Claude session token | Same as above — never overwritten. Token survives `update`.   |
| `generacy destroy`            | Removed with the rest of `.generacy/` by the existing destroy flow.    |

## Remote (VM) Filesystem Shape (for `deploy`)

After `scpDirectory()` and the new ownership-fix `sshExec`, the VM holds:

```text
<remotePath>/
├── docker-compose.yml      # bind references ./claude.json
├── cluster.json
├── cluster.yaml
├── .env
└── claude.json             # SCP'd; chowned to 1000:1000 if SSH user has CAP_CHOWN
```

The container's bind `./claude.json:/home/node/.claude.json` resolves to `<remotePath>/claude.json` because Docker resolves relative bind paths against the compose file's directory.

## What This Fix Does NOT Introduce

- No new Zod schema (no parsed input — `ScaffoldComposeInput` is internal-only and TypeScript-validated).
- No new database/persistent store.
- No new IPC or API contract changes.
- No changes to `cluster.json`, `cluster.yaml`, or `.env` shape.
- No new env vars consumed by orchestrator/worker.
