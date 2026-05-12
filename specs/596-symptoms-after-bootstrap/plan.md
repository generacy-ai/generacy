# Implementation Plan: Fix `codeServerReady` Cross-Process Singleton Bug

**Feature**: Orchestrator `/health` always reports `codeServerReady: false` because it queries a local singleton instead of probing the actual unix socket owned by the control-plane process.
**Branch**: `596-symptoms-after-bootstrap`
**Status**: Complete

## Summary

Code-server is started by the control-plane process via the `bootstrap-complete` lifecycle action, but the orchestrator's `/health` endpoint and `relay-bridge.ts` `collectMetadata()` both call `getCodeServerManager()?.getStatus()` — a module-scoped singleton that lives in a different process. The orchestrator's instance is always `'stopped'`.

The fix replaces both callsites with an async unix socket probe (`net.connect`) against `/run/generacy-control-plane/code-server.sock`. A shared helper `probeCodeServerSocket()` is extracted into `packages/orchestrator/src/services/code-server-probe.ts`. The `collectMetadata()` and `sendMetadata()` functions in `relay-bridge.ts` are made async to accommodate the probe.

## Technical Context

**Language/Version**: TypeScript, Node >= 22, ESM
**Primary Dependencies**: `node:net` (socket probe), existing orchestrator/control-plane packages
**Testing**: Vitest (existing test infrastructure)
**Target Platform**: Linux (Docker container)
**Performance Goals**: < 10ms probe latency when code-server is running; < 500ms timeout when not
**Constraints**: Must not block `/health` endpoint; must degrade gracefully (probe failure = `false`)

## Constitution Check

No constitution file found at `.specify/memory/constitution.md`. No gates to enforce.

## Project Structure

### Documentation (this feature)

```text
specs/596-symptoms-after-bootstrap/
├── spec.md              # Feature specification (read-only)
├── clarifications.md    # Clarification Q&A
├── plan.md              # This file
├── research.md          # Technology decisions
├── data-model.md        # Type definitions and interfaces
└── quickstart.md        # Testing and verification guide
```

### Source Code (files to create/modify)

```text
packages/orchestrator/
├── src/
│   ├── routes/
│   │   └── health.ts                    # MODIFY: Replace getCodeServerManager() with probeCodeServerSocket()
│   ├── services/
│   │   ├── code-server-probe.ts         # CREATE: Shared async unix socket probe helper
│   │   └── relay-bridge.ts              # MODIFY: Make collectMetadata()/sendMetadata() async, use probe
│   └── __tests__/
│       └── health-code-server.test.ts   # MODIFY: Update tests for async probe
└── tests/
    └── unit/
        └── services/
            ├── code-server-probe.test.ts    # CREATE: Unit tests for probe helper
            └── relay-bridge-metadata.test.ts # MODIFY: Update for async collectMetadata
```

## Change Inventory

### 1. CREATE `packages/orchestrator/src/services/code-server-probe.ts`

New shared helper exporting:
- `probeCodeServerSocket(socketPath?, timeoutMs?): Promise<boolean>` — Attempts `net.connect()` to the unix socket. Resolves `true` on connect, `false` on error/timeout. Default socket path from `CODE_SERVER_SOCKET_PATH` env or `/run/generacy-control-plane/code-server.sock`. Default timeout 500ms.

### 2. MODIFY `packages/orchestrator/src/routes/health.ts`

- Remove import of `getCodeServerManager` from `@generacy-ai/control-plane`
- Import `probeCodeServerSocket` from `../services/code-server-probe.js`
- Replace line ~87: `const codeServerReady = await probeCodeServerSocket();`
- Handler is already async — no signature change needed

### 3. MODIFY `packages/orchestrator/src/services/relay-bridge.ts`

- Remove import of `getCodeServerManager` from `@generacy-ai/control-plane`
- Import `probeCodeServerSocket` from `./code-server-probe.js`
- Make `collectMetadata()` async: `async collectMetadata(): Promise<ClusterMetadata>`
- Replace line ~501: `codeServerReady: await probeCodeServerSocket()`
- Make `sendMetadata()` async: `async sendMetadata(): Promise<void>`
- Update the `setInterval` callback to handle the async: wrap in `.catch()` to prevent unhandled rejections

### 4. UPDATE existing tests

- `health-code-server.test.ts`: Mock `probeCodeServerSocket` instead of `getCodeServerManager`
- `relay-bridge-metadata.test.ts`: Update for async `collectMetadata()`, mock probe
- New `code-server-probe.test.ts`: Test connect success, ECONNREFUSED, timeout, missing socket

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Probe adds latency to `/health` | Low | Low | < 10ms when running; 500ms timeout only when down |
| `setInterval` + async | Low | Medium | `.catch()` on the interval callback prevents unhandled rejections |
| Socket path mismatch | Low | High | Same `CODE_SERVER_SOCKET_PATH` env / default as existing code |
| Breaking existing tests | Medium | Low | Tests mock at the probe boundary, same shape as before |

## Sequence Diagram

```
bootstrap-complete
    │
    ├─→ control-plane: CodeServerManager.start()
    │       └─→ spawns code-server → binds /run/.../code-server.sock
    │
    ├─→ (later) cloud/relay: GET /health
    │       └─→ orchestrator: probeCodeServerSocket()
    │              └─→ net.connect(/run/.../code-server.sock)
    │                     └─→ connect success → codeServerReady: true
    │
    └─→ (60s interval) relay-bridge: sendMetadata()
            └─→ collectMetadata()
                   └─→ probeCodeServerSocket()
                          └─→ same probe → codeServerReady: true
```
