# Quickstart: Credential Audit Log

**Feature**: #499 — Audit log writer in credhelper-daemon

## Overview

The audit log captures every credential operation in the cluster and forwards batches to the cloud via the relay's `cluster.audit` event channel.

## Architecture

```
credhelper-daemon                    control-plane                 cloud
┌─────────────────┐                 ┌──────────────┐          ┌──────────┐
│  SessionManager  │                │              │          │          │
│  ExposureRenderer│──record()──►   │              │          │          │
│  DockerProxy     │            │   │              │          │          │
│  Plugins         │            │   │              │          │          │
└─────────────────┘            │   │              │          │          │
                                ▼   │              │          │          │
                         ┌──────────┐   HTTP POST   │  relay    │          │
                         │ AuditLog │──────────────►│  audit  ──►│ cluster  │
                         │ RingBuf  │  /internal/   │  batch    │ .audit   │
                         │ (5000)   │  audit-batch  │  channel  │          │
                         └──────────┘              └──────────┘          └──────────┘
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GENERACY_CLUSTER_ID` | Cluster identity stamped on entries | (required) |
| `GENERACY_WORKER_ID` | Worker identity (usually `$HOSTNAME`) | (required) |
| `CONTROL_PLANE_SOCKET_PATH` | Control-plane Unix socket | `/run/generacy-control-plane/control.sock` |

### Role Config (audit sampling)

In `.agency/roles/<role>.yaml`:

```yaml
schemaVersion: '1'
id: my-role
description: Example role
credentials:
  - ref: my-cred
    expose:
      - as: env
audit:
  recordAllProxy: true  # Record 100% of proxy requests (default: 1/100 sampling)
```

## API Reference

### AuditLog

```typescript
import { AuditLog } from './audit/index.js';

const auditLog = new AuditLog({
  capacity: 5000,
  flushIntervalMs: 1000,
  maxBatchSize: 50,
  controlPlaneSocketPath: '/run/generacy-control-plane/control.sock',
  clusterId: process.env['GENERACY_CLUSTER_ID'] ?? '',
  workerId: process.env['GENERACY_WORKER_ID'] ?? '',
});

// Start periodic flushing
auditLog.start();

// Record an event
auditLog.record({
  action: 'credential.mint',
  credentialId: 'github-token',
  sessionId: 'sess-123',
  role: 'dev-worker',
  pluginId: 'github-app',
  success: true,
});

// Stop and flush remaining
await auditLog.stop();
```

### Control-Plane Endpoint

```
POST /internal/audit-batch
Content-Type: application/json

{
  "entries": [
    {
      "timestamp": "2026-04-29T12:00:00.000Z",
      "action": "credential.mint",
      "actor": { "workerId": "worker-abc", "sessionId": "sess-123" },
      "clusterId": "cluster-xyz",
      "credentialId": "github-token",
      "role": "dev-worker",
      "pluginId": "github-app",
      "success": true
    }
  ],
  "droppedSinceLastBatch": 0
}

Response: 200 OK
```

## Testing

### Unit Tests

```bash
# Run audit module tests
pnpm --filter @generacy-ai/credhelper-daemon test -- --grep audit

# Run ring buffer tests specifically
pnpm --filter @generacy-ai/credhelper-daemon test -- src/audit/ring-buffer.test.ts
```

### Integration Test: Bounded Memory Under Pressure

```bash
# Runs 10000 rapid mints with control-plane offline
pnpm --filter @generacy-ai/credhelper-daemon test -- tests/integration/audit-pressure.test.ts
```

Expected: Ring buffer stays at capacity 5000, `droppedSinceLastBatch > 0` in batch payload, no OOM.

### Dev-Mode Assertion

Any audit entry field exceeding 256 characters triggers an assertion failure in test/dev mode. This catches accidental credential value logging:

```bash
# Verify assertion catches long fields
pnpm --filter @generacy-ai/credhelper-daemon test -- src/audit/field-length.test.ts
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No audit entries in cloud | Control-plane socket unavailable | Check `CONTROL_PLANE_SOCKET_PATH`, verify control-plane is running |
| `droppedSinceLastBatch` consistently > 0 | Audit volume exceeds flush rate | Normal under heavy load; consider `recordAllProxy: false` |
| Assertion failure on field length | A field > 256 chars was added | Check for credential values leaking into audit entry fields |
| Missing `clusterId` on entries | `GENERACY_CLUSTER_ID` not set | Ensure orchestrator passes env var at daemon spawn |
