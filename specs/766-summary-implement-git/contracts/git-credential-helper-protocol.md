# Contract: git credential-helper line protocol (CLI wrapper)

**Binary**: `git-credential-generacy` — shipped from `packages/control-plane` as a bin entry; installed at `/usr/local/bin/git-credential-generacy` by cluster-base (companion PR #61).

**Spec reference**: <https://git-scm.com/docs/git-credential#IOFMT>.

This document is the contract between **git** (invoker) and **the wrapper** (invokee). The cloud and control-socket interactions are covered by the JSON-Schema contracts in this directory; this file covers only the line protocol git itself speaks.

## How git invokes the wrapper

Cluster-base companion PR configures:

```bash
git config --global credential.https://github.com.helper /usr/local/bin/git-credential-generacy
```

Git then invokes the wrapper as:

```
/usr/local/bin/git-credential-generacy <action>
```

…where `<action>` is one of `get`, `store`, or `erase`. Stdin carries `key=value\n` lines from git terminated by a blank line; stdout/stderr go back to git.

## Inputs (stdin, all actions)

A stream of `key=value` lines terminated by an empty line:

```
protocol=https
host=github.com
path=owner/repo.git
<blank line>
```

The wrapper:

- Reads stdin to EOF (or to the terminating blank line).
- Captures `protocol` and `host` for both validation and echo.
- Ignores `path` and any unknown keys.

If `host` is not `github.com` (defensive — the per-host `credential.https://github.com.helper` config should already prevent this), the wrapper exits 0 with no credential output. Git then falls through to whatever other helper is configured for that host (or no auth).

## `get` action — outputs (stdout) on success

```
protocol=https
host=github.com
username=x-access-token
password=ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
<blank line>
```

**Rules**:

- The input `protocol` and `host` lines are echoed back verbatim. (Standard custom-helper behavior — git uses the response to update its session credentials, not just the username/password.)
- `username` is always the literal string `x-access-token` (FR-012, clarification Q5).
- `password` is the token returned by `POST /git-token` on the control socket.
- Output is followed by a blank line. **No trailing logs to stdout** — anything stdout-bound that is not a protocol line corrupts git.

**Exit code on success**: 0.

## `get` action — outputs on failure (FR-008, SC-005)

When `POST /git-token` returns a non-2xx response (or the control socket is unreachable), the wrapper:

1. Writes a single human-readable line to **stderr**:
   ```
   generacy-git-helper: <code>: <message>
   ```
   …where `<code>` is the upstream `code` field (see `control-plane-git-token.schema.json`) or `CONTROL_SOCKET_UNREACHABLE` when the socket connect itself fails.
2. Writes nothing to stdout.
3. Exits with a non-zero exit code (see table below).

Git surfaces this as `fatal: Authentication failed for 'https://github.com/...'` with the wrapper's stderr line visible above it in the terminal — a clean, greppable failure rather than a hang.

### Exit code map

| Wrapper exit | Stderr `<code>` | Trigger |
|--------------|-----------------|---------|
| 0 | — | success, or non-github host (no credential returned) |
| 2 | `CONTROL_SOCKET_UNREACHABLE` | `connect()` to `/run/generacy-control-plane/control.sock` failed |
| 3 | `CLUSTER_API_KEY_MISSING` | control-plane reports key file missing (pre-activation) |
| 4 | `CLOUD_UNREACHABLE` | cloud transport error |
| 5 | `CLOUD_AUTH_REJECTED` | cloud 401/403 |
| 6 | `CLOUD_REQUEST_INVALID` | cloud 4xx (other) |
| 7 | `CLOUD_UPSTREAM_ERROR` | cloud 5xx |
| 8 | `CLOUD_RESPONSE_INVALID` | cloud responded 2xx with malformed body |
| 9 | `CREDENTIAL_NOT_CONFIGURED` | no matching credential in `.agency/credentials.yaml` |
| 1 | `INTERNAL_ERROR` | unrecognized failure (defensive — should not occur) |

Git itself does not interpret the exit code — it treats any non-zero as "helper failed, try next." But distinct codes let operators see what failed (e.g., from `set -x`, CI logs, `journalctl`).

## `store` action

Input: same line-format as `get`, plus `username` and `password` lines from git.

Wrapper behavior: read stdin to EOF, **discard everything**, exit 0. Tokens are minted on demand and never persisted, so there is nothing to store.

## `erase` action

Input: same line-format as `get`.

Wrapper behavior: read stdin to EOF, **discard everything**, exit 0. The in-memory cache is intentionally not flushed on `erase` — git `erase` is typically called after a 401, but our 401 path is "cloud refused our cluster API key," not "the cached token is bad." A pre-expiry refresh on the next `get` already handles legitimate token rotation.

## What the wrapper does NOT do

- **No on-disk credential read**: the wrapper does not read `~/.git-credentials`, `~/.netrc`, `process.env.GH_TOKEN`, or any other static token surface (SC-002). Its only credential source is `POST /git-token`.
- **No retries on transport failure**: a single failed POST to the control socket → exit non-zero. Retries would hide the failure mode and slow down `git fetch` more than they help (FR-008 loud-failure ethos).
- **No logging to stdout**: logs go to stderr only, and only on error. Stdout is exclusively the credential protocol output.
- **No caching across invocations**: git spawns the wrapper per request; the wrapper is stateless. Caching lives in the long-lived control-plane process (Q2).
- **No interpretation of the `password` value**: the wrapper does not parse or modify the token; it copies it verbatim from the JSON `token` field to the `password=` line.

## Examples

### Successful `get`

```bash
$ printf 'protocol=https\nhost=github.com\n\n' | git-credential-generacy get
protocol=https
host=github.com
username=x-access-token
password=ghs_examplexxxxxxxxxxxxxxxxxxxxxxxxxx

$ echo $?
0
```

### Cloud unreachable

```bash
$ printf 'protocol=https\nhost=github.com\n\n' | git-credential-generacy get
$ echo $?
4
# stderr printed:
# generacy-git-helper: CLOUD_UNREACHABLE: cloud pull endpoint not reachable (ECONNREFUSED)
```

### Non-github host (defensive bypass)

```bash
$ printf 'protocol=https\nhost=gitlab.com\n\n' | git-credential-generacy get
$ echo $?
0
# no stdout output — git falls through to other helpers / no credential.
```

### `store` and `erase` are no-ops

```bash
$ printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs_xxx\n\n' | git-credential-generacy store
$ echo $?
0
$ printf 'protocol=https\nhost=github.com\n\n' | git-credential-generacy erase
$ echo $?
0
```

## Integration test plan (informative — does not block contract)

- End-to-end test in `__tests__/bin/git-credential-generacy.test.ts` spins up a fake HTTP server on a temporary Unix socket, sets `CONTROL_PLANE_SOCKET_PATH` to that socket, spawns the wrapper binary, and asserts the line-protocol outputs match the cases in this document.
