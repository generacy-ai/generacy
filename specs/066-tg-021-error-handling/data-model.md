# Data Model: Error Handling & UX Polish

**Feature**: Error Handling & UX Polish
**Date**: 2026-01-22

## Core Entities

### 1. Enhanced Error Model

```typescript
/**
 * Extended error information with recovery actions
 */
interface EnhancedError {
  /** Error code for categorization */
  code: ErrorCode;

  /** User-facing message following What-Why-How pattern */
  message: string;

  /** Detailed technical information for debugging */
  details?: {
    /** Context about where/when the error occurred */
    context?: Record<string, unknown>;

    /** Stack trace (for development) */
    stack?: string;

    /** Related file paths, line numbers, etc */
    location?: {
      file?: string;
      line?: number;
      column?: number;
    };
  };

  /** Recovery actions available to the user */
  actions?: ErrorAction[];

  /** Original error that caused this (if wrapped) */
  cause?: Error;

  /** Severity level */
  severity: ErrorSeverity;
}

/**
 * User action that can resolve or investigate an error
 */
interface ErrorAction {
  /** Button label shown to user */
  label: string;

  /** Action handler */
  action: () => void | Promise<void>;

  /** Whether this action is the primary/suggested action */
  primary?: boolean;
}

/**
 * Error severity levels
 */
enum ErrorSeverity {
  /** Informational - user should be aware but no action needed */
  Info = 'info',

  /** Warning - user should take action but operation can continue */
  Warning = 'warning',

  /** Error - operation failed, user must take action */
  Error = 'error',

  /** Critical - system-level failure, may require restart */
  Critical = 'critical'
}
```

---

### 2. Network State Model

```typescript
/**
 * Network connectivity state
 */
interface NetworkState {
  /** Whether device has network connectivity */
  isOnline: boolean;

  /** Last successful connection timestamp */
  lastOnlineAt?: number;

  /** Current connection type (if detectable) */
  connectionType?: 'wifi' | 'ethernet' | 'cellular' | 'unknown';

  /** Whether API is reachable */
  apiReachable: boolean;

  /** Last API health check timestamp */
  lastHealthCheck?: number;
}

/**
 * Network state change event
 */
interface NetworkStateChange {
  /** Previous state */
  previous: NetworkState;

  /** Current state */
  current: NetworkState;

  /** Timestamp of change */
  timestamp: number;
}

/**
 * Offline queue item
 */
interface QueuedRequest {
  /** Unique request ID */
  id: string;

  /** API endpoint */
  endpoint: string;

  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

  /** Request body (if any) */
  body?: unknown;

  /** Request headers */
  headers?: Record<string, string>;

  /** Timestamp when queued */
  queuedAt: number;

  /** Number of retry attempts */
  attempts: number;

  /** Maximum retry attempts */
  maxAttempts: number;

  /** Next retry timestamp */
  nextRetryAt?: number;
}
```

---

### 3. Cache Model

```typescript
/**
 * Cached data entry
 */
interface CachedData<T = unknown> {
  /** Cache key */
  key: string;

  /** Cached data */
  data: T;

  /** Timestamp when cached */
  cachedAt: number;

  /** Time-to-live in milliseconds */
  ttl: number;

  /** Optional metadata */
  metadata?: {
    /** API endpoint that provided this data */
    source?: string;

    /** ETag or version for cache validation */
    version?: string;
  };
}

/**
 * Cache entry status
 */
interface CacheStatus {
  /** Whether data exists in cache */
  exists: boolean;

  /** Whether cached data is still valid */
  valid: boolean;

  /** Age of cached data in milliseconds */
  age?: number;

  /** Time until expiration in milliseconds */
  expiresIn?: number;
}
```

---

### 4. Progress Model

```typescript
/**
 * Progress state for long-running operations
 */
interface ProgressState {
  /** Unique operation ID */
  id: string;

  /** Operation title */
  title: string;

  /** Current status message */
  message?: string;

  /** Progress percentage (0-100) */
  percentage?: number;

  /** Whether operation can be cancelled */
  cancellable: boolean;

  /** Cancellation token */
  cancellationToken?: vscode.CancellationToken;

  /** Start time */
  startedAt: number;

  /** Estimated time remaining (milliseconds) */
  estimatedTimeRemaining?: number;
}

/**
 * Progress location preference
 */
enum ProgressLocation {
  /** Show in notification area */
  Notification = 'notification',

  /** Show in status bar */
  StatusBar = 'statusBar',

  /** Show in window (blocking) */
  Window = 'window'
}

/**
 * Progress report event
 */
interface ProgressReport {
  /** Incremental progress (0-100) */
  increment?: number;

  /** Updated message */
  message?: string;

  /** Total work done */
  workDone?: number;

  /** Total work to do */
  totalWork?: number;
}
```

---

### 5. Walkthrough Model

```typescript
/**
 * Walkthrough step state
 */
interface WalkthroughStep {
  /** Step identifier */
  id: string;

  /** Step title */
  title: string;

  /** Step description (markdown) */
  description: string;

  /** Media to display */
  media?: {
    /** Image path or video URL */
    path: string;

    /** Alt text for accessibility */
    altText?: string;
  };

  /** Events that complete this step */
  completionEvents?: string[];

  /** Whether step is completed */
  completed: boolean;

  /** Timestamp of completion */
  completedAt?: number;
}

/**
 * Walkthrough progress
 */
interface WalkthroughProgress {
  /** Walkthrough ID */
  walkthroughId: string;

  /** Total steps */
  totalSteps: number;

  /** Completed steps */
  completedSteps: number;

  /** Current step index */
  currentStep: number;

  /** Whether walkthrough is dismissed */
  dismissed: boolean;

  /** Last viewed timestamp */
  lastViewedAt?: number;
}

/**
 * Walkthrough state (persisted)
 */
interface WalkthroughState {
  /** Whether user has seen the walkthrough */
  hasSeenWalkthrough: boolean;

  /** Progress for each walkthrough */
  progress: Record<string, WalkthroughProgress>;

  /** Whether to show walkthrough on next activation */
  showOnNextActivation: boolean;
}
```

---

### 6. Keyboard Shortcut Model

```typescript
/**
 * Keyboard shortcut configuration
 */
interface ShortcutConfig {
  /** Command identifier */
  command: string;

  /** Keybinding (VS Code format) */
  key: string;

  /** Mac-specific keybinding */
  mac?: string;

  /** When clause (context) */
  when?: string;

  /** Description shown in keyboard shortcuts UI */
  description: string;
}

/**
 * Shortcut execution context
 */
interface ShortcutContext {
  /** Active editor */
  editor?: vscode.TextEditor;

  /** Active workflow (if applicable) */
  workflow?: Workflow;

  /** Tree view focus */
  treeViewFocus?: 'explorer' | 'queue' | 'integrations';

  /** Authenticated user */
  user?: User;
}
```

---

### 7. Notification Model

```typescript
/**
 * Smart notification with rate limiting
 */
interface SmartNotification {
  /** Notification ID (for deduplication) */
  id: string;

  /** Message to display */
  message: string;

  /** Notification type */
  type: 'info' | 'warning' | 'error';

  /** Actions to show */
  actions?: NotificationAction[];

  /** Whether to show as modal */
  modal?: boolean;

  /** Rate limit configuration */
  rateLimit?: {
    /** Maximum notifications per time window */
    maxCount: number;

    /** Time window in milliseconds */
    windowMs: number;
  };

  /** Last shown timestamp */
  lastShownAt?: number;

  /** Show count in current window */
  showCount?: number;
}

/**
 * Notification action button
 */
interface NotificationAction {
  /** Button label */
  label: string;

  /** Action handler */
  action: () => void | Promise<void>;

  /** Whether this closes the notification */
  dismisses?: boolean;
}

/**
 * Notification manager state
 */
interface NotificationManagerState {
  /** Active notifications by ID */
  active: Map<string, SmartNotification>;

  /** Notification show history (for rate limiting) */
  history: Array<{
    id: string;
    timestamp: number;
  }>;

  /** User preferences */
  preferences: {
    /** Whether notifications are enabled */
    enabled: boolean;

    /** Minimum severity to show */
    minSeverity: ErrorSeverity;

    /** Whether to show in Do Not Disturb mode */
    showInDND: boolean;
  };
}
```

---

## Type Definitions

### Retry Configuration

```typescript
/**
 * Configuration for retry logic
 */
interface RetryConfig {
  /** Maximum retry attempts */
  maxAttempts: number;

  /** Initial delay in milliseconds */
  initialDelay: number;

  /** Maximum delay in milliseconds */
  maxDelay: number;

  /** Backoff multiplier */
  backoffMultiplier: number;

  /** Whether to add jitter */
  addJitter: boolean;

  /** Jitter factor (0-1) */
  jitterFactor?: number;

  /** Retry predicate - return true to retry */
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

/**
 * Default retry configurations
 */
const RETRY_CONFIGS: Record<string, RetryConfig> = {
  api: {
    maxAttempts: 5,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    addJitter: true,
    jitterFactor: 0.25
  },
  fileSystem: {
    maxAttempts: 3,
    initialDelay: 500,
    maxDelay: 5000,
    backoffMultiplier: 2,
    addJitter: false
  },
  validation: {
    maxAttempts: 1, // No retry for validation errors
    initialDelay: 0,
    maxDelay: 0,
    backoffMultiplier: 1,
    addJitter: false
  }
};
```

---

### Loading State

```typescript
/**
 * Loading state for UI components
 */
interface LoadingState<T = unknown> {
  /** Whether currently loading */
  loading: boolean;

  /** Loaded data (if available) */
  data?: T;

  /** Error (if load failed) */
  error?: EnhancedError;

  /** Last successful load timestamp */
  lastLoadedAt?: number;

  /** Whether data is stale (offline mode) */
  stale: boolean;
}

/**
 * Loading state with refresh capability
 */
interface RefreshableLoadingState<T = unknown> extends LoadingState<T> {
  /** Refresh the data */
  refresh: () => Promise<void>;

  /** Whether currently refreshing */
  refreshing: boolean;
}
```

---

## Validation Rules

### Error Message Validation

```typescript
/**
 * Validate error message follows What-Why-How pattern
 */
function validateErrorMessage(message: string): boolean {
  // Must have at least 20 characters
  if (message.length < 20) return false;

  // Should contain actionable language
  const actionableKeywords = [
    'check', 'try', 'verify', 'update', 'configure',
    'see', 'visit', 'contact', 'retry', 'refresh'
  ];

  const hasActionable = actionableKeywords.some(keyword =>
    message.toLowerCase().includes(keyword)
  );

  return hasActionable;
}
```

### Cache TTL Validation

```typescript
/**
 * Validate cache TTL is within reasonable bounds
 */
function validateCacheTTL(ttl: number): boolean {
  const MIN_TTL = 60 * 1000; // 1 minute
  const MAX_TTL = 24 * 60 * 60 * 1000; // 24 hours

  return ttl >= MIN_TTL && ttl <= MAX_TTL;
}
```

---

## Relationships

```
EnhancedError
  ├── contains → ErrorAction[] (recovery actions)
  └── wraps → Error (original cause)

NetworkState
  ├── triggers → NetworkStateChange (state transitions)
  └── affects → QueuedRequest[] (offline operations)

CachedData<T>
  ├── validated by → CacheStatus
  └── used by → NetworkState (offline mode)

ProgressState
  ├── reports → ProgressReport (progress updates)
  └── uses → vscode.CancellationToken (cancellation)

WalkthroughStep
  ├── part of → WalkthroughProgress
  └── tracked in → WalkthroughState

SmartNotification
  ├── contains → NotificationAction[]
  ├── managed by → NotificationManagerState
  └── displays → EnhancedError (for errors)
```

---

*Generated by speckit*
