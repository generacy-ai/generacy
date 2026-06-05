# Quickstart: Cluster-side JIT git credential helper

This document covers how to validate the helper locally in a development cluster after the patches in this spec land. It assumes the companion cluster-base PR (generacy-ai/cluster-base#61) has been applied to the image, and that generacy-cloud#817 has been deployed (or is mocked — see *Mocking the cloud* below).

## Prerequisites

- A booted Generacy cluster (`pnpm dev` + Firebase emulators, or a deployed cluster via `generacy launch`).
- Control-plane process running. Verify with:
  ```bash
  curl --unix-socket /run/generacy-control-plane/control.sock http://_/state | jq .status
  # → "ready"
  ```
- Cluster activated. The file `/var/lib/generacy/cluster-api-key` exists and is mode 0600.
- A `github-app` credential configured in `.agency/credentials.yaml`.

## Build

From the repo root:

```bash
pnpm -F @generacy-ai/control-plane build
```

This produces:
- `packages/control-plane/dist/bin/control-plane.js` (existing entry, modified)
- `packages/control-plane/dist/bin/git-credential-generacy.js` (NEW)

cluster-base#61 symlinks `/usr/local/bin/git-credential-generacy` to that script and sets:
```bash
git config --global credential.https://github.com.helper /usr/local/bin/git-credential-generacy
```

## Validate end-to-end

### 1. Helper returns a fresh token

```bash
printf 'protocol=https\nhost=github.com\n\n' | git-credential-generacy get
```

Expected stdout (the `password` value will differ):
```
protocol=https
host=github.com
username=x-access-token
password=ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

```

Exit code: 0.

### 2. Cache hit on second call within a token lifetime

In control-plane logs (`docker compose logs control-plane -f`), the first call emits:
```json
{ "event": "git-token-get", "result": "refresh-success", "credentialId": "...", "expiresAt": "...", "durationMs": 312 }
```

The second call (within 55 min) emits:
```json
{ "event": "git-token-get", "result": "cache-hit", "credentialId": "...", "expiresAt": "...", "durationMs": 2 }
```

This is the SC-003 observability path.

### 3. Real `git` operation uses the helper

Inside the cluster (`docker compose exec orchestrator bash`):
```bash
cd /tmp
GIT_TRACE=1 git clone https://github.com/<org>/<private-repo>.git
```

`GIT_TRACE=1` will log the helper invocation:
```
... trace: run_command: 'git-credential-generacy' 'get'
```

The clone should succeed. No prompt for credentials, no token visible in the trace output (passwords are redacted by git's tracer).

### 4. Loud failure when cloud is unreachable

In a separate shell, block the cloud endpoint:
```bash
# Simulate cloud-down by stopping the cloud emulator, or block egress with iptables (for a real cluster)
docker stop generacy-cloud-emulator   # adjust to your local stack
```

Now run:
```bash
printf 'protocol=https\nhost=github.com\n\n' | git-credential-generacy get
echo "exit=$?"
```

Expected:
- stdout: empty
- stderr: `generacy-git-helper: CLOUD_UNREACHABLE: ...`
- `exit=4`

This is SC-005.

### 5. No static token on disk

```bash
grep -r 'ghs_' ~/.git-credentials ~/.netrc 2>/dev/null
grep -r 'ghs_' /var/lib/generacy/wizard-credentials.env 2>/dev/null
```

Expected: no matches in `~/.git-credentials` or `~/.netrc` (SC-002). A `GH_TOKEN=ghs_…` line in `wizard-credentials.env` is acceptable per Out-of-Scope item 5 (it serves `gh` CLI in monitors, not git).

## Mocking the cloud (when generacy-cloud#817 is not yet deployed)

For development before the cloud endpoint exists, run a tiny mock that returns a fixed token:

```bash
# Mock listening on a Unix socket the cloud-pull-client points at.
# Replace GENERACY_API_URL temporarily to a local mock server URL, or
# spin up the existing generacy-cloud emulator with the stub endpoint enabled.
```

Pattern: identical to `GENERACY_LAUNCH_STUB=1` used by the `generacy launch` CLI (see `packages/generacy/src/cli/commands/launch/cloud-client.ts`). The cloud-pull-client honors the same env override.

## Available commands and endpoints

### Control-plane HTTP (over `/run/generacy-control-plane/control.sock`)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/git-token` | Returns `{ token, expiresAt }` for the configured credential. See `contracts/control-plane-git-token.schema.json`. |
| (existing) | `/state`, `/credentials/:id`, `/lifecycle/:action`, etc. | Unchanged. |

Call directly with `curl`:
```bash
curl --unix-socket /run/generacy-control-plane/control.sock \
     -H 'content-type: application/json' \
     -d '{}' \
     http://_/git-token
```

### CLI wrapper

| Command | Behavior |
|---------|----------|
| `git-credential-generacy get` | Read stdin (git's credential request), POST `/git-token`, emit username/password lines. |
| `git-credential-generacy store` | No-op. Read stdin to EOF, exit 0. |
| `git-credential-generacy erase` | No-op. Read stdin to EOF, exit 0. |

The wrapper has no other flags or subcommands.

### Environment variables

| Var | Default | Read by | Purpose |
|-----|---------|---------|---------|
| `CONTROL_PLANE_SOCKET_PATH` | `/run/generacy-control-plane/control.sock` | CLI wrapper, control-plane bin | Where the CLI wrapper connects. |
| `GENERACY_API_URL` | (no default — required) | control-plane cloud-pull-client | Cloud base URL. v1.5 canonical (see CLAUDE.md Phase 4). |
| `GENERACY_LAUNCH_STUB` | unset | cloud-pull-client (if reused) | Enables in-process stub for local dev. |

## Troubleshooting

### `fatal: Authentication failed for 'https://github.com/...'`

Run the wrapper directly to surface the underlying error:
```bash
printf 'protocol=https\nhost=github.com\n\n' | /usr/local/bin/git-credential-generacy get
```

The stderr line names the failure code. Cross-reference:

| Code | What to check |
|------|----------------|
| `CONTROL_SOCKET_UNREACHABLE` | Is the control-plane process running? `ls -la /run/generacy-control-plane/control.sock` |
| `CLUSTER_API_KEY_MISSING` | Has the cluster completed activation? `ls -la /var/lib/generacy/cluster-api-key` |
| `CLOUD_UNREACHABLE` | Cloud egress allowed? Cloud emulator running? `$GENERACY_API_URL` set? |
| `CLOUD_AUTH_REJECTED` | The cluster API key is no longer accepted. Cloud rotated it, or activation never completed cleanly. |
| `CLOUD_REQUEST_INVALID` | Likely a credential ID mismatch — check `.agency/credentials.yaml`. |
| `CLOUD_UPSTREAM_ERROR` | Cloud is down or returning 5xx — escalate to the cloud team. |
| `CLOUD_RESPONSE_INVALID` | Cloud returned a body this client can't parse — version skew with generacy-cloud#817. |
| `CREDENTIAL_NOT_CONFIGURED` | No `github-app` entry in `.agency/credentials.yaml`. Did the wizard run? |

### Helper returns a token but `git clone` still fails

- Check that cluster-base#61 actually wired `credential.https://github.com.helper`:
  ```bash
  git config --get credential.https://github.com.helper
  # expected: /usr/local/bin/git-credential-generacy
  ```
- Check no competing helper is configured:
  ```bash
  git config --list | grep credential
  ```
  A `credential.helper=store` global config will short-circuit ours. Remove it or scope our helper higher.
- Check `~/.git-credentials` does not contain a stale `https://x-access-token:OLD_TOKEN@github.com` line (SC-002). If so, cluster-base#61 isn't fully applied.

### Token is being fetched on every `git` invocation (cache miss)

- Control-plane was recently restarted: expected on first call after restart.
- The cluster has many short-lived workers spawning git ops in parallel: check the dedup log (`event: git-token-get, result: refresh-success` should appear once even with many concurrent `get` calls).
- The token genuinely expired (close to 1h since last refresh): the next call shows `refresh-success` and the cycle resumes.

### `journalctl`/`docker logs` shows the token in plaintext

This is a bug. Tokens must never be logged. File against this issue.

## Rollback

If something is wrong with the helper itself:
1. cluster-base#61 unwires the git config: `git config --global --unset credential.https://github.com.helper`.
2. Restore static `GH_TOKEN` seeding in `~/.git-credentials` from `wizard-credentials.env` (the prior code path is the rollback target).
3. Long-running workers will resume the #762 failure pattern until refreshed — same as before this work landed.

There is no in-process rollback inside the control-plane. The endpoint either exists (build present) or 404s.

## See also

- [spec.md](./spec.md) — feature specification
- [plan.md](./plan.md) — implementation plan + file layout
- [research.md](./research.md) — technology decisions
- [data-model.md](./data-model.md) — entities and validation rules
- [contracts/](./contracts) — wire-shape contracts for the route, cloud client, and CLI protocol
