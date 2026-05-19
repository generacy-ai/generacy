# Quickstart: CLI deploy ssh://host command

## Prerequisites

- Node.js >= 22
- SSH key-based access to a target VM (password auth not supported)
- Docker installed on the target VM
- Target VM has outbound internet access
- A Generacy cloud account (for device-flow activation)

## Deploy to a Remote VM

```bash
# Basic deploy — uses current SSH user, port 22
generacy deploy ssh://my-server.example.com

# With explicit user and port
generacy deploy ssh://deploy@my-server.example.com:2222

# With custom remote path
generacy deploy ssh://deploy@my-server.example.com/opt/generacy

# With custom timeout (default: 5 minutes)
generacy deploy ssh://deploy@my-server.example.com --timeout=600

# With custom cloud URL (for staging/dev)
generacy deploy ssh://my-server.example.com --cloud-url=https://staging.generacy.ai
```

### What happens during deploy

1. **SSH check** — verifies connectivity and Docker presence on the remote host
2. **Activation** — opens your browser for device-flow approval via generacy.ai
3. **Config fetch** — pulls compose template and image tag from the cloud
4. **File transfer** — SCPs bootstrap files to the remote host
5. **Startup** — runs `docker compose pull && up -d` on the remote
6. **Registration** — polls cloud until the cluster reaches "connected" status
7. **Registry** — adds the cluster to your local `~/.generacy/clusters.json`

## Manage Remote Clusters

Remote clusters work identically to local ones:

```bash
# Stop a remote cluster
generacy stop --cluster=<cluster-id>

# Start it back up
generacy up --cluster=<cluster-id>

# Check status of all clusters (local and remote)
generacy status

# Tear down and remove
generacy destroy --cluster=<cluster-id> --yes

# Update to latest images
generacy update --cluster=<cluster-id>
```

No special flags — the CLI detects SSH clusters from the registry and forwards commands over SSH transparently.

## SSH Target Format

```
ssh://[user@]host[:port][/path]
```

| Component | Default | Example |
|-----------|---------|---------|
| `user` | Current OS user | `deploy` |
| `host` | (required) | `my-server.example.com` |
| `port` | 22 | `2222` |
| `path` | `~/generacy-clusters/<project-id>` | `/opt/generacy` |

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `--timeout=<seconds>` | Max wait for cluster registration | `300` (5 min) |
| `--cloud-url=<url>` | Override cloud API URL | `https://api.generacy.ai` |

## Troubleshooting

### SSH connection refused

```
Error: SSH connectivity check failed — cannot reach deploy@host:22
```

Verify SSH access manually: `ssh deploy@host 'echo ok'`. Check firewall rules and SSH daemon status.

### Docker not found on remote

```
Error: Docker is not installed on the remote host.
Install Docker: curl -fsSL https://get.docker.com | sh
```

The target VM must have Docker and Docker Compose installed. The CLI does not install Docker automatically.

### Cluster registration timeout

```
Error: Cluster did not register within 300 seconds.
Check status: generacy status --cluster=<id>
```

The VM may have slow internet (large image pull) or a firewall blocking outbound WebSocket connections. Retry with `--timeout=600` or check remote logs:

```bash
ssh user@host 'cd ~/generacy-clusters/<project-id> && docker compose logs -f'
```

### Image pull failed

```
Error: docker compose pull failed on remote host
```

Check that the remote VM has outbound internet access and can reach the container registry. Verify Docker credentials if using a private registry.

## Provider Extensibility

The `deploy` command is designed for future extensibility beyond SSH targets. Provider-specific targets (e.g., `aws://`, `hetzner://`) are out of scope for v1 but the target parsing architecture supports adding new schemes.
