# Quickstart: Registry Credential Support in `generacy update`

## Overview

After this feature lands, `generacy update` automatically authenticates private registry pulls using credentials stored in the cluster's credhelper. No manual `docker login` required.

## Usage

### Default behavior (no change for public images)

```bash
cd ~/my-project
generacy update
# → docker compose pull (uses ambient Docker login)
# → docker compose up -d
```

### Private image with stored credentials

```bash
cd ~/my-project
generacy update
# → Detects private registry host from docker-compose.yml image field
# → Fetches registry-<host> credential from cluster control-plane
# → Creates scoped Docker config at .generacy/.docker/config.json
# → docker compose pull (with DOCKER_CONFIG=.generacy/.docker)
# → Cleanup .generacy/.docker/
# → docker compose up -d
```

### Cluster offline

```bash
cd ~/my-project
generacy stop    # cluster containers stopped
generacy update
# ⚠ Cluster is offline; the update will use your machine's ambient docker login.
#   If the image requires credentials stored on the cluster, start the cluster
#   first with `generacy up`.
# → Proceeds with ambient Docker login
```

## How Credentials Get Stored

Registry credentials are stored during the initial `generacy launch` flow (sibling issue). The cloud wizard sends them via `PUT /credentials/registry-<host>` with:

```json
{
  "type": "registry",
  "value": "{\"username\": \"_token\", \"password\": \"ghp_...\"}"
}
```

## Troubleshooting

### Pull fails with "unauthorized" after `generacy update`

1. Verify the cluster is running: `generacy status`
2. Check if credential exists: `docker compose exec orchestrator curl -sf --unix-socket /run/generacy-control-plane/control.sock http://localhost/credentials/registry-<host>/value`
3. If no credential: re-run the credential setup from the cloud dashboard

### Stale `.generacy/.docker/` directory

If the CLI crashes mid-update, a stale Docker config may remain:

```bash
rm -rf .generacy/.docker/
```

This is harmless — it will be overwritten on the next update.

### Wrong registry host detected

The host is extracted from the `image:` field in `.generacy/docker-compose.yml`. Verify the image reference includes the full registry hostname:

```yaml
services:
  orchestrator:
    image: ghcr.io/my-org/my-image:stable  # ← "ghcr.io" is the host
```

## Control-Plane Endpoint

### `GET /credentials/:id/value`

Returns the decrypted credential value. Only accessible via the local Unix socket (inside the container).

```bash
# From inside the container:
curl -sf --unix-socket /run/generacy-control-plane/control.sock \
  http://localhost/credentials/registry-ghcr.io/value

# Response:
# {"value":"{\"username\":\"_token\",\"password\":\"ghp_xxxx\"}"}
```

## File Layout

```
<projectDir>/
└── .generacy/
    ├── docker-compose.yml    # Contains image reference
    ├── cluster.json          # Cluster identity
    ├── cluster.yaml          # Cluster config
    └── .docker/              # TRANSIENT: only exists during pull
        └── config.json       # Scoped Docker auth config
```
