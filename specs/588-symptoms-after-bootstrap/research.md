# Research: code-server socket EACCES fix

## Options Considered

### Option A: Reuse control-plane tmpfs (chosen)

Change default socket path to `/run/generacy-control-plane/code-server.sock`.

- **Pros**: Zero infrastructure changes, two-line code fix, no image rebuild, reuses existing writable mount
- **Cons**: Two services share one tmpfs directory (acceptable — different filenames)

### Option B: Dedicated `/run/code-server/` tmpfs mount

Add a new tmpfs volume in `docker-compose.yml` for code-server.

- **Pros**: Clean separation of concerns
- **Cons**: Requires cluster-base image change, compose file update, wider blast radius

### Option C: Use `/tmp` for socket

Change socket path to `/tmp/code-server.sock`.

- **Pros**: `/tmp` is world-writable, always available
- **Cons**: `/tmp` is not tmpfs in all container runtimes, larger blast radius, less predictable

## Decision

Option A selected. The `/run/generacy-control-plane/` tmpfs mount is already created by docker-compose for the control-plane socket. Both code-server and control-plane run as uid 1000. Socket filenames are distinct (`control.sock` vs `code-server.sock`), so no collision risk.

## Key Implementation Details

- `DEFAULT_CODE_SERVER_SOCKET` constant in `code-server-manager.ts` is used by `loadOptionsFromEnv()` when `CODE_SERVER_SOCKET_PATH` env var is not set
- The orchestrator's `initializeRelayBridge()` has an independent fallback for the same env var — both must be updated to stay in sync
- The `CODE_SERVER_SOCKET_PATH` env var override remains the canonical way to customize the path

## References

- #586 / #587: Added relay route + `codeServerReady` metadata producer
- cluster-base#24: Canonical pattern for tmpfs-mounted sockets in compose
