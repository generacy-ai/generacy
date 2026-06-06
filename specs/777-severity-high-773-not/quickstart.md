# Quickstart: verify the #777 fix

This guide reproduces the bug on a real wizard-bootstrapped cluster and confirms the fix restores hours-long `gh` operation with zero ambient-token fallback.

## Prerequisites

- A wizard-bootstrapped cluster (any v1.5 cluster bootstrapped via the cloud wizard — i.e. all current clusters).
- SSH or shell access to the orchestrator container (e.g. via `docker compose exec orchestrator bash` or VS Code tunnel).
- A GitHub PAT or app installation with read access to the cluster's primary repo (any working `gh auth` outside the container is fine; the container uses its own creds).

## Reproduce the bug (pre-fix)

1. **Wait for the wizard `GH_TOKEN` to expire** (≈ 1 h after activation), OR force-expire it by overwriting the env file:
   ```sh
   docker compose exec orchestrator bash -c 'echo "GH_TOKEN=ghs_expired_dummy_token_value" > /var/lib/generacy/wizard-credentials.env'
   docker compose restart orchestrator
   ```
2. **Confirm `/git-token` still returns a valid token** (proves the control-plane path is healthy):
   ```sh
   docker compose exec orchestrator \
     curl -sS --unix-socket /run/generacy-control-plane/control.sock \
       -X POST http://x/git-token -H 'content-type: application/json' -d '{}'
   # → {"token":"ghs_…","expiresAt":"…"}
   ```
3. **Confirm a credential-less probe with the JIT token works**:
   ```sh
   TOKEN=$(docker compose exec orchestrator \
     curl -sS --unix-socket /run/generacy-control-plane/control.sock \
       -X POST http://x/git-token -H 'content-type: application/json' -d '{}' \
     | jq -r .token)
   docker compose exec -e GH_TOKEN="$TOKEN" orchestrator gh api repos/<org>/<repo>
   # → 200, repo JSON
   ```
4. **Confirm the orchestrator's own `gh` calls 401** (the bug):
   ```sh
   docker compose exec orchestrator gh api repos/<org>/<repo>
   # → HTTP 401: Bad credentials (because GH_TOKEN env in container = expired wizard token)
   ```
5. **Confirm the orchestrator logs show no JIT provider construction**:
   ```sh
   docker compose logs orchestrator | grep -i 'JitGithubToken\|github-app credential'
   # → either no matches, or a log line saying provider was not constructed
   ```

## Apply the fix

1. **Pull a build that includes #777**. Either:
   - Rebuild the orchestrator image from this branch:
     ```sh
     docker compose build --no-cache orchestrator
     docker compose up -d orchestrator
     ```
   - Or, in a dev container with mounted sources, restart after the code change:
     ```sh
     docker compose restart orchestrator
     ```
2. **Confirm `/var/lib/generacy/cluster-api-key` is present** (precondition for provider construction):
   ```sh
   docker compose exec orchestrator test -f /var/lib/generacy/cluster-api-key && echo OK
   # → OK
   ```

## Verify the fix

### V1 — gh now works credential-less

```sh
docker compose exec orchestrator gh api repos/<org>/<repo>
# → 200, repo JSON (using freshly-fetched JIT token, not ambient)
```

### V2 — provider was constructed without a `github-app` descriptor

```sh
# Confirm no github-app descriptor in credentials.yaml:
docker compose exec orchestrator \
  cat /workspaces/<primary-repo>/.agency/credentials.yaml | grep -A1 'type:'
# → no `type: github-app` line

# Confirm the provider was wired (look for the first JIT fetch log line):
docker compose logs orchestrator | grep -i 'JIT GitHub token' | head
# → at least one entry, with `credentialId: '__wizard__'` (the sentinel)
```

### V3 — ambient leak is impossible

Inspect the env of the `gh` subprocess spawned by the label monitor. Easiest: trace one poll cycle in dev logs (with debug logging on the workflow-engine, or with a one-off strace) and confirm `GH_TOKEN` in the spawn env matches the freshly-fetched JIT token, **not** the value in `/var/lib/generacy/wizard-credentials.env`.

Alternatively, in a debug build, log the first 8 chars of `GH_TOKEN` from `GhCliGitHubClient.executeGh` and confirm rotation across hours.

### V4 — fail-loud on /git-token failure

Simulate a control-plane outage and confirm `gh` is **not** spawned with the ambient token:

```sh
docker compose stop control-plane
# Wait for a label-monitor poll cycle (default: 60s):
docker compose logs --tail=200 -f orchestrator | grep -i 'JIT.*failed\|skip'
# → a warn line ('JIT GitHub token refresh failed'), then a caller-side skip.
# Confirm no `gh api` 401 line ('Bad credentials') in the same cycle.
docker compose start control-plane
```

### V5 — long-run stability

Leave the cluster running for at least 4 hours and confirm zero `gh` 401 lines in orchestrator logs:

```sh
docker compose logs --since 4h orchestrator | grep -i 'Bad credentials\|HTTP 401'
# → empty (or only contains pre-fix entries)
```

### V6 — descriptor-present path unchanged

Manually add a synthetic `github-app` descriptor to `.agency/credentials.yaml`:
```yaml
credentials:
  test-app:
    type: github-app
```
Restart the orchestrator, confirm logs show `credentialId: 'test-app'` (not `'__wizard__'`) in the first JIT fetch entry, and confirm `gh` still works.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `gh api` still 401 with `Bad credentials` after fix | Container wasn't restarted; old binary still loaded | `docker compose restart orchestrator` |
| No JIT log lines and `gh` still 401 | `/var/lib/generacy/cluster-api-key` is missing | Cluster was never activated — re-run wizard or `npx generacy launch --claim=<code>` |
| JIT logs but every fetch errors with `CONTROL_SOCKET_UNREACHABLE` | Control-plane crashed (see #624) | `docker compose logs control-plane`; if `init-result.json` shows disabled stores, fix the underlying EACCES |
| `gh` still uses an old token after sentinel logs appear | Token cache hasn't expired yet (default 5-min refresh window) | Wait ≥ 5 min from the cached token's expiry, or restart orchestrator to flush the cache |

## Rollback

The change is contained to three files. To roll back, revert the commits on this branch and redeploy. No data migration, no config change, no schema change — the rollback restores the pre-fix gating behavior verbatim.
