# Research: Error Handling & UX Polish

**Feature**: Error Handling & UX Polish
**Date**: 2026-01-22

## Technology Decisions

### 1. Network Detection & Offline Mode

**Decision**: Use `navigator.onLine` + API health checks

**Rationale**:
- `navigator.onLine` provides instant offline detection
- Actual connectivity requires testing with lightweight API ping
- Combines best of both: fast feedback + accurate state

**Alternatives Considered**:
- **Periodic API polling only**: High latency, drains resources
- **navigator.onLine only**: False positives (connected but no internet)
- **WebSocket connection**: Overkill for this use case, adds complexity

**Implementation Pattern**:
```typescript
async function checkConnectivity(): Promise<boolean> {
  if (!navigator.onLine) return false;

  try {
    const response = await fetch('https://api.generacy.ai/health', {
      method: 'HEAD',
      cache: 'no-cache',
      signal: AbortSignal.timeout(5000)
    });
    return response.ok;
  } catch {
    return false;
  }
}
```

**References**:
- MDN: navigator.onLine - https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine
- VS Code network detection patterns in built-in extensions

---

### 2. Progress Indication Strategy

**Decision**: Use VS Code's native progress API with time-based thresholds

**Rationale**:
- Native progress API integrates with VS Code's UI theme
- Time-based thresholds prevent flashing for quick operations
- Supports cancellation tokens for long operations

**Threshold Rules**:
| Duration | Feedback |
|----------|----------|
| < 100ms | None (instant feel) |
| 100ms - 2s | Status bar text |
| 2s - 10s | Notification with progress |
| > 10s | Notification with percentage + cancel |

**API Choice**:
```typescript
// Window progress (notification area)
vscode.window.withProgress({
  location: vscode.ProgressLocation.Notification,
  title: 'Running workflow',
  cancellable: true
}, async (progress, token) => {
  // Report progress
  progress.report({ increment: 20, message: 'Phase 1 of 5' });
});

// Status bar progress (lightweight)
vscode.window.setStatusBarMessage('$(sync~spin) Validating...', 2000);
```

**Alternatives Considered**:
- **Custom progress UI**: More control but inconsistent with VS Code
- **Always show progress**: Causes UI flashing for quick operations
- **No progress**: Poor UX for long operations

**References**:
- VS Code Progress API: https://code.visualstudio.com/api/references/vscode-api#Progress
- UX research: Users tolerate 100ms without feedback (Nielsen Norman Group)

---

### 3. Walkthrough vs Custom Onboarding

**Decision**: Use VS Code Walkthrough API

**Rationale**:
- Native API introduced in VS Code 1.58
- Zero maintenance for UI rendering
- Consistent with other extensions
- Automatically supports themes, accessibility
- Users familiar with the pattern

**Walkthrough Structure**:
```json
{
  "contributes": {
    "walkthroughs": [{
      "id": "generacy.welcome",
      "title": "Get Started with Generacy",
      "steps": [
        {
          "id": "intro",
          "title": "Welcome to Generacy",
          "description": "Learn to build AI-powered workflows...",
          "media": { "image": "resources/walkthrough/intro.png" }
        },
        {
          "id": "create-workflow",
          "title": "Create Your First Workflow",
          "description": "Click below to create a workflow file",
          "completionEvents": ["onCommand:generacy.createWorkflow"]
        }
      ]
    }]
  }
}
```

**Alternatives Considered**:
- **Custom webview**: Full control but high maintenance, accessibility issues
- **Markdown README**: Static, no interactivity
- **Video tutorial**: High production cost, outdates quickly

**References**:
- VS Code Walkthrough Contribution: https://code.visualstudio.com/api/references/contribution-points#contributes.walkthroughs
- Example: Python extension walkthrough

---

### 4. Error Message Design Pattern

**Decision**: Structured error messages with "What-Why-How" pattern

**Rationale**:
- Users need context (what happened), cause (why), and resolution (how to fix)
- Actionable buttons reduce friction
- Consistent structure improves learnability

**Pattern**:
```typescript
interface EnhancedErrorMessage {
  what: string;      // "Unable to load workflow file"
  why: string;       // "The file may have been moved or deleted"
  how: string;       // "Check the file path and try refreshing"
  actions: Action[]; // [{ label: "Retry", action: fn }]
}
```

**Example Messages**:
```typescript
// Configuration error
{
  what: "Workflow directory not found",
  why: "The directory '.generacy' does not exist in your workspace",
  how: "Create a '.generacy' folder or update 'generacy.workflowDirectory' in settings",
  actions: [
    { label: "Create Directory", action: createDirectory },
    { label: "Open Settings", action: openSettings }
  ]
}

// Network error
{
  what: "Connection to Generacy API failed",
  why: "Your internet connection may be offline or the service may be down",
  how: "Check your connection and try again. Visit status.generacy.ai for service status",
  actions: [
    { label: "Retry", action: retry },
    { label: "Work Offline", action: enableOfflineMode },
    { label: "Check Status", action: openStatusPage }
  ]
}
```

**Alternatives Considered**:
- **Terse error codes**: Hard to understand without documentation
- **Verbose stack traces**: Overwhelming for users
- **Generic messages**: Not actionable

**References**:
- Nielsen Norman Group: Error Message Guidelines
- Material Design: Error states and messaging
- VS Code error message patterns in core extensions

---

### 5. Keyboard Shortcut Strategy

**Decision**: Use `Cmd/Ctrl+Shift+[Letter]` prefix for all custom shortcuts

**Rationale**:
- `Cmd/Ctrl+Shift` prefix avoids conflicts with VS Code core shortcuts
- Follows extension shortcut conventions
- Easy to discover via keyboard shortcut viewer
- Can be remapped by users if conflicts arise

**Shortcut Mapping**:
| Action | Shortcut | Rationale |
|--------|----------|-----------|
| Run Workflow | `Cmd/Ctrl+Shift+R` | R for Run (common in IDEs) |
| Debug Workflow | `Cmd/Ctrl+Shift+D` | D for Debug (VS Code pattern) |
| Validate | `Cmd/Ctrl+Shift+V` | V for Validate |
| Publish | `Cmd/Ctrl+Shift+P` | P for Publish (cloud only) |

**Context-Aware Shortcuts**:
```json
{
  "command": "generacy.runWorkflow",
  "key": "ctrl+shift+r",
  "when": "editorLangId == yaml && resourcePath =~ /\\.generacy/"
}
```

**Alternatives Considered**:
- **Function keys** (F5, F6): Already used by VS Code debugger
- **Alt/Option shortcuts**: Reserved for menu access
- **Cmd/Ctrl+Letter**: High conflict risk

**References**:
- VS Code Keybinding Contribution: https://code.visualstudio.com/api/references/contribution-points#contributes.keybindings
- VS Code default keybindings: https://code.visualstudio.com/docs/getstarted/keybindings

---

### 6. Local Cache Strategy for Offline Mode

**Decision**: Use VS Code Memento API (global state) with TTL

**Rationale**:
- Memento API is native, persistent, cross-platform
- Global state persists across workspace changes
- TTL prevents serving stale data indefinitely
- Simple key-value API, no external dependencies

**Cache Structure**:
```typescript
interface CachedData<T> {
  data: T;
  timestamp: number;
  ttl: number; // milliseconds
}

async function getFromCache<T>(key: string): Promise<T | undefined> {
  const cached = globalState.get<CachedData<T>>(key);
  if (!cached) return undefined;

  const age = Date.now() - cached.timestamp;
  if (age > cached.ttl) {
    await globalState.update(key, undefined); // Evict
    return undefined;
  }

  return cached.data;
}
```

**TTL Strategy**:
| Data Type | TTL | Rationale |
|-----------|-----|-----------|
| Org info | 1 hour | Rarely changes |
| Queue items | 5 minutes | Frequently updated |
| Integration status | 15 minutes | Semi-static |
| User profile | 1 hour | Rarely changes |

**Alternatives Considered**:
- **localStorage**: Not available in extension host
- **File system**: Platform-specific paths, permission issues
- **IndexedDB**: Overkill for simple key-value storage

**References**:
- VS Code Memento API: https://code.visualstudio.com/api/references/vscode-api#Memento
- Example: GitLens extension cache implementation

---

### 7. Retry Logic & Exponential Backoff

**Decision**: Exponential backoff with jitter, max 5 attempts

**Rationale**:
- Exponential backoff reduces server load during outages
- Jitter prevents thundering herd problem
- Max attempts prevents infinite loops
- Standard industry pattern

**Implementation**:
```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 5
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt++;

      if (attempt >= maxAttempts) {
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s (max 30s)
      const baseDelay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);

      // Add jitter: ±25%
      const jitter = baseDelay * 0.25 * (Math.random() - 0.5);
      const delay = baseDelay + jitter;

      await sleep(delay);
    }
  }
}
```

**Backoff Schedule**:
| Attempt | Base Delay | Range (with jitter) |
|---------|------------|---------------------|
| 1 | 1s | 0.875s - 1.125s |
| 2 | 2s | 1.75s - 2.25s |
| 3 | 4s | 3.5s - 4.5s |
| 4 | 8s | 7s - 9s |
| 5 | 16s | 14s - 18s |

**Alternatives Considered**:
- **Linear backoff**: Doesn't reduce load effectively
- **Immediate retry**: Hammers failing servers
- **No retry**: Poor UX for transient failures

**References**:
- AWS Architecture Blog: Exponential Backoff and Jitter
- Google SRE Book: Handling Overload

---

## Implementation Patterns

### Pattern 1: Graceful Degradation for Cloud Features

```typescript
// Check connectivity before cloud operations
async function fetchQueueItems(): Promise<QueueItem[]> {
  const isOnline = await checkConnectivity();

  if (!isOnline) {
    // Try cache first
    const cached = await getFromCache<QueueItem[]>('queue');
    if (cached) {
      showWarning('Showing cached queue (offline mode)');
      return cached;
    }

    // No cache available
    throw new GeneracyError(
      ErrorCode.ApiConnectionError,
      'Unable to fetch queue items. Check your internet connection.',
      {
        actions: [
          { label: 'Retry', action: () => fetchQueueItems() },
          { label: 'Work Offline', action: () => showLocalFeatures() }
        ]
      }
    );
  }

  // Online: Fetch from API
  const items = await api.getQueue();
  await setCache('queue', items, 5 * 60 * 1000); // 5min TTL
  return items;
}
```

### Pattern 2: Progress Reporting for Long Operations

```typescript
async function runWorkflow(workflow: Workflow): Promise<void> {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Running workflow: ${workflow.name}`,
    cancellable: true
  }, async (progress, token) => {
    const phases = workflow.phases;

    for (let i = 0; i < phases.length; i++) {
      // Check cancellation
      if (token.isCancellationRequested) {
        throw new GeneracyError(ErrorCode.WorkflowExecutionError, 'Workflow cancelled by user');
      }

      // Report progress
      const percent = (i / phases.length) * 100;
      progress.report({
        increment: 100 / phases.length,
        message: `Phase ${i + 1} of ${phases.length}: ${phases[i].name}`
      });

      // Execute phase
      await executePhase(phases[i]);
    }
  });
}
```

### Pattern 3: Error Recovery with Actions

```typescript
async function loadWorkflow(path: string): Promise<Workflow> {
  try {
    const content = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
    return parseWorkflow(content);
  } catch (error) {
    // Determine error type and provide specific recovery
    if (error instanceof vscode.FileSystemError) {
      throw new GeneracyError(
        ErrorCode.FileNotFound,
        `Workflow file not found: ${path}. The file may have been moved or deleted.`,
        {
          details: { path },
          actions: [
            {
              label: 'Browse Files',
              action: async () => {
                const uri = await vscode.window.showOpenDialog({
                  filters: { 'Workflows': ['yaml', 'yml'] }
                });
                if (uri?.[0]) {
                  return loadWorkflow(uri[0].fsPath);
                }
              }
            },
            {
              label: 'Refresh Explorer',
              action: () => vscode.commands.executeCommand('generacy.refreshExplorer')
            }
          ]
        }
      );
    }

    throw GeneracyError.from(error, ErrorCode.WorkflowParseError);
  }
}
```

---

## Key Sources

1. **VS Code Extension API Documentation**
   - https://code.visualstudio.com/api
   - Official reference for all VS Code extension APIs

2. **Nielsen Norman Group: Error Message Guidelines**
   - https://www.nngroup.com/articles/error-message-guidelines/
   - UX research on effective error messaging

3. **Material Design: Error States**
   - https://m3.material.io/foundations/content-design/error-messages
   - Patterns for error UI and messaging

4. **Google SRE Book**
   - https://sre.google/books/
   - Best practices for reliability and error handling

5. **AWS Architecture Blog: Exponential Backoff**
   - https://aws.amazon.com/blogs/architecture/
   - Patterns for retry logic

6. **VS Code Extension Examples**
   - GitLens: Cache implementation
   - Python: Walkthrough implementation
   - ESLint: Error message patterns

---

*Generated by speckit*
