# Quickstart: CLI Launch Command

**Branch**: `495-context-first-run-command` | **Date**: 2026-04-29

## Prerequisites

- Node.js >= 20
- Docker Desktop (or Docker Engine with Compose V2 plugin)
- A Generacy claim code (provided by your project admin or cloud UI)

## Usage

### Basic launch (interactive)

```bash
npx generacy launch
# Prompts for claim code, then bootstraps the cluster
```

### Launch with claim code

```bash
npx generacy launch --claim=ABCD-1234
```

### Launch with custom directory

```bash
npx generacy launch --claim=ABCD-1234 --dir ~/projects/my-cluster
```

### What happens

1. Validates Node.js version and Docker availability
2. Fetches project configuration from Generacy cloud using your claim code
3. Creates project directory at `~/Generacy/<project-name>` (or `--dir`)
4. Writes cluster config files to `.generacy/`
5. Pulls the cluster Docker image
6. Starts the cluster with `docker compose up`
7. Streams logs until the activation URL appears
8. Opens the activation URL in your browser (macOS/Windows) or prints it (Linux)
9. Registers the cluster locally for `generacy status`

### Verify the cluster

```bash
generacy status
# Shows all registered clusters and their state
```

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--claim <code>` | Claim code from Generacy cloud | Interactive prompt |
| `--dir <path>` | Project directory | `~/Generacy/<projectName>` |
| `-l, --log-level <level>` | Log level (trace/debug/info/warn/error) | `info` |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GENERACY_CLOUD_URL` | Cloud API base URL | `https://api.generacy.ai` |
| `GENERACY_LAUNCH_STUB` | Set to `1` to use stub launch-config (development) | unset |

## Troubleshooting

### "Docker daemon is not running"

Start Docker Desktop, or on Linux:
```bash
sudo systemctl start docker
```

### "Could not reach Generacy cloud"

- Check your internet connection
- Verify `GENERACY_CLOUD_URL` if set
- Try `curl https://api.generacy.ai/health` to test connectivity

### "Claim code is invalid or expired"

Request a new claim code from your project admin or the Generacy cloud UI.

### "Failed to pull cluster image"

Ensure you can access GHCR:
```bash
docker pull ghcr.io/generacy-ai/cluster-base:latest
```

If authentication is needed:
```bash
docker login ghcr.io
```

### "Timed out waiting for activation URL"

Check cluster logs manually:
```bash
cd ~/Generacy/<project-name>
docker compose -f .generacy/docker-compose.yml logs
```

### Cluster started but activation URL didn't open (Linux)

On Linux, the URL is printed to the terminal. Copy and paste it into your browser. Look for the line:
```
Go to: https://...
Enter code: XXXX-XXXX
```

## Development (stub mode)

To develop and test without a live cloud endpoint:

```bash
GENERACY_LAUNCH_STUB=1 npx generacy launch --claim=test
```

This uses a hardcoded launch-config response and allows testing the full scaffold + Docker Compose flow locally.
