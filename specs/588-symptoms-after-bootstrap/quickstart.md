# Quickstart: Verify #588 Fix

## What Changed

Default code-server socket path moved from `/run/code-server.sock` to `/run/generacy-control-plane/code-server.sock` in two files.

## Verification Steps

1. Build and start the cluster:
   ```bash
   pnpm install
   pnpm build
   # Start dev stack or docker compose
   ```

2. Complete bootstrap wizard in the dashboard

3. Verify code-server started:
   ```bash
   docker exec <orchestrator> ls -la /run/generacy-control-plane/code-server.sock
   docker exec <orchestrator> ps aux | grep code-server
   ```

4. Check metadata:
   ```bash
   curl http://localhost:<port>/health | jq .codeServerReady
   # Should return: true
   ```

5. Click "Open IDE" in the dashboard — should load code-server

## Override

To use a custom socket path, set `CODE_SERVER_SOCKET_PATH` env var in the container. Both the control-plane and orchestrator relay route will respect it.
