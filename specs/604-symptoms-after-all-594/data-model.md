# Data Model: VS Code Tunnel Device Code Race Condition Fix

## Modified Type: `VsCodeTunnelProcessManager`

No new types or interfaces. Two private instance fields added to the existing class.

### New Instance Fields

```typescript
class VsCodeTunnelProcessManager {
  // Existing fields (unchanged)
  private child: ChildProcess | null;
  private status: VsCodeTunnelStatus;
  private exitWaiters: Array<() => void>;
  private deviceCodeTimer: NodeJS.Timeout | null;
  private stdoutBuffer: string[];

  // NEW: Stored for re-emission on idempotent start()
  private deviceCode: string | null = null;
  private verificationUri: string | null = null;
}
```

### Field Lifecycle

| Field | Set When | Cleared When | Used By |
|-------|----------|-------------|---------|
| `deviceCode` | `handleStdoutLine` matches `DEVICE_CODE_PATTERN` | Process exit, spawn error, transition to `connected` | Idempotent `start()` re-emit |
| `verificationUri` | `handleStdoutLine` matches `DEVICE_CODE_PATTERN` (hardcoded `https://github.com/login/device`) | Same as `deviceCode` | Idempotent `start()` re-emit |

### Existing Types (unchanged)

```typescript
// No changes to these — already support deviceCode/verificationUri
interface VsCodeTunnelEvent {
  status: VsCodeTunnelStatus;
  deviceCode?: string;
  verificationUri?: string;
  tunnelName?: string;
  error?: string;
  details?: string;
}

type VsCodeTunnelStatus = 'stopped' | 'starting' | 'authorization_pending' | 'connected' | 'disconnected' | 'error';

interface VsCodeTunnelManager {
  start(): Promise<VsCodeTunnelStartResult>;
  stop(): Promise<void>;
  getStatus(): VsCodeTunnelStatus;
  shutdown(): Promise<void>;
}
```

### Validation Rules

- `deviceCode` is always either `null` or a string matching `/^[A-Z0-9]{4}-[A-Z0-9]{4}$/`
- `verificationUri` is always either `null` or the literal `'https://github.com/login/device'`
- Both fields are `null` whenever `status` is not `authorization_pending`
- No persistence — fields are in-memory only, lost on process restart (by design)

### No Firestore/Storage Changes

Zero new fields persisted. This is explicitly out of scope per SC-003.
