# Implementation Plan: Fix code-server EACCES on /run/code-server.sock

**Feature**: Change default code-server socket path to reuse control-plane tmpfs mount
**Branch**: `588-symptoms-after-bootstrap`
**Status**: Complete

## Summary

After bootstrap completes, code-server fails to bind `/run/code-server.sock` because `/run/` is root-owned and the process runs as uid 1000 (`node`). The fix changes the default socket path to `/run/generacy-control-plane/code-server.sock` in two files, reusing the existing tmpfs mount that is already writable by uid 1000.

This is a two-line change entirely within the `generacy` repo. No cluster-base image rebuild required.

## Technical Context

- **Language**: TypeScript (ESM)
- **Runtime**: Node.js >= 22
- **Packages affected**: `@generacy-ai/control-plane`, `@generacy-ai/orchestrator`
- **Dependencies**: None added or changed

## Changes

### 1. Update default socket constant

**File**: `packages/control-plane/src/services/code-server-manager.ts` (line 31)

```typescript
// Before
export const DEFAULT_CODE_SERVER_SOCKET = '/run/code-server.sock';

// After
export const DEFAULT_CODE_SERVER_SOCKET = '/run/generacy-control-plane/code-server.sock';
```

This is the authoritative default used by `loadOptionsFromEnv()` when `CODE_SERVER_SOCKET_PATH` is not set.

### 2. Update orchestrator relay-route fallback

**File**: `packages/orchestrator/src/server.ts` (line 635)

```typescript
// Before
const codeServerSocket = process.env['CODE_SERVER_SOCKET_PATH'] ?? '/run/code-server.sock';

// After
const codeServerSocket = process.env['CODE_SERVER_SOCKET_PATH'] ?? '/run/generacy-control-plane/code-server.sock';
```

This is the relay route target for cloud IDE proxy traffic (`/code-server` prefix). Must match the control-plane default so proxy requests reach the actual socket.

## Project Structure (affected files only)

```
packages/
  control-plane/
    src/
      services/
        code-server-manager.ts   <-- FR-001: DEFAULT_CODE_SERVER_SOCKET
  orchestrator/
    src/
      server.ts                  <-- FR-002: relay route fallback
```

## Verification

| Check | Command / Method |
|-------|-----------------|
| Socket exists after boot | `docker exec <orchestrator> ls -la /run/generacy-control-plane/code-server.sock` |
| code-server process running | `docker exec <orchestrator> ps aux \| grep code-server` |
| `codeServerReady` metadata | `/health` endpoint returns `codeServerReady: true` |
| IDE button enables | Dashboard UI — "Open IDE" button activates |

## Risks

- **Low**: Sharing the `/run/generacy-control-plane/` tmpfs between two sockets (control-plane socket + code-server socket). Filenames differ, so no collision risk.
- **None**: `CODE_SERVER_SOCKET_PATH` env var override continues to work (existing behavior preserved).

## Constitution Check

No `.specify/memory/constitution.md` found. No governance constraints to verify.
