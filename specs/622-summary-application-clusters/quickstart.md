# Quickstart: App Config & File Exposure

## For App Authors (cluster.yaml)

Add an `appConfig:` section to your `.generacy/cluster.yaml`:

```yaml
channel: stable
workers: 1
variant: cluster-microservices
appConfig:
  schemaVersion: "1"
  env:
    - { name: SERVICE_ANTHROPIC_API_KEY, secret: true, description: "Anthropic API key for the voice agent" }
    - { name: LIVEKIT_URL, secret: false, description: "LiveKit server URL" }
    - { name: LIVEKIT_API_KEY, secret: true }
    - { name: LIVEKIT_API_SECRET, secret: true }
    - { name: TWILIO_AUTH_TOKEN, secret: true }
  files:
    - { id: gcp-sa-json, mountPath: "/home/node/.config/gcloud/secrets/sa.json", description: "GCP service account JSON" }
```

Commit and push. The cloud UI will display a configuration form based on this manifest.

## For End Users (Cloud UI)

1. Launch a cluster: `npx generacy launch --claim=<code>`
2. Open the cluster dashboard in generacy.ai
3. Navigate to **Settings > App Configuration**
4. Fill in the required env vars and upload files
5. Values persist across worker sessions and container restarts

## CLI Commands (Power Users)

```bash
# Show the manifest and which values are filled
npx generacy app-config show

# Set a non-secret env var
npx generacy app-config set LIVEKIT_URL "wss://my-project.livekit.cloud"

# Set a secret env var
npx generacy app-config set --secret SERVICE_ANTHROPIC_API_KEY "sk-ant-..."
```

**Note**: CLI commands work for local clusters only. Remote clusters (deployed via `npx generacy deploy ssh://...`) are configured exclusively through the cloud UI Settings panel.

## For Role Authors (file exposure)

In `.agency/roles/my-role.yaml`, expose a credential as a file:

```yaml
version: "1"
credentials:
  - ref: gcp-sa
    expose:
      - as: file
        path: /home/node/.config/gcloud/secrets/sa.json
        mode: 0640
```

This writes the credential blob to the specified path during the workflow session. The file is wiped when the session ends.

## File Path Restrictions

Paths are validated against a denylist. The following prefixes are **not allowed**:
- `/etc/`, `/usr/`, `/bin/`, `/sbin/`, `/lib/`, `/lib64/`
- `/proc/`, `/sys/`, `/dev/`, `/boot/`
- `/run/generacy-credhelper/`, `/run/generacy-control-plane/`

All other paths are allowed, including `/home/node/.config/...` and `/var/lib/generacy-app-config/files/...`.

## Troubleshooting

### "File ID not declared in manifest"
The `POST /files/:id` endpoint requires the file ID to exist in `appConfig.files` in `cluster.yaml`. Add the entry to the manifest first.

### "mountPath is in a restricted system directory"
The target path hits the system denylist. Choose a path under `/home/`, `/var/lib/generacy-app-config/`, or another non-system location.

### CLI commands fail with "cannot connect"
Ensure the cluster is running (`npx generacy status`). The CLI uses `docker compose exec` to reach the container.

### Values lost after cluster destroy
Values are cluster-local (encrypted on the node). Destroying a cluster deletes all stored values. Re-enter them via the UI after re-creating the cluster.
