# Research: JIT GH-CLI Token Provider (#773)

**Branch**: `773-severity-high-issue-processing`
**Date**: 2026-06-05

## Decisions

### D1. Socket-call client lives in `packages/control-plane`, not `packages/orchestrator`

**Decision**: Extract `JitGitTokenClient` into `packages/control-plane/src/services/jit-git-token-client.ts` and re-export it from `packages/control-plane/src/index.ts`.

**Rationale**: `POST /git-token` is owned by `packages/control-plane` (route at `src/routes/git-token.ts`, types at `src/types/git-token.ts`, `GitHelperError` already exported). When the route shape evolves, the contract drifts in one package. Both `git-credential-generacy.ts` (a `bin` in the same package) and the new orchestrator provider depend on the same wire format, so co-locating the client with the route schema prevents skew.

**Alternatives considered**:
- *Orchestrator-only* (Q2 option A): would duplicate the inline `http.request` logic that already lives in `git-credential-generacy.ts`. Two implementations drifting silently is the failure mode that `#558` (shared backends) was designed to prevent — same pattern here.
- *Shared client AND shared caching* (Q2 option C): the bin is short-lived (one mint, exit). A cache there is dead weight; an opt-out flag adds API surface for one caller that doesn't need it.

**Sources**:
- `packages/control-plane/src/routes/git-token.ts` (route definition, error code → HTTP status mapping)
- `packages/control-plane/src/types/git-token.ts` (`GitHelperError`, `GitHelperErrorCode`, `GitTokenResponse`)
- `packages/control-plane/bin/git-credential-generacy.ts` (existing inline client to be replaced)
- `packages/control-plane/src/services/cloud-pull-client.ts` (existing client pattern within the package)
- CLAUDE.md `#558` section (precedent for cross-package shared modules in the owning package)

### D2. Caching lives in the orchestrator/worker wrapper, not the shared client

**Decision**: `JitGitTokenClient` performs one socket round-trip per call, no caching. The orchestrator-side `createJitGithubTokenProvider()` wraps it with an in-process `Map<credentialId, GitTokenCacheEntry>` keyed by `credentialId`. Refresh when `expiresAt - now ≤ 5 min` (constant `REFRESH_WINDOW_MS = 5 * 60_000`).

**Rationale**:
- `git-credential-generacy` is a fresh process per `git` op. Any cache it owns is invalidated by its own exit. The bin mints once and dies.
- `executeGh` (`packages/workflow-engine/src/actions/github/client/gh-cli.ts`) is invoked from a long-lived Node process (worker or orchestrator). Same `tokenProvider` is called dozens of times per `ClaudeCliWorker.handle()` cycle. A per-process cache is exactly the optimization needed.
- The 5-min pre-expiry window matches `GitTokenManager.REFRESH_WINDOW_MS` upstream (`packages/control-plane/src/services/git-token-manager.ts`). Symmetry simplifies reasoning: when the wrapper cache says "refresh," the upstream manager is likely also about to refresh — and the manager already coalesces concurrent refreshes via in-flight Promise (#766), so the wrapper doesn't need its own coalescer.

**Alternatives considered**:
- *No wrapper cache at all*: every `gh` invocation pays a Unix-socket round-trip. Negligible latency individually, but a `ClaudeCliWorker.handle()` cycle can call `gh` 50+ times. Cumulative ~50ms latency per cycle for zero benefit.
- *Disk cache*: defeats the point — survives process restart but the token expires in 1h anyway, and process restarts are rare enough that the lost cache costs ~1 round-trip.

**Sources**:
- `packages/control-plane/src/services/git-token-manager.ts` (upstream cache + 5-min window + in-flight coalescing)
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` (`tokenProvider?: () => Promise<string | undefined>`, called per `executeGh`)

### D3. Provider throws `JitTokenError` AND reports to `AuthHealthSink` on failure

**Decision**: On unrecoverable failure (socket unreachable, `/git-token` 4xx/5xx, malformed JSON, missing `token` field), the provider:
1. Calls `authHealth.recordResult(githubAppCredentialId, { ok: false, statusCode: 503 })`.
2. Throws a typed `JitTokenError` whose `code` mirrors the underlying `GitHelperErrorCode` (or `'CONTROL_SOCKET_UNREACHABLE'` for transport errors, matching the bin's exit-code taxonomy).
3. Never returns `undefined`.

**Rationale** (Q3 option B): Returning `undefined` falls back to `executeGh`'s ambient `process.env.GH_TOKEN` — which is exactly the expired static wizard token, silently reproducing the bug. Throwing surfaces the failure cleanly *before* `gh` is invoked (no 401 round-trip). Reporting to `AuthHealthSink` fires the #762 `auth-failed` / `refresh-requested` flow immediately, instead of waiting for the next `gh` 401 to land in `pollRepo()`'s catch branch.

**Alternatives considered**:
- *Throw only, no `AuthHealthSink`* (Q3 option A): defeats the #762 backstop's purpose — the loud `cluster.credentials` channel signal that the user / cloud is supposed to act on would only fire after a downstream `gh` 401.
- *Return `undefined` + log a warning* (Q3 option C): silently reverts to ambient `GH_TOKEN`, reproducing the bug.

**Sources**:
- `packages/orchestrator/src/services/github-auth-health.ts` — `AuthHealthSink.recordResult(credentialId, result)` signature, `auth-failed` / `refresh-requested` emission
- `packages/orchestrator/src/services/label-monitor-service.ts` (line ~17–22) — `AuthHealthSink` interface (lifted from the monitor)
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — `resolveTokenEnv()` returns `{}` when `tokenProvider()` returns `undefined`, which is where the fallback to `process.env.GH_TOKEN` happens
- spec.md "Fix" section bullet 3

### D4. Socket auto-resolution via env-var precedence chain

**Decision**: Inside `createJitGithubTokenProvider()`:
```
socketPath = process.env.GIT_TOKEN_SOCKET_PATH       // worker (proxy socket from #768)
          ?? process.env.CONTROL_PLANE_SOCKET_PATH    // orchestrator (direct control-plane socket)
          ?? '/run/generacy-control-plane/control.sock';
```

**Rationale** (Q4 option B, premise-corrected): The same Node binary runs in two container roles. Worker mode reaches `/git-token` via the #768 proxy socket (`/run/generacy-git-token/control.sock`) because workers run as `uid 1001` / `node` group, which can only see the proxy. Orchestrator mode reaches it directly via the control-plane socket. The env vars are already exported by the respective entrypoints (`GIT_TOKEN_SOCKET_PATH` by the worker entrypoint, `CONTROL_PLANE_SOCKET_PATH` by the orchestrator). This is the exact resolution chain `git-credential-generacy` already uses (today only `CONTROL_PLANE_SOCKET_PATH` — extending the bin to also honor `GIT_TOKEN_SOCKET_PATH` is part of this PR for parity).

**Important correction to earlier framing**: The spec's "Out of Scope" wording suggested worker gh paths were excluded. They are not. `server.ts:298` constructs `ClaudeCliWorker` inside `if (isWorkerMode)` (line 263) — it runs in the worker process and is the path that produced the original 401s.

**Alternatives considered**:
- *Orchestrator-only* (Q4 option A): leaves workers (the primary failure surface) unfixed. Rejected.
- *Per-instance constructor arg*: pushes resolution logic to two callers that should be identical. Rejected.

**Sources**:
- `packages/control-plane/bin/git-credential-generacy.ts` line 174 — existing `CONTROL_PLANE_SOCKET_PATH` env-var resolution
- CLAUDE.md `#768` section — `GIT_TOKEN_PROXY_SOCKET` / `GIT_TOKEN_SOCKET_PATH` proxy socket on `/run/generacy-git-token/control.sock`
- `packages/orchestrator/src/server.ts:263–298` — `ClaudeCliWorker` callsite inside `if (isWorkerMode)`

### D5. Delete `wizard-creds-token-provider.ts` and its tests in this PR

**Decision** (Q1 option B):
- Delete `packages/orchestrator/src/services/wizard-creds-token-provider.ts`.
- Delete `packages/orchestrator/tests/unit/services/wizard-creds-token-provider.test.ts`.
- Drop the `createWizardCredsTokenProvider` import from `packages/orchestrator/src/server.ts` (line 30).
- Replace all six callsites (`server.ts` lines 160, 207, 298, 335, 363, 616) with the new provider.
- Leave `packages/control-plane/src/services/wizard-env-writer.ts` emitting `GH_TOKEN` to `/var/lib/generacy/wizard-credentials.env` (other paths may still read the ambient env; the JIT provider overrides `GH_TOKEN` via `executeGh` env, so the lingering line is harmless).

**Rationale**: After the swap there is **no** in-tree gh-CLI consumer of `createWizardCredsTokenProvider`. Leaving the dead file invites future re-wiring (option A). Full retirement of the env-line (option C) requires auditing every consumer of `wizard-credentials.env` for `GH_TOKEN` (shell-level `gh`, setup scripts, post-activation flow) and lives in a separate follow-up.

**Sources**:
- `packages/orchestrator/src/server.ts` lines 30, 160, 207, 298, 335, 363, 616 (all six references confirmed via grep)
- `packages/control-plane/src/services/wizard-env-writer.ts` (existing — unchanged in this PR)
- CLAUDE.md `#589 / #592 / #628` sections — context on `wizard-credentials.env` purpose and `GH_TOKEN` mapping

## Implementation Patterns

### Pattern 1: `node:http` Unix-socket POST (`JitGitTokenClient`)

Reuse the exact request shape from `git-credential-generacy.ts:66-91`:
```ts
http.request({
  socketPath,
  path: '/git-token',
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
}, ...)
```
Difference: `JitGitTokenClient` accepts an optional `credentialId` and includes it in the JSON body when present (default credential is resolved by the route from the bound config, so omitting it is fine for the bin's case but not for the orchestrator's multi-credential future).

### Pattern 2: Error-code mapping

`JitGitTokenClient` throws `JitTokenError` with `code: GitHelperErrorCode | 'CONTROL_SOCKET_UNREACHABLE' | 'RESPONSE_PARSE_ERROR'`. Mapping mirrors the bin's `EXIT_CODE_BY_CODE` table (lines 15–25) so a future audit of failure modes sees consistent codes across CLI exit codes, HTTP status codes, and thrown errors.

### Pattern 3: `AuthHealthSink` integration

Inject the sink optionally (`authHealth?: AuthHealthSink`) plus the `githubAppCredentialId` (resolved once at startup in `server.ts:195–203` — already exists). On caught failure inside `createJitGithubTokenProvider`'s returned function, call `authHealth?.recordResult(githubAppCredentialId, { ok: false, statusCode: 503 })` before re-throwing. The `503` is a convention — it maps to "service unavailable" semantically and aligns with how `GitHelperError` maps transport failures to HTTP 502/503 in the route layer.

### Pattern 4: Test fixtures via `net.createServer` Unix-socket stub

Existing convention in `packages/control-plane/__tests__/bin/git-credential-generacy/`: vitest tests spin up a `net.createServer` Unix socket in a tmp dir, accept HTTP requests, respond with canned payloads. Reuse the same harness for `JitGitTokenClient` tests. For provider tests, mock the client directly (the wrapper's job is cache + sink wiring, not socket I/O).

## Sources / References

- Issue: [generacy-ai/generacy#773](https://github.com/generacy-ai/generacy/issues/773)
- Related PRs: #762 (cluster-side 401 backstop), #766 (cluster-side JIT git helper), #768 (worker-side git-token proxy), #819 / generacy-cloud#817 (cloud on-demand installation token endpoint), #620 (orchestrator GitHub monitors credential resolution)
- CLAUDE.md sections: "Cluster-side JIT Git Credential Helper (#766)", "Worker-side git-token Proxy Bin (#768)", "Cluster-Side GH_TOKEN Expiry Detection and Refresh Backstop (#762)", "Orchestrator GitHub Monitors Credential Resolution (#620)"
- Source files surveyed (paths confirmed via Explore agent):
  - `packages/control-plane/src/routes/git-token.ts`
  - `packages/control-plane/src/types/git-token.ts`
  - `packages/control-plane/src/services/git-token-manager.ts`
  - `packages/control-plane/src/services/cloud-pull-client.ts`
  - `packages/control-plane/bin/git-credential-generacy.ts`
  - `packages/control-plane/src/index.ts`
  - `packages/orchestrator/src/services/wizard-creds-token-provider.ts`
  - `packages/orchestrator/src/services/github-auth-health.ts`
  - `packages/orchestrator/src/services/label-monitor-service.ts`
  - `packages/orchestrator/src/services/label-sync-service.ts`
  - `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
  - `packages/orchestrator/src/services/webhook-setup-service.ts`
  - `packages/orchestrator/src/worker/claude-cli-worker.ts`
  - `packages/orchestrator/src/server.ts`
  - `packages/workflow-engine/src/actions/github/client/gh-cli.ts`
