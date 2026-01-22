# Implementation Plan: Error Handling & UX Polish

**Feature**: Error Handling & UX Polish for Generacy VS Code Extension
**Branch**: `066-tg-021-error-handling`
**Status**: Complete

## Summary

This task group enhances the Generacy VS Code Extension with comprehensive error handling, offline mode support, a welcome walkthrough for new users, keyboard shortcuts, and improved loading states. These polish features improve the overall user experience and make the extension more production-ready for marketplace release.

## Technical Context

| Aspect | Choice | Rationale |
|--------|--------|-----------|
| Language | TypeScript | Extension already built in TypeScript |
| Error Framework | Existing GeneracyError class | Already established in utils/errors.ts |
| UI Patterns | VS Code native UI | Progress indicators, notifications, webviews |
| Keyboard | VS Code keybindings | Native keyboard shortcut system |
| Walkthrough | VS Code Walkthrough API | Built-in first-run experience API |
| Network Detection | navigator.onLine + retry logic | Standard web API + graceful degradation |

## Existing Infrastructure

The extension already has a solid error handling foundation:

- `src/utils/errors.ts`: ErrorCode enum, GeneracyError class, showError/showWarning functions
- `src/utils/logger.ts`: Centralized logging with output channel
- `src/api/client.ts`: API client with retry logic

## Project Structure

```
packages/generacy-extension/src/
├── utils/
│   ├── errors.ts              # ✓ Exists - enhance error messages
│   ├── network.ts             # NEW - offline detection & handling
│   └── retry.ts               # NEW - exponential backoff utilities
│
├── ui/
│   ├── welcome/               # NEW - first-run walkthrough
│   │   ├── walkthrough.ts     # Walkthrough content provider
│   │   └── content.md         # Markdown walkthrough content
│   ├── progress/              # NEW - loading state components
│   │   ├── indicators.ts      # Progress bar & spinner utilities
│   │   └── status.ts          # Status bar manager
│   └── notifications/         # NEW - smart notification system
│       └── manager.ts         # Rate-limited, contextual notifications
│
├── commands/
│   └── shortcuts.ts           # NEW - keyboard shortcut handlers
│
├── api/
│   ├── client.ts              # ENHANCE - offline mode handling
│   └── cache.ts               # NEW - local cache for offline mode
│
├── views/
│   ├── local/
│   │   ├── explorer/
│   │   │   └── provider.ts    # ENHANCE - loading states
│   │   ├── runner/
│   │   │   └── executor.ts    # ENHANCE - better error messages
│   │   └── debugger/
│   │       └── adapter.ts     # ENHANCE - debug error handling
│   └── cloud/
│       ├── dashboard/
│       │   └── webview.ts     # ENHANCE - offline mode UI
│       ├── queue/
│       │   └── provider.ts    # ENHANCE - retry on failure
│       └── integrations/
│           └── provider.ts    # ENHANCE - connection errors
│
└── extension.ts               # ENHANCE - register walkthrough
```

## Implementation Phases

### Phase 1: Enhanced Error Messages (Priority 1)

**Goal**: Improve all error messages to be actionable and user-friendly

**Tasks**:
1. Audit all `throw new GeneracyError()` calls across the codebase
2. Enhance error messages with:
   - Clear description of what went wrong
   - Why it might have happened
   - Actionable next steps
3. Add error-specific recovery actions (retry, show logs, help docs)
4. Create error message templates for common scenarios
5. Add contextual help links to documentation

**Files Modified**:
- `src/utils/errors.ts` - Enhanced ERROR_MESSAGES dictionary
- All modules with error throwing - Better error context

### Phase 2: Offline Mode Handling (Priority 1)

**Goal**: Gracefully handle network failures and offline scenarios

**Tasks**:
1. Create network detection utility (`src/utils/network.ts`)
2. Implement request queue for offline operations
3. Add local caching layer for cloud data (`src/api/cache.ts`)
4. Show offline indicator in status bar
5. Disable cloud-dependent commands when offline
6. Auto-retry requests when coming back online
7. Display cached data with "stale" indicators

**Files**:
- `src/utils/network.ts` - Network detection & events
- `src/api/cache.ts` - Local storage cache
- `src/api/client.ts` - Offline-aware request logic
- `src/views/cloud/**` - Offline mode UI states

### Phase 3: Welcome Walkthrough (Priority 2)

**Goal**: Guide first-time users through extension features

**Tasks**:
1. Create walkthrough content using VS Code Walkthrough API
2. Define walkthrough steps:
   - Introduction to Generacy
   - Local workflow development
   - Running your first workflow
   - Debugging workflows
   - Connecting to cloud (if authenticated)
3. Add "Get Started" command to welcome screen
4. Show walkthrough on first activation
5. Add "Help: Show Walkthrough" command for returning users

**Files**:
- `src/ui/welcome/walkthrough.ts` - Walkthrough provider
- `src/ui/welcome/content.md` - Walkthrough markdown
- `package.json` - Register walkthrough contribution
- `src/extension.ts` - Show on first run

### Phase 4: Keyboard Shortcuts (Priority 2)

**Goal**: Add productivity keyboard shortcuts for common actions

**Shortcuts**:
- `Cmd/Ctrl+Shift+R` - Run current workflow
- `Cmd/Ctrl+Shift+D` - Debug current workflow
- `Cmd/Ctrl+Shift+V` - Validate current workflow
- `Cmd/Ctrl+Shift+P` - Publish to cloud (if authenticated)
- `F5` - Continue debugging (standard)
- `F10` - Step over (standard)
- `F11` - Step into (standard)

**Tasks**:
1. Define keybindings in `package.json`
2. Create keyboard shortcut handler commands
3. Add "Keyboard Shortcuts" section to documentation
4. Ensure shortcuts don't conflict with VS Code defaults
5. Make shortcuts context-aware (local vs cloud mode)

**Files**:
- `package.json` - Keybindings contribution
- `src/commands/shortcuts.ts` - Shortcut command handlers
- Documentation updates

### Phase 5: Loading States & Progress Indicators (Priority 1)

**Goal**: Show clear feedback during long operations

**Tasks**:
1. Create progress indicator utilities (`src/ui/progress/indicators.ts`)
2. Add loading states to tree views:
   - Workflow Explorer: "Loading workflows..."
   - Queue View: "Fetching queue..."
   - Integrations: "Checking connection status..."
3. Show progress bars for:
   - Workflow execution (per-phase progress)
   - File uploads
   - Publishing workflows
   - Initial authentication
4. Add status bar indicators:
   - Current operation (e.g., "Running workflow: setup-environment")
   - Network status (online/offline)
   - Sync status (local vs cloud)
5. Implement cancellation support for long operations

**Files**:
- `src/ui/progress/indicators.ts` - Progress utilities
- `src/ui/progress/status.ts` - Status bar manager
- All view providers - Loading states
- `src/views/local/runner/executor.ts` - Execution progress
- `src/views/cloud/publish/sync.ts` - Publish progress

## Key Technical Decisions

### 1. Network Detection Strategy
- Use `navigator.onLine` as initial signal
- Test actual connectivity with lightweight ping to API
- Implement exponential backoff for retries (1s, 2s, 4s, 8s, max 30s)
- Queue operations during offline periods, sync when back online

### 2. Error Message Enhancement
- Follow pattern: "What happened" + "Why" + "What to do"
- Example: "Unable to load workflow file" → "Unable to load workflow file. The file may have been moved or deleted. Check the file path and try refreshing the explorer."
- Add action buttons: "Retry", "Show Logs", "Get Help"

### 3. Walkthrough Design
- Use VS Code's native Walkthrough API (vs custom webview)
- Progressive disclosure: Start simple, reveal complexity gradually
- Each step is actionable: Click to create, run, debug
- Links to documentation for deeper learning

### 4. Progress Feedback Patterns
- **Quick operations** (< 100ms): No indicator
- **Short operations** (100ms - 2s): Status bar text only
- **Medium operations** (2s - 10s): Progress notification
- **Long operations** (> 10s): Progress notification with percentage/phase
- **Background operations**: Status bar indicator, notification on completion

### 5. Keyboard Shortcut Scope
- Global shortcuts: Run, Debug, Validate
- Editor-context shortcuts: Apply when workflow YAML is active
- Tree-view shortcuts: Apply when explorer/queue is focused
- Conflict resolution: Prefix all with `Cmd/Ctrl+Shift+` to avoid conflicts

## Error Message Templates

### Configuration Errors
```typescript
// Before
throw new GeneracyError(ErrorCode.ConfigMissing, 'Required configuration is missing');

// After
throw new GeneracyError(
  ErrorCode.ConfigMissing,
  'Workflow directory configuration is missing. Set "generacy.workflowDirectory" in settings to specify where workflow files are stored.',
  { details: { setting: 'generacy.workflowDirectory' } }
);
```

### API Errors
```typescript
// Before
throw new GeneracyError(ErrorCode.ApiConnectionError, 'Unable to connect to server');

// After
throw new GeneracyError(
  ErrorCode.ApiConnectionError,
  'Unable to connect to Generacy API. Check your internet connection or try again later. If the problem persists, visit status.generacy.ai for service status.',
  {
    details: { endpoint: 'https://api.generacy.ai' },
    showOutput: true,
    actions: [
      { label: 'Retry', action: () => retryConnection() },
      { label: 'Check Status', action: () => openStatusPage() }
    ]
  }
);
```

### Workflow Errors
```typescript
// Before
throw new GeneracyError(ErrorCode.WorkflowValidationError, 'Workflow validation failed');

// After
throw new GeneracyError(
  ErrorCode.WorkflowValidationError,
  `Workflow validation failed: Missing required field "steps" in phase "setup". Every workflow phase must have at least one step.`,
  {
    details: {
      phase: 'setup',
      missingField: 'steps',
      line: 42
    },
    actions: [
      { label: 'View Error', action: () => jumpToLine(42) },
      { label: 'View Schema', action: () => showSchema() }
    ]
  }
);
```

## Testing Strategy

| Layer | Focus | Approach |
|-------|-------|----------|
| Unit | Error message formatting | Test all ErrorCode messages have actionable content |
| Unit | Network detection logic | Mock navigator.onLine and API responses |
| Unit | Retry logic | Test backoff timing and max retries |
| Integration | Offline mode flow | Simulate network failures during operations |
| Integration | Progress indicators | Verify progress shown for long operations |
| Manual | Walkthrough flow | First-run experience with fresh install |
| Manual | Keyboard shortcuts | Test all shortcuts in different contexts |

## Success Criteria

| Criterion | Measurement |
|-----------|-------------|
| Comprehensive error messages | All 45+ error codes have actionable messages |
| Offline mode works | Extension functional without network for local features |
| Walkthrough completion | 60%+ of first-time users complete walkthrough |
| Keyboard shortcut usage | 30%+ of users use at least one shortcut |
| Loading state visibility | All operations >2s show progress indicator |
| User satisfaction | Marketplace rating maintains 4+ stars |

## Dependencies

- VS Code Extension API 1.85.0+ (Walkthrough API)
- Existing error handling infrastructure (utils/errors.ts)
- Existing API client (api/client.ts)
- Existing logger (utils/logger.ts)

## Configuration Updates

Add to `package.json`:

```json
{
  "contributes": {
    "walkthroughs": [{
      "id": "generacy.welcome",
      "title": "Get Started with Generacy",
      "description": "Learn how to create and run workflows",
      "steps": [/* walkthrough steps */]
    }],
    "keybindings": [
      {
        "command": "generacy.runWorkflow",
        "key": "ctrl+shift+r",
        "mac": "cmd+shift+r",
        "when": "editorLangId == yaml"
      },
      /* more keybindings */
    ]
  }
}
```

## Rollout Plan

1. **Phase 1**: Enhanced error messages (no breaking changes)
2. **Phase 2**: Offline mode (graceful degradation)
3. **Phase 3**: Welcome walkthrough (opt-in on first run)
4. **Phase 4**: Keyboard shortcuts (additive)
5. **Phase 5**: Progress indicators (UI enhancement)

All phases can be deployed incrementally without breaking existing functionality.

---

*Generated by speckit*
