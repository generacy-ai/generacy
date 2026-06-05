# Quickstart: Worker-side git-token proxy bin

This doc covers how to build, run, and validate the proxy locally and inside a Generacy cluster. Assumes the companion cluster-base PR has been applied (or that you're running the bin by hand). The proxy is a small Node binary; there is no separate install step beyond `pnpm install` in this repo.

## Prerequisites

- Node.js >=20.
- pnpm.
- For the smoke test and the in-cluster validation steps: a POSIX shell, the ability to bind a Unix socket (Linux / macOS).
- For the in-cluster validation: a booted Generacy cluster (`pnpm dev` + Firebase emulators, or a deployed cluster). Control-plane process must be running.

## Build

From the repo root:

```bash
pnpm -F @generacy-ai/control-plane build
```

This produces:

- `packages/control-plane/dist/bin/control-plane.js` (existing)
- `packages/control-plane/dist/bin/git-credential-generacy.js` (existing, from #766)
- `packages/control-plane/dist/bin/git-token-proxy.js` (NEW, from this issue)

## Run tests

```bash
pnpm -F @generacy-ai/control-plane test
```

The new tests live under `packages/control-plane/__tests__/bin/git-token-proxy/`:

- `handler.test.ts` — pure-function tests covering the route allow-list, header allow-list, body cap, and upstream-error mapping in the handler.
- `allowlists.test.ts` — exhaustive `isAllowedRoute` and `pickAllowedHeaders` cases.
- `upstream-errors.test.ts` — every transport-failure shape maps to `CONTROL_SOCKET_UNREACHABLE`.
- `lifecycle.smoke.test.ts` — real Unix-socket smoke test (bind, `0660` mode, wire-level single-route enforcement, SIGTERM cleanup). Skipped automatically on non-POSIX.

## Run the bin locally (out-of-cluster)

The proxy expects two Unix-socket paths it can bind / connect. Easiest way to drive it locally is two tmp paths plus a tiny upstream stub.

### 1. Start a fake upstream

In one terminal:

```bash
node --eval '
  const http = require("http");
  const path = "/tmp/upstream.sock";
  require("fs").rmSync(path, { force: true });
  http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/git-token") {
      let buf = "";
      req.on("data", c => buf += c);
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "ghs_fake", expiresAt: "2026-06-05T17:00:00.000Z" }));
      });
    } else {
      res.writeHead(404).end();
    }
  }).listen({ path }, () => console.log("fake upstream on", path));
'
```

### 2. Start the proxy pointing at it

In another terminal:

```bash
mkdir -p /tmp/proxy-run
CONTROL_PLANE_SOCKET_PATH=/tmp/upstream.sock \
GIT_TOKEN_PROXY_SOCKET=/tmp/proxy-run/control.sock \
node packages/control-plane/dist/bin/git-token-proxy.js
```

Expected stdout:

```json
{"event":"git-token-proxy-init","listenSocket":"/tmp/proxy-run/control.sock","upstreamSocket":"/tmp/upstream.sock"}
```

### 3. Send the allowed request

```bash
curl -sS --unix-socket /tmp/proxy-run/control.sock \
     -X POST -H 'content-type: application/json' \
     --data '{}' \
     http://_/git-token
# → {"token":"ghs_fake","expiresAt":"2026-06-05T17:00:00.000Z"}
```

### 4. Confirm the allow-list rejects everything else

```bash
# Wrong method on the allowed path
curl -sS --unix-socket /tmp/proxy-run/control.sock -i http://_/git-token
# → HTTP/1.1 404 Not Found, empty body

# Wrong path
curl -sS --unix-socket /tmp/proxy-run/control.sock -i \
     -X POST -H 'content-type: application/json' \
     --data '{}' http://_/credentials/foo
# → HTTP/1.1 404 Not Found, empty body

# Trailing slash variant
curl -sS --unix-socket /tmp/proxy-run/control.sock -i \
     -X POST -H 'content-type: application/json' \
     --data '{}' http://_/git-token/
# → HTTP/1.1 404 Not Found, empty body
```

The proxy's stdout shows no log entries for these — they are silent rejections (clarification Q3: no per-request log).

### 5. Confirm the body cap

```bash
# Compose a 65 KiB JSON body (just above the 64 KiB limit)
node --eval 'process.stdout.write("{\"x\":\"" + "a".repeat(66*1024) + "\"}")' > /tmp/big.json

curl -sS --unix-socket /tmp/proxy-run/control.sock -i \
     -X POST -H 'content-type: application/json' \
     --data @/tmp/big.json http://_/git-token
# → HTTP/1.1 413 Payload Too Large
# → {"error":"request body exceeds 64 KiB","code":"PAYLOAD_TOO_LARGE"}
```

### 6. Confirm the upstream-unreachable failure mode

Stop the fake upstream (Ctrl-C in its terminal). Then re-run the success curl:

```bash
curl -sS --unix-socket /tmp/proxy-run/control.sock -i \
     -X POST -H 'content-type: application/json' \
     --data '{}' http://_/git-token
# → HTTP/1.1 502 Bad Gateway
# → {"error":"control-plane upstream unreachable","code":"CONTROL_SOCKET_UNREACHABLE"}
```

Proxy stdout shows exactly one new line per attempt:

```json
{"event":"git-token-proxy-upstream-error","code":"CONTROL_SOCKET_UNREACHABLE"}
```

### 7. Confirm shutdown cleans up the socket file

In the proxy's terminal, press Ctrl-C. Then:

```bash
ls -la /tmp/proxy-run/control.sock
# → ls: cannot access ...: No such file or directory
```

## Validate inside a cluster

Once the companion cluster-base PR is applied:

```bash
# inside the orchestrator container
ls -la /run/generacy-git-token/control.sock
# → srw-rw---- 1 node node 0 ... control.sock   (0660 mode)

# from a worker container
curl -sS --unix-socket /run/generacy-git-token/control.sock \
     -X POST -H 'content-type: application/json' \
     --data '{}' http://_/git-token | jq
# → {"token":"ghs_...","expiresAt":"..."}
```

The presence of the listen socket (with `0660` mode and `node:node` ownership) is the SC for FR §Scope's "listen-socket perms `0660`".

## Available commands and endpoints

### CLI

| Command | Behavior |
|---------|----------|
| `git-token-proxy` (no args) | Run as a long-lived process. Binds the listen socket, forwards `POST /git-token` to the upstream control-plane socket, 404s everything else, exits cleanly on SIGTERM/SIGINT. |

### Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `GIT_TOKEN_PROXY_SOCKET` | `/run/generacy-git-token/control.sock` | Where the proxy listens. |
| `CONTROL_PLANE_SOCKET_PATH` | `/run/generacy-control-plane/control.sock` | Where the proxy forwards. |

### Wire

| Method | Path | Behavior |
|--------|------|----------|
| `POST` | `/git-token` | Forward to upstream `/git-token`. Returns whatever upstream returned. |
| `*` | `*` | `404 Not Found`, empty body. |

## Troubleshooting

### `git-token-proxy: bind failed: /run/generacy-git-token/control.sock: ENOENT`

The parent directory `/run/generacy-git-token/` does not exist. This is a cluster-base concern: the entrypoint should be mounting a tmpfs there with `node:node` ownership and `2770` mode. Fix by:

```bash
sudo install -d -o node -g node -m 2770 /run/generacy-git-token
```

Then restart the proxy. The bin will refuse to create the directory itself (clarification Q1).

### `git-token-proxy: bind failed: /run/generacy-git-token/control.sock: EADDRINUSE`

Another process holds the socket. Find it:

```bash
sudo fuser /run/generacy-git-token/control.sock
# or
sudo lsof | grep generacy-git-token
```

Kill the prior process (or wait for `systemd`/Docker to take it down) and restart. The bin's startup will then `unlink` the stale node and rebind.

### Worker sees `Connection refused` instead of any HTTP response

The proxy is not running. Check:

```bash
ls -la /run/generacy-git-token/control.sock
ps auxf | grep git-token-proxy
```

If the proxy is up but the worker still can't connect, check socket permissions: the worker uid must be a member of the socket's group. Default is `node:node` with mode `0660`.

### Worker gets `404` on a `POST /git-token` request

The proxy is up but the route allow-list rejected the request. Confirm method and path:

```bash
# Was it actually a POST?
curl -sS --unix-socket /run/generacy-git-token/control.sock -i \
     -X POST -H 'content-type: application/json' --data '{}' \
     http://_/git-token
```

If the same curl returns `404` from the proxy but the upstream control-plane works directly:

```bash
curl -sS --unix-socket /run/generacy-control-plane/control.sock -i \
     -X POST -H 'content-type: application/json' --data '{}' \
     http://_/git-token
```

…then your client is hitting the proxy with the wrong method or path. The proxy is **stricter than the control socket**: it only forwards `POST /git-token` exact-match.

### Worker gets `413 PAYLOAD_TOO_LARGE`

Your request body exceeds 64 KiB. This should never happen for the standard `{ "credentialId": "..." }` payload; it indicates either a client bug or a hostile worker. Inspect the client; if it's legitimate, file an issue against this spec — the bound is intentionally low.

### Worker gets `502 CONTROL_SOCKET_UNREACHABLE`

The proxy could not reach the upstream control-plane. The structured log on stdout will show `event=git-token-proxy-upstream-error code=CONTROL_SOCKET_UNREACHABLE` for each failed attempt. Check:

```bash
ls -la /run/generacy-control-plane/control.sock
# is control-plane up?
curl -sS --unix-socket /run/generacy-control-plane/control.sock -X POST \
     -H 'content-type: application/json' --data '{}' \
     http://_/git-token -i
```

If the direct call works but the proxy still 502s: check that `CONTROL_PLANE_SOCKET_PATH` env var in the proxy's process matches the actual upstream path.

If both fail: control-plane itself is the problem. See the `git-token-init` and `store-init` log lines from the control-plane process — likely an upstream initialization issue (cluster-api-key missing, cloud unreachable, etc., per #766 troubleshooting).

### Tokens appearing in proxy logs

This is a bug. Tokens MUST NEVER appear in proxy logs. File an issue.

## Rollback

If the new bin misbehaves and the companion cluster-base PR has shipped:

1. Revert the cluster-base entrypoint change so the old `.devcontainer/generacy/scripts/git-token-proxy.js` is launched again.
2. (Optional) Stop the new bin in any running container: `pkill -f dist/bin/git-token-proxy.js`.
3. The new bin can ship in `@generacy-ai/control-plane` without being launched. There is no risk to leaving the bin in place while reverting only the launch wiring.

## See also

- [spec.md](./spec.md) — feature specification.
- [plan.md](./plan.md) — implementation plan and file layout.
- [research.md](./research.md) — technology decisions.
- [data-model.md](./data-model.md) — types, constants, validation rules.
- [contracts/](./contracts) — wire contract and CLI contract.
- `specs/766-summary-implement-git/` — the JIT credential helper this proxy completes.
