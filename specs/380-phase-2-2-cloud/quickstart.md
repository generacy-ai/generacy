# Quickstart: Orchestrator Relay Integration

## Prerequisites

- Orchestrator running in **full mode** (default)
- `GENERACY_API_KEY` environment variable set (obtain from generacy-cloud dashboard)
- `@generacy-ai/cluster-relay` package installed (Phase 2.1)

## Configuration

### Minimum Configuration

Set the API key to enable relay:

```bash
export GENERACY_API_KEY="your-api-key-here"
```

That's it. The orchestrator will automatically connect to the cloud relay on startup.

### Full Configuration

Additional relay settings can be configured via environment variables or `orchestrator.yaml`:

```yaml
# orchestrator.yaml
relay:
  cloudUrl: wss://api.generacy.ai/relay   # Cloud relay URL (default)
  metadataIntervalMs: 60000               # Metadata refresh interval (default: 60s)
  clusterYamlPath: .generacy/cluster.yaml # Path to cluster config (default)
```

Or via environment variables:

```bash
export GENERACY_API_KEY="your-api-key"
export ORCHESTRATOR_RELAY_CLOUD_URL="wss://api.generacy.ai/relay"
export ORCHESTRATOR_RELAY_METADATA_INTERVAL_MS="60000"
```

## Usage

### Starting the Orchestrator with Relay

```bash
# Normal startup — relay connects automatically if GENERACY_API_KEY is set
pnpm dev

# Verify relay connection in logs:
# [INFO] Relay connected to generacy-cloud
# [INFO] Cluster metadata reported: version=1.0.0, uptime=0s
```

### Local-Only Mode (No Relay)

Simply don't set `GENERACY_API_KEY`:

```bash
# Without API key, orchestrator runs in local-only mode
unset GENERACY_API_KEY
pnpm dev

# Log output:
# [INFO] Relay disabled (GENERACY_API_KEY not configured)
```

### Verifying Relay Connection

Check the health endpoint for relay status:

```bash
curl http://localhost:3000/health
# { "status": "ok", "relay": "connected" }
```

## How It Works

### API Request Routing

When connected, API requests from the cloud dashboard are transparently routed to local orchestrator endpoints:

```
Cloud UI → Cloud Relay Service → WebSocket → Orchestrator Relay Client
  → Fastify inject() → Local Route Handler → Response back through relay
```

All existing API endpoints (workflows, queue, agents, etc.) are automatically available via relay.

### Event Forwarding

SSE events from all channels are forwarded to cloud subscribers:

- **workflows**: `workflow:started`, `workflow:completed`, `step:started`, etc.
- **queue**: `queue:updated`, `queue:item:added`, etc.
- **agents**: `agent:connected`, `agent:status`, etc.

### Metadata Reporting

On connect and every 60 seconds, the orchestrator reports:

- Package version
- Process uptime
- Active workflow count
- Git remotes
- Worker count and channel (from `.generacy/cluster.yaml`, if available)

## Troubleshooting

### Relay Not Connecting

1. **Check API key**: Ensure `GENERACY_API_KEY` is set and valid
2. **Check network**: The relay uses WebSocket (`wss://`) — ensure outbound 443 is not blocked
3. **Check logs**: Look for `Relay connection failed` messages with details
4. **Verify mode**: Relay only connects in `full` mode, not `worker` mode

### Relay Disconnecting

- The relay automatically reconnects with exponential backoff (5s → 10s → 20s → ... → 300s max)
- Check logs for `Relay disconnected, reconnecting...` messages
- If persistent, check network stability or cloud service status

### Missing Metadata

- If `.generacy/cluster.yaml` doesn't exist, worker count and channel are omitted from metadata
- Run `generacy init` or create the file manually to provide full metadata
- Other fields (version, uptime, git remotes) are always available

### Worker Mode

Worker-mode orchestrator instances do **not** establish relay connections. Only the full-mode orchestrator manages cloud connectivity on behalf of the cluster.
