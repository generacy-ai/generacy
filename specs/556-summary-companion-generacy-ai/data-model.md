# Data Model: Launch scaffolder writes `GENERACY_BOOTSTRAP_MODE=wizard`

## Environment Variable Contract

| Variable | Value | Emitted By | Consumed By |
|----------|-------|-----------|-------------|
| `GENERACY_BOOTSTRAP_MODE` | `wizard` | `scaffoldEnvFile()` in generacy CLI | `entrypoint-orchestrator.sh` in cluster-base |

### Enum Values (defined by cluster-base#20)

| Value | Meaning | Clone Timing |
|-------|---------|-------------|
| `devcontainer` | Default if unset. VS Code Dev Containers flow; credentials pre-configured. | Clone on boot |
| `wizard` | Booted via `npx generacy launch` or cloud-deploy; credentials arrive post-activation. | Defer clone |

## No Schema Changes

- `ScaffoldEnvInput` interface: **unchanged** (no new fields)
- `ScaffoldComposeInput` interface: **unchanged**
- No Zod schemas affected
- No API contracts affected

## File Output Contract

The scaffolded `.generacy/.env` file gains these lines appended after the "Cluster runtime" section:

```env
# Bootstrap mode — see cluster-base entrypoint scripts
# `wizard` defers repo cloning until credentials arrive via the activation wizard
GENERACY_BOOTSTRAP_MODE=wizard
```

Total new lines: 3 (2 comments + 1 env var)
