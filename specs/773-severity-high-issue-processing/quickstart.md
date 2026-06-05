# Quickstart: JIT GH-CLI Token Provider (#773)

**Branch**: `773-severity-high-issue-processing`

This feature has no user-facing UX. The "user" is the worker process and the orchestrator's three GitHub monitors. The validation surface is: a cluster runs continuously for many hours, processing GitHub issues end-to-end without any `gh` 401 errors and without manual credential refresh.

## What changes for operators

Nothing. There is no new env var, no new config flag, no new container, no new socket, no new lifecycle action.

The only observable difference is that:
- Workers no longer fail with `GhAuthError: gh authentication failed (HTTP 401): Bad credentials` after ~1 hour.
- The orchestrator's `cluster.credentials` relay channel emits `auth-failed` + `refresh-requested` events the moment `POST /git-token` fails, instead of waiting for the next monitor-driven `gh` 401 to surface the problem.

## How to run the cluster

Unchanged from the existing dev-stack quickstart:

```bash
# 1. Launch the cluster (existing CLI command)
npx @generacy-ai/generacy launch --claim=<code>

# 2. Wait for the wizard to complete (cloud-side flow)
#    The wizard's "Credentials" step seals a github-app credential into
#    /var/lib/generacy/credentials.dat. From that point on, every gh-CLI
#    call inside the cluster auto-fetches a fresh installation token.

# 3. Observe issue processing
npx @generacy-ai/generacy open
```

## How to verify the fix

### Manual

Inside an orchestrator or worker container after activation:

```bash
# Old behavior (pre-#773): GH_TOKEN dies after ~1h
gh api repos/{owner}/{repo}
# After ~1h: HTTP 401: Bad credentials

# New behavior (post-#773): each gh invocation gets a fresh token
# Run continuously for >1h; expect zero 401s.
while true; do gh api rate_limit | jq '.rate.remaining'; sleep 60; done
```

The orchestrator's `gh`-CLI clients now route through `JitGithubTokenProvider` → `JitGitTokenClient` → `POST /git-token` (control-plane) → `GitTokenManager` → `CloudPullClient` → cloud installation-token endpoint. Each `gh` invocation calls the provider, which either returns a cached token (cache hit) or fetches a fresh one (cache miss, or within 5 min of expiry).

### Programmatic (CI smoke)

```bash
# Trigger a multi-hour soak by feeding the cluster issues continuously.
# Expected: zero `GhAuthError` log lines across the entire window.
docker compose logs orchestrator | grep -c GhAuthError  # → 0
docker compose logs worker      | grep -c GhAuthError  # → 0
```

### Failure-mode injection (negative test)

Stop the control-plane process while the worker is mid-cycle, then observe:

```bash
docker compose stop control-plane
# Watch worker logs:
docker compose logs -f worker | grep -i 'jit'
# Expect: structured warn lines like
#   { code: 'CONTROL_SOCKET_UNREACHABLE', credentialId: '<id>' }
#   "JIT token resolution failed"
# Then the gh subprocess does NOT run (no HTTP 401 round-trip).
# The orchestrator's cluster.credentials relay channel emits
#   { action: 'auth-failed' }
#   { action: 'refresh-requested' }
# within seconds of the failure, NOT minutes later.
```

## Available commands

No new commands. The existing CLI surface is unchanged. The provider is invoked transparently inside the orchestrator and worker processes.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Worker logs `JitTokenError: code=CONTROL_SOCKET_UNREACHABLE` | The control-plane process or the #768 proxy bin is down | `docker compose ps` — confirm `control-plane` and `git-token-proxy` are running. Restart if needed. |
| Worker logs `JitTokenError: code=CLUSTER_API_KEY_MISSING` | `/var/lib/generacy/cluster-api-key` file is missing or unreadable | Re-run activation (`generacy launch` from scratch, or `generacy claude-login` to refresh) |
| Worker logs `JitTokenError: code=CLOUD_AUTH_REJECTED` | The cluster API key has been revoked or rotated server-side | Same as above — re-activate |
| Worker logs `JitTokenError: code=CLOUD_UNREACHABLE` | The cloud API is unreachable from the cluster | Check egress / DNS. `curl -sS $GENERACY_API_URL/health` from inside the container. |
| Orchestrator `cluster.credentials` relay channel goes silent during a failure | Either `authHealth` was constructed without a credentialId (no github-app credential configured) or the relay client is disconnected | Verify `.agency/credentials.yaml` contains a `type: github-app` entry. Check relay connection status in orchestrator logs. |
| `gh` falls back to ambient stale token (the bug we fixed reappears) | `JitGithubTokenProvider` returned undefined — which it MUST NEVER do | This is a regression. Open a bug. The provider's invariant (data-model.md #3) is being violated. |

## Rollback

This PR has no schema changes, no env-var changes, no new sockets, no new files in `/var/lib`. To roll back:

```bash
git revert <merge-commit-of-773>
```

After revert, `wizardCredsTokenProvider` is restored and the cluster returns to the pre-fix behavior (gh 401s after ~1h). No data migration. No worker rebuild required beyond the image swap.
