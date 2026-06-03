# Quickstart: Per-cluster names + multi-cluster tunnels

After this change lands, here's how the new flags and behaviors are used and tested.

## CLI Usage

### Launch a named cluster

```bash
# Explicit name
npx generacy launch --claim=ABC-123 --name acme-frontend

# Defaulted name (auto-incremented per project on this host)
npx generacy launch --claim=ABC-123
# → registers as "<sanitized-project>-local-1" (or -local-2, -local-3, ... if you've launched before)
```

Normalization is applied to `--name`:
- `--name "ACME Frontend"` → stored as `acme-frontend`
- `--name "123-foo"` → stored as `c-123-foo`
- `--name " !!! "` → rejected (normalizes to empty)

### Deploy a named cluster

```bash
npx generacy deploy ssh://user@host --name acme-prod

# Without --name, deploy continues to use the cluster UUID as display name (no default generator yet)
npx generacy deploy ssh://user@host
```

### Inspect

```bash
generacy status         # Shows displayName + clusterId + deploymentMode
generacy status --json  # Machine-readable
```

### Teardown frees the tunnel

```bash
generacy stop      # Disconnects the dev tunnel (resumes on `generacy up`)
generacy down      # Disconnects + removes containers
generacy destroy   # Unregisters the tunnel name from Microsoft + nukes .generacy/
```

`destroy` calls the new `vscode-tunnel-unregister` lifecycle action; subsequent `generacy launch` for the same `cluster_id` succeeds without "tunnel name already in use" errors.

## Verifying

### 1. Two clusters under one project don't collide

```bash
mkdir alpha bravo
cd alpha && generacy launch --claim=<code1>   # creates cluster A
cd ../bravo && generacy launch --claim=<code2> # creates cluster B (same project, different cluster)
generacy status
# Both clusters list with distinct displayNames and distinct tunnel names (g-<uuid18> each)
```

In the cloud dashboard (companion: generacy-cloud#792), both clusters appear with their distinct `displayName` values and tunnels open to distinct `vscode.dev/tunnel/<name>` URLs.

### 2. Default-name uniqueness

```bash
for i in 1 2 3 4 5; do
  generacy launch --claim=<fresh-code>  # all in the same project
done
# → registry has acme-local-1 through acme-local-5
```

### 3. Tunnel name conforms to constraint

```bash
# In any cluster container:
node -e "
  const { deriveTunnelName } = require('@generacy-ai/control-plane/dist/services/vscode-tunnel-manager.js');
  console.log(deriveTunnelName('9e5c8a0d-755e-40b3-b0c3-43e849f0bb90'));
"
# → g-9e5c8a0d755e40b3b0  (20 chars, lowercase, starts with letter)
```

## Troubleshooting

### "tunnel name already in use" on re-launch

Symptom: VS Code tunnel logs show fallback to a random name after `generacy destroy && generacy launch`.

Cause: previous `destroy` failed to unregister (e.g. lost network during teardown). The tunnel name is still claimed in your Microsoft account.

Fix:
```bash
docker compose exec orchestrator code tunnel unregister --name g-<your-uuid18>
# or manually delete via https://github.com/settings/codespaces/tunnels
```

### Two clusters keep getting the same default name

Symptom: parallel `generacy launch` invocations land on the same `-local-<n>`.

Cause: registry sequence generation is not locked.

Fix: rename one cluster manually by editing `~/.generacy/clusters.json` (cluster rename is out of scope for this milestone).

### `--name` was accepted but stored differently

Expected: input is normalized (lowercase, non-alphanum → `-`, etc.). Check `.generacy/cluster.json` `display_name` and `~/.generacy/clusters.json` `displayName` — they should both hold the normalized form.

### Cloud doesn't show display name

Companion change: generacy-cloud#792 reads `displayName` from the relay metadata payload. If the cloud dashboard still shows the cluster UUID, the cloud-side change hasn't landed yet — verify the relay `metadata` event in the cloud's WebSocket logs.
