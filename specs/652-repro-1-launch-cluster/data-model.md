# Data Model: Post-Activation Retry

## State Files (Data Volume)

### Post-Activation Completion Flag

```
Path: /var/lib/generacy/post-activation-complete
Type: Empty file (existence = complete)
Writer: entrypoint-post-activation.sh (cluster-base)
Reader: orchestrator PostActivationRetryService
Lifecycle: Created on first successful post-activation, persists across restarts
```

### Existing State Files (unchanged, for context)

```
/var/lib/generacy/cluster-api-key     — Activation API key (exists = activated)
/var/lib/generacy/cluster.json        — Cluster identity metadata
/var/lib/generacy/credentials.dat     — Encrypted credential store
/var/lib/generacy/master.key          — AES-256-GCM master key
/var/lib/generacy/wizard-credentials.env — Transient unsealed credentials
```

## Startup State Matrix

| API Key Exists | Completion Flag Exists | Action |
|:-:|:-:|---|
| No | No | First boot — arm watcher, wait for wizard (unchanged) |
| No | No | First boot — arm watcher, wait for wizard (unchanged) |
| Yes | Yes | Normal restart — skip post-activation (unchanged) |
| Yes | No | **Retry** — replay bootstrap-complete lifecycle action |

## TypeScript Interfaces

### PostActivationState (new)

```typescript
interface PostActivationState {
  activated: boolean;        // API key file exists
  postActivationComplete: boolean; // Completion flag exists
  needsRetry: boolean;       // activated && !postActivationComplete
}
```

### PostActivationRetryOptions (new)

```typescript
interface PostActivationRetryOptions {
  /** Path to the completion flag file */
  completionFlagPath?: string; // default: /var/lib/generacy/post-activation-complete
  /** Path to the API key file (to check activation status) */
  keyFilePath?: string;        // default: /var/lib/generacy/cluster-api-key
  /** Control-plane Unix socket path */
  controlPlaneSocket?: string; // default: /run/generacy-control-plane/control.sock
  /** Max seconds to wait for control-plane socket */
  controlPlaneWaitTimeout?: number; // default: 15
  /** Logger instance */
  logger: FastifyBaseLogger;
}
```

### Relay Event Payloads

```typescript
// channel: 'cluster.bootstrap'
// Emitted on retry trigger
interface PostActivationRetryEvent {
  status: 'retrying';
  reason: 'post-activation-incomplete';
  attempt: 'restart';
}

// Emitted on retry failure
interface PostActivationRetryFailureEvent {
  status: 'failed';
  reason: string;      // e.g., 'lifecycle-action-failed', 'control-plane-unreachable'
  error?: string;      // error message
}

// Emitted on retry success (by existing watcher flow)
// Already handled by cluster-base writing the completion flag
```

### Status Transitions

```
bootstrapping → ready       (normal first-boot or successful retry)
bootstrapping → degraded    (retry failure: post-activation-retry-failed)
ready ↔ degraded            (existing transitions)
```

The retry pushes `degraded` status with `statusReason: 'post-activation failed on restart: <detail>'` via the existing `StatusReporter` class.
