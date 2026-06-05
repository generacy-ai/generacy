# `git-token-proxy` bin — CLI contract

Long-lived process invoked by the cluster-base entrypoint. No subcommands, no flags. Configuration is purely via environment variables. Exits non-zero on bind failure or unrecoverable startup error; otherwise runs until SIGTERM / SIGINT.

## Invocation

```bash
node /shared-packages/node_modules/@generacy-ai/control-plane/dist/bin/git-token-proxy.js
```

Or, if `@generacy-ai/control-plane` is on `$PATH`:

```bash
git-token-proxy
```

No positional arguments. Passing any positional argument is unspecified behavior; the bin currently ignores them but tests do not exercise this and a future version may treat it as an error.

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `GIT_TOKEN_PROXY_SOCKET` | `/run/generacy-git-token/control.sock` | Path where the proxy listens (worker-facing). Parent directory MUST exist (clarification Q1) — proxy does not create it. Set by cluster-base tmpfs mount. |
| `CONTROL_PLANE_SOCKET_PATH` | `/run/generacy-control-plane/control.sock` | Path where the proxy forwards (control-plane upstream). Same env var name as `git-credential-generacy` uses, by design — both bins talk to the same upstream. |

No other env vars are read. The bin does not consume `GENERACY_API_URL`, `GH_TOKEN`, `CREDHELPER_AGENCY_DIR`, etc. — it is a pure transport layer.

## Stdout

Structured JSON, one line per event. Exactly two event types:

```json
{"event":"git-token-proxy-init","listenSocket":"/run/generacy-git-token/control.sock","upstreamSocket":"/run/generacy-control-plane/control.sock"}
```

Emitted once, after the listen socket has been bound and `chmod 0660` applied successfully.

```json
{"event":"git-token-proxy-upstream-error","code":"CONTROL_SOCKET_UNREACHABLE"}
```

Emitted once per failed forward attempt. No body, no headers, no token, no errno detail (the errno is what *makes* the code `CONTROL_SOCKET_UNREACHABLE`; surfacing it would not change the operator action).

**Nothing else** is written to stdout. No banner, no per-request log, no shutdown line, no upstream success log.

## Stderr

Reserved for fatal-init errors. Single line format:

```
git-token-proxy: bind failed: /run/generacy-git-token/control.sock: ENOENT
git-token-proxy: chmod failed: /run/generacy-git-token/control.sock: EPERM
```

Followed by `process.exit(<non-zero>)`. No JSON on stderr — operators search for the literal `git-token-proxy:` prefix.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Process received SIGTERM or SIGINT and shut down cleanly. |
| `1` | Generic startup or shutdown failure (catch-all). |
| Non-zero from `process.exit(1)` after `SHUTDOWN_TIMEOUT_MS` | `server.close()` did not return within 5 s. |

The proxy does not have the fine-grained exit codes that `git-credential-generacy` does (it does not need them — those are oriented at the per-invocation wrapper). A bind failure exits 1.

## Signals

| Signal | Behavior |
|--------|----------|
| `SIGTERM` | `server.close()` → `unlink(listenSocketPath)` → `process.exit(0)`. Bounded by 5 s; if exceeded, `process.exit(1)`. |
| `SIGINT` | Same as `SIGTERM`. Supports interactive Ctrl-C during local dev. |
| (any other) | Default Node behavior (process terminates, no cleanup). |

The proxy intentionally does not handle `SIGHUP` — there is no reload semantics, and we don't want to mask unintended restarts.

## Wire-level guarantees

| Inbound | Outbound (to upstream) | Response (to worker) |
|---------|-----------------------|----------------------|
| `POST /git-token` with `<= 64 KiB` body | `POST /git-token` with `content-type` and recomputed `content-length` only | passthrough of upstream status + body |
| `POST /git-token` with `> 64 KiB` body | — (upstream not contacted) | `413 PAYLOAD_TOO_LARGE` |
| `POST /git-token` but upstream socket missing / refused / reset / timed out | (`http.request` errors / `setTimeout` fires) | `502 CONTROL_SOCKET_UNREACHABLE` |
| any other method on `/git-token` (GET, PUT, DELETE, PATCH, OPTIONS, HEAD) | — (upstream not contacted) | `404` (empty body) |
| any other path (`/credentials/x`, `/lifecycle/y`, `/state`, etc.) | — (upstream not contacted) | `404` (empty body) |
| `/git-token` with trailing slash (`/git-token/`) | — (upstream not contacted) | `404` (empty body) |

## Required filesystem state at startup

| Path | Required state | Owner of lifecycle |
|------|----------------|--------------------|
| `dirname(GIT_TOKEN_PROXY_SOCKET)` | exists; writable by the bin's uid; group-writable for the worker uid's group (typical: `node`) | **cluster-base** (`docker-compose.yml` tmpfs mount + entrypoint chmod) |
| `GIT_TOKEN_PROXY_SOCKET` itself | may or may not exist; if it exists, the bin will `unlink` it | the bin |
| `dirname(CONTROL_PLANE_SOCKET_PATH)` | exists | the control-plane bin (and cluster-base tmpfs mount) |
| `CONTROL_PLANE_SOCKET_PATH` | the control-plane process is bound and accepting | the control-plane bin |

If `dirname(GIT_TOKEN_PROXY_SOCKET)` does not exist, `listen()` fails with `ENOENT` and the bin writes a structured stderr line naming the missing path before exiting 1. This is the *only* way the bin fails to start beyond a code bug.

## Test-only env (none)

The bin exposes no test-mode env vars. The pure-function tests do not need them; the smoke test uses real tmp-dir socket paths via `GIT_TOKEN_PROXY_SOCKET` and `CONTROL_PLANE_SOCKET_PATH`.

## See also

- `git-token-proxy.schema.json` (this directory) — wire contract.
- `packages/control-plane/bin/git-credential-generacy.ts` — sibling bin pattern.
- `specs/766-summary-implement-git/contracts/control-plane-git-token.schema.json` — the upstream route's contract.
