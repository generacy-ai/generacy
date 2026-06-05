# Research: Cluster-side JIT git credential helper

## R-1: Hosting package — control-plane vs credhelper-daemon vs new package

**Decision**: Host the cache, dedup, and cloud-pull logic in `packages/control-plane`. Ship a thin per-invocation CLI wrapper (`git-credential-generacy`) as a second `bin/` from the same package.

**Rationale**:
- Control-plane already owns the cluster API key (`/var/lib/generacy/cluster-api-key`), the cloud relay connection, and the existing credential mediation surface (`PUT /credentials/:id`, `writeWizardEnvFile`, `setRelayPushEvent`). It is the cluster's already-elected credential mediator.
- It is a long-lived uid-1000 process — it can hold an in-memory cache across `get` calls and collapse concurrent fetches. A per-invocation binary cannot (FR-003, FR-009).
- credhelper-daemon is the uid-1002 ptrace-isolated local-secret server; it does not own cloud connectivity. Moving git-auth there would expand its trust boundary for zero benefit.
- A separate `packages/git-credhelper` would duplicate socket + daemon infrastructure for ~200 LOC of net-new logic.

**Alternatives considered**: credhelper-daemon (rejected — wrong process boundary); new standalone package (rejected — infra duplication); a per-invocation binary with no cache (rejected — collapses FR-003 / FR-009 to no-ops).

**Source**: Clarification Q1 (spec §Clarifications).

## R-2: Cache process model and concurrency

**Decision**: Single-token in-memory cache inside the control-plane process. Concurrent `get` calls dedupe via an in-flight `Promise<CacheEntry>` field.

**Pattern**:
```ts
class GitTokenManager {
  private cache: { token: string; expiresAt: Date } | null = null;
  private inFlight: Promise<CacheEntry> | null = null;

  async getToken(credentialId: string): Promise<{ token: string; expiresAt: Date }> {
    if (this.cache && this.cache.expiresAt.getTime() - Date.now() > REFRESH_WINDOW_MS) {
      // cache hit
      return this.cache;
    }
    if (this.inFlight) {
      // collapse to existing in-flight fetch
      return this.inFlight;
    }
    this.inFlight = this.fetchFromCloud(credentialId).finally(() => { this.inFlight = null; });
    const fresh = await this.inFlight;
    this.cache = fresh;
    return fresh;
  }
}
```
This is the same in-flight-Promise pattern used in many caching libraries (e.g., the `p-memoize` family) and is the smallest correct implementation. No locks; the JS event loop serializes mutation of the `inFlight` field naturally.

**Refresh window**: 5 minutes (`5 * 60_000` ms) — matches the spec's `~5 min` pre-expiry refresh language (FR-004) and aligns with `#762`'s `expiresAt - now <= 5 min` check in `credential-expiry-watcher.ts`.

**Alternatives considered**:
- Background timer / proactive warmer (B/C in Q4): rejected for v1. Adds idle cloud load and a second code path. Synchronous-on-demand already satisfies the mid-workflow guarantee (every `get` is handed a valid token), and post-window refresh latency is a single cloud RTT — negligible compared to the git op that follows.
- Mutex / `AsyncLock` library: rejected. The in-flight-Promise pattern is mutex-free and dependency-free.

**Source**: Clarifications Q2 + Q4.

## R-3: Cloud pull endpoint authentication

**Decision**: Reuse the cluster API key persisted at `/var/lib/generacy/cluster-api-key` by `packages/orchestrator/src/activation/persistence.ts`. Inject it as `Authorization: Bearer <key>` (exact header format pending confirmation with cloud team on #817).

**Rationale**:
- Same credential the relay handshake uses to identify the cluster — cloud already trusts it.
- Already on disk by the time post-activation flows run; no new persistence required.
- File is mode 0600, owned by the uid that runs control-plane.
- Helper being unavailable pre-activation is acceptable: git auth is not needed until post-activation flows, and the `bootstrap-complete` lifecycle action gates the entire post-activation phase.

**Read pattern**: small `cluster-api-key.ts` helper that reads the file lazily on first request, caches the value, and invalidates on `mtime` change (so a future re-activation transparently picks up a rotated key without restarting control-plane). Pattern mirrors `wizard-creds-token-provider.ts:createWizardCredsTokenProvider`.

**Alternatives considered**:
- Per-credential credhelper session (Q3 option B): rejected as more machinery than needed — session lifecycle adds nothing that the API key file doesn't give us.
- New signed cluster-identity mechanism (Q3 option C): rejected unless the cloud team requires it on #817. Reuse keeps the surface small.

**Source**: Clarification Q3.

## R-4: Pre-expiry refresh trigger — synchronous-on-demand only

**Decision**: No background timer. The next `get` inside the 5-minute pre-expiry window triggers a synchronous refresh, returns the fresh token to git, and updates the cache.

**Rationale**:
- Every git op is *always* handed a token that is current — there is no window in which a stale token can be returned, by construction.
- A 60s background timer would refresh up to ~24 times/day per cluster while idle. With many clusters, that becomes meaningful cloud load for no correctness gain.
- Refresh latency on the first post-window `get` is one cloud RTT (typically < 500 ms). Negligible against a `git fetch` or `git push` that itself takes seconds.

**Failure semantics**: if the synchronous refresh fails, the helper does not return the stale token. It exits non-zero with a distinct error (FR-008). This is the loud-failure ethos from #762.

**Re-evaluate if**: telemetry (FR-010) shows operator-visible refresh latency spikes, or if SC-003 (≥95% cache hits) is met but with a long tail of high-latency `get` calls at boundary times.

**Source**: Clarification Q4.

## R-5: Git credential-helper line protocol

**Decision**: Implement the standard git credential-helper protocol with `get`, `store`, and `erase` verbs. Only `get` is load-bearing; `store` and `erase` are no-ops that read and discard the input.

**Protocol shape**:
- Input on stdin: a stream of `key=value\n` lines terminated by a blank line. Common keys: `protocol`, `host`, `path`.
- Output on stdout for `get`: the input echoed plus `username=<u>\npassword=<p>\n`, terminated by a blank line.
- Non-zero exit + stderr message on failure (FR-008).

**Username choice**: constant `x-access-token` (FR-012, clarification Q5). This is GitHub's documented sentinel username for installation tokens over HTTPS Basic Auth, already used in `packages/control-plane/src/services/peer-repo-cloner.ts:25` for the `x-access-token:<token>@github.com/...` URL pattern.

**Host scoping**: cluster-base configures the helper as `credential.https://github.com.helper` (FR-006). Git will not invoke it for other hosts. As a defensive secondary, the wrapper itself MAY check the `host` input line and exit cleanly without a credential when it is not `github.com` — but configuring per-host in cluster-base is the primary mechanism.

**Reference**: [git-credential(1) — INPUT/OUTPUT FORMAT](https://git-scm.com/docs/git-credential), [Custom Helpers](https://git-scm.com/docs/gitcredentials#_custom_helpers).

**Source**: spec FR-001, FR-012; clarification Q5.

## R-6: Unix-socket HTTP client in the CLI wrapper

**Decision**: Use Node's built-in `http.request({ socketPath, method, path, headers })` to call the control socket. No new dependency.

**Rationale**:
- This is the same pattern used everywhere else in the cluster: control-plane and credhelper-daemon both serve plain HTTP over a Unix socket, and existing in-cluster clients (e.g., orchestrator → control-plane probes, credhelper-daemon HTTP) use `node:http` with a `socketPath` option.
- Avoids pulling in `undici`, `node-fetch`, or any wrapper. The wrapper binary must remain trivially small and fast to spawn — git invokes it per request.

**Socket path resolution**: `process.env.CONTROL_PLANE_SOCKET_PATH ?? '/run/generacy-control-plane/control.sock'` (mirrors `bin/control-plane.ts:17-19` and FR-005's note).

## R-7: Cloud pull client

**Decision**: A minimal `node:https` client in `packages/control-plane/src/services/cloud-pull-client.ts`. Reads the cloud URL from `GENERACY_API_URL` (the v1.5 phase-4 canonical env var per CLAUDE.md "Phase 4 Cleanup"), the cluster API key from `/var/lib/generacy/cluster-api-key`, and POSTs to the cloud endpoint defined by generacy-cloud#817.

**Error mapping**:
| Failure | Error code returned to caller |
|---------|-------------------------------|
| API key file missing | `CLUSTER_API_KEY_MISSING` |
| Network / DNS / connect error | `CLOUD_UNREACHABLE` |
| HTTP 401/403 from cloud | `CLOUD_AUTH_REJECTED` |
| HTTP 4xx (other) from cloud | `CLOUD_REQUEST_INVALID` |
| HTTP 5xx from cloud | `CLOUD_UPSTREAM_ERROR` |
| 2xx but body fails Zod | `CLOUD_RESPONSE_INVALID` |

These map directly to the helper's `stderr` output so operators can grep for them (FR-008, SC-005). Telemetry (FR-010) logs the same codes.

**No retries on first failure**: the helper fails fast on the first cloud error. Adding retries hides the failure mode behind latency; per #762's loud-failure ethos, the operator should see the error promptly rather than a hung `git fetch`.

**Alternatives considered**: `@generacy-ai/activation-client` (an existing package that already wraps `node:http`/`node:https` for cloud calls): not adopted because (a) its API surface is shaped for the device-code flow, (b) the on-demand endpoint is a single POST and doesn't justify reusing a dedicated package. If the cloud endpoint grows additional methods, we can revisit moving into a shared `cloud-client` package.

## R-8: Stop seeding `GH_TOKEN` for git — companion-PR boundary

**Decision**: This repo's responsibility ends at "provide a working credential helper." Removing `GH_TOKEN` from `~/.git-credentials` and `~/.netrc` and writing `git config --global credential.https://github.com.helper /usr/local/bin/git-credential-generacy` is owned by the companion PR **generacy-ai/cluster-base#61**.

**Why split**: the cluster-base image owns boot-time global git config and the `~/.git-credentials` file via `setup-credentials.sh` / `entrypoint-post-activation.sh`. Changing those files is a cluster-base concern; the helper binary is a generacy concern.

**Coordination**: both PRs must land in tandem for SC-002 to hold. Until cluster-base#61 ships, the helper is built and installable but not wired — git will still use the legacy static token. This is documented in the spec Dependencies section.

**Source**: spec FR-006, FR-007, Out of Scope §6.

## R-9: Telemetry log shape

**Decision**: One JSON log line per `get` call and per cloud-pull attempt, on stdout (already where control-plane logs live).

**Per-`get` line**:
```json
{ "event": "git-token-get", "result": "cache-hit" | "refresh-success" | "refresh-error", "credentialId": "<id>", "expiresAt": "<iso>", "errorCode": "..."?, "durationMs": <number> }
```

**Per cloud-pull line**:
```json
{ "event": "git-token-cloud-pull", "result": "ok" | "error", "errorCode": "..."?, "httpStatus": <number>?, "durationMs": <number> }
```

**Why structured**: matches existing control-plane log style (e.g., `bin/control-plane.ts:111` `{ event: 'store-init', store, ...result }`). Lets operators grep `result=refresh-error` or compute SC-003 / SC-004 by counting events.

**Bonus (deferred)**: relay-channel propagation of these events (e.g., `cluster.git-credentials`) — out of scope for v1; the local log is sufficient.

**Source**: spec FR-010, SC-003, SC-004.

## R-10: Binary distribution and PATH

**Decision**: `packages/control-plane` `package.json` `bin` field gains a second entry: `"git-credential-generacy": "./dist/bin/git-credential-generacy.js"`. Inside the cluster image (cluster-base), the global `git config credential.https://github.com.helper` is set to the absolute path `/usr/local/bin/git-credential-generacy`, which cluster-base symlinks to the installed binary (companion PR's concern).

**Rationale**:
- Git invokes credential helpers by absolute path or by name on `$PATH`. Absolute path is unambiguous, immune to per-user `$PATH` drift, and matches the existing `code-server` / `code tunnel` integration pattern (cluster-base places binaries under `/usr/local/bin/`).
- Shipping from the same package as the server keeps the CLI wrapper version-locked to the server's protocol.

**Why not a separate npm package**: same reasoning as R-1 — would duplicate publishing and CI for trivial code.

---

## Open items (none blocking)

1. **Exact cloud endpoint URL/path on #817**: TBD with the cloud team. The client is structured so swapping the URL is a one-line change.
2. **Auth header format on the cloud endpoint**: `Authorization: Bearer <key>` is the spec's stated assumption (matches relay-handshake pattern); confirm during integration on #817.
3. **Response payload shape on #817**: the `cloud-pull-endpoint.schema.json` in `contracts/` captures the assumed shape (`{ token, expiresAt }`); align with cloud team during integration.

## References

- `packages/control-plane/src/services/peer-repo-cloner.ts:22-28` — existing `x-access-token` URL pattern (FR-012 cross-reference).
- `packages/orchestrator/src/activation/persistence.ts` — owns `/var/lib/generacy/cluster-api-key` (R-3, R-7).
- `packages/orchestrator/src/services/wizard-creds-token-provider.ts` — mtime-cached file-read pattern that `cluster-api-key.ts` mirrors (R-3).
- `packages/control-plane/bin/control-plane.ts` — control-plane bootstrap pattern (R-2, R-9).
- `packages/control-plane/src/router.ts` — route registration pattern (plan project structure).
- generacy-ai/generacy#762 — loud-failure backstop pattern; preserves the *non-git* `gh` CLI auth path through `wizard-creds-token-provider`.
- generacy-ai/generacy-cloud#817 — cloud on-demand installation-token pull endpoint (blocking upstream).
- generacy-ai/cluster-base#61 — companion image-side wiring (FR-006, FR-007).
- [git-credential(1) — line protocol](https://git-scm.com/docs/git-credential).
- [GitHub Docs — Authenticating with installation tokens (`x-access-token`)](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).
