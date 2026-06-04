# Contract: `scaffoldDockerCompose` — `volume`-mode behavior

**Function**: `scaffoldDockerCompose(dir: string, input: ScaffoldComposeInput): void`
**File**: `packages/generacy/src/cli/commands/cluster/scaffolder.ts`
**Applies when**: `input.claudeConfigMode === 'volume'`.
**Note**: This contract documents post-fix behavior. The `bind` branch is governed by the existing implicit contract: byte-identical YAML to today (SC-002).

## Preconditions

| # | Precondition | Enforcement |
|---|--------------|-------------|
| P1 | `dir` is an absolute path or resolves to one. | Caller responsibility (existing convention). |
| P2 | `dir` is writable by the scaffolder process. | Caller responsibility (existing — `mkdirSync(dir, { recursive: true })` already attempted). |
| P3 | `input.variant` is `'cluster-base'` or `'cluster-microservices'`. | TypeScript boundary. |
| P4 | `input.claudeConfigMode === 'volume'`. | Branch selector for this contract. |

## Postconditions

| # | Postcondition | How to verify |
|---|---------------|---------------|
| Q1 | `<dir>/docker-compose.yml` exists and parses as valid YAML. | `yaml.parse(readFileSync(...))` |
| Q2 | `services.orchestrator.volumes` includes the literal string `./claude.json:/home/node/.claude.json`. | Vitest: `expect(orchVolumes).toContain('./claude.json:/home/node/.claude.json')` |
| Q3 | `services.worker.volumes` includes the literal string `./claude.json:/home/node/.claude.json`. | Vitest: same as Q2 for `worker`. |
| Q4 | Neither services array includes `claude-config:/home/node/.claude.json`. | Vitest: `not.toContain(...)`. |
| Q5 | The top-level `volumes` map does NOT contain a `claude-config` key. | Vitest: `expect(parsed.volumes).not.toHaveProperty('claude-config')`. |
| Q6 | `<dir>/claude.json` exists. | `existsSync(join(dir, 'claude.json'))`. |
| Q7 | If `<dir>/claude.json` did not exist before the call, its contents after the call are exactly `"{}\n"`. | `readFileSync(...) === '{}\n'`. |
| Q8 | If `<dir>/claude.json` did exist before the call, its contents and `mtime` are unchanged. | Compare bytes and stat. |
| Q9 | All other compose keys (services list, environments, ports, healthchecks, networks, tmpfs, env_file, depends_on, restart, healthcheck, deploy.replicas, extra_hosts, redis service) match the `volume`-mode output for the same input minus the `claudeConfigVolume` swap. | Snapshot diff. |

## Idempotency

| # | Rule | Source |
|---|------|--------|
| I1 | Calling `scaffoldDockerCompose` N times against the same `dir` and `input` produces identical `docker-compose.yml` output every time. | Existing — compose write is deterministic. |
| I2 | `claude.json` is written **only** if it does not exist. Pre-existing files (including zero-byte) are preserved verbatim. | New, FR-002 + FR-003. |
| I3 | If the chown succeeds on call N and fails on call N+1 (e.g., file later changed ownership to root), the existing file is still preserved. The chown failure is logged and the function returns successfully. | New, FR-004. |

## Error Behavior

| Condition | Behavior |
|-----------|----------|
| `mkdirSync(dir, { recursive: true })` fails | Throws (existing behavior — directory is the scaffold root; nothing works if it can't be created). |
| `writeFileSync` for `docker-compose.yml` fails | Throws (existing behavior). |
| `writeFileSync` for `claude.json` fails with `EACCES` | Throws — directory was writable enough to create compose, so file write should also work. |
| `chownSync(claude.json, 1000, 1000)` fails with `EPERM` or `EACCES` | Logged as `logger.warn(...)` with the path and the errno; function returns successfully. |
| `chownSync` fails with any other errno | Rethrows (defensive — anything other than permission is a real bug). |
| `existsSync(claude.json)` returns true | Skip write, skip chown, no warning. Compose still emits the bind mount. |

## Performance Contract

- One additional `existsSync` + at most one `writeFileSync` + at most one `chownSync` per call. Total added latency: < 1 ms on any reasonable host. Not a hot path.

## What This Contract Does NOT Cover

- `bind`-mode behavior — implicitly contracted by SC-002 (byte-equal to today's output).
- Behavior of `claude.json` on the remote VM during `deploy` — see [remote-compose-ownership.md](./remote-compose-ownership.md).
- Lifecycle of `claude.json` across `generacy destroy` — already handled by the existing destroy flow that removes `.generacy/`.
