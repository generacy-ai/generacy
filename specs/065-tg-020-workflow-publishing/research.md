# Research: Workflow Publishing

## Technology Decisions

### 1. Diff Comparison Implementation

**Decision**: Use VS Code's native `vscode.diff` command with TextDocumentContentProvider

**Alternatives Considered**:

1. **Custom Webview with diff2html**
   - Pros: Full control over UI, custom styling
   - Cons: Additional dependency, more code, inconsistent with VS Code theme
   - Verdict: ❌ Rejected due to complexity and UX inconsistency

2. **Monaco Editor with DiffEditor API**
   - Pros: More control than vscode.diff, programmatic access
   - Cons: More complex setup, requires custom webview
   - Verdict: ❌ Rejected in favor of simpler solution

3. **VS Code native vscode.diff command** ✅
   - Pros: Zero dependencies, native theme support, familiar UX
   - Cons: Less customization, need TextDocumentContentProvider
   - Verdict: ✅ **Selected** - Best balance of simplicity and UX

**Implementation Pattern**:
```typescript
// Register content provider for cloud workflows
vscode.workspace.registerTextDocumentContentProvider('generacy-cloud', {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const [workflow, version] = uri.path.split('/');
    return await getWorkflowVersion(workflow, parseInt(version));
  }
});

// Open diff
await vscode.commands.executeCommand(
  'vscode.diff',
  vscode.Uri.parse('generacy-cloud://workflow/ci-workflow/3'),
  vscode.Uri.file(localPath),
  'CI Workflow: Cloud ↔ Local'
);
```

**Reference**: [VS Code API - vscode.diff](https://code.visualstudio.com/api/references/vscode-api#commands.executeCommand)

### 2. Version History UI

**Decision**: Use QuickPick with rich descriptions

**Alternatives Considered**:

1. **TreeView in sidebar**
   - Pros: Always visible, hierarchical display
   - Cons: Takes up sidebar space, overkill for workflow-specific history
   - Verdict: ❌ Rejected - Not appropriate for contextual action

2. **Webview panel**
   - Pros: Full HTML/CSS control, rich UI
   - Cons: More code, slower to open, inconsistent with extension patterns
   - Verdict: ❌ Rejected - Too heavyweight

3. **QuickPick with details** ✅
   - Pros: Fast, native UX, supports detail text and buttons
   - Cons: Limited formatting options
   - Verdict: ✅ **Selected** - Matches VS Code conventions for action-oriented lists

**Implementation Pattern**:
```typescript
const items = versions.map(v => ({
  label: `$(tag) Version ${v.version}${v.tag ? ` (${v.tag})` : ''}`,
  description: new Date(v.publishedAt).toLocaleString(),
  detail: v.changelog || 'No changelog',
  buttons: [
    { iconPath: new vscode.ThemeIcon('eye'), tooltip: 'View' },
    { iconPath: new vscode.ThemeIcon('diff'), tooltip: 'Compare' },
    { iconPath: new vscode.ThemeIcon('history'), tooltip: 'Rollback' },
  ],
  version: v.version,
}));

const quickPick = vscode.window.createQuickPick();
quickPick.items = items;
quickPick.onDidTriggerItemButton(e => {
  // Handle button clicks
});
quickPick.show();
```

**Reference**: [VS Code API - QuickPick](https://code.visualstudio.com/api/references/vscode-api#QuickPick)

### 3. Sync Status Indicators

**Decision**: FileDecorationProvider with cached status checks

**Alternatives Considered**:

1. **CodeLens on file open**
   - Pros: Inline with content, clear visibility
   - Cons: Only shows in open files, clutters editor
   - Verdict: ❌ Rejected - Too intrusive

2. **Status bar item**
   - Pros: Always visible for active file
   - Cons: Only shows one file at a time, competes for status bar space
   - Verdict: ❌ Rejected - Limited to active file

3. **FileDecorationProvider in explorer** ✅
   - Pros: Shows all workflow files at once, unobtrusive, standard pattern
   - Cons: Need to manage cache for performance
   - Verdict: ✅ **Selected** - Best balance of visibility and performance

**Implementation Pattern**:
```typescript
class WorkflowSyncDecorationProvider implements vscode.FileDecorationProvider {
  private cache = new Map<string, { status: SyncStatus; expiresAt: number }>();

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (!uri.path.endsWith('.yaml') || !uri.path.includes('.generacy/')) {
      return undefined;
    }

    const status = await this.getSyncStatus(uri);

    return {
      badge: SYNC_STATUS_ICONS[status],
      color: new vscode.ThemeColor(SYNC_STATUS_COLORS[status]),
      tooltip: this.getStatusTooltip(status),
    };
  }
}
```

**Reference**: [VS Code API - FileDecorationProvider](https://code.visualstudio.com/api/references/vscode-api#FileDecorationProvider)

### 4. Changelog Input UI

**Decision**: InputBox followed by QuickPick confirmation

**Alternatives Considered**:

1. **Webview form**
   - Pros: Rich input UI, markdown preview
   - Cons: Slow to open, heavyweight
   - Verdict: ❌ Rejected - Too complex for simple text input

2. **Single QuickPick with input field**
   - Pros: One-step process
   - Cons: QuickPick doesn't support multiline input
   - Verdict: ❌ Rejected - Technical limitation

3. **InputBox → QuickPick confirmation** ✅
   - Pros: Supports multiline, native UX, clear two-step flow
   - Cons: Two dialogs instead of one
   - Verdict: ✅ **Selected** - Best UX for changelog + confirmation

**Implementation Pattern**:
```typescript
// Step 1: Changelog input
const changelog = await vscode.window.showInputBox({
  prompt: 'Describe what changed in this version',
  placeHolder: 'Added deployment phase, updated test configuration',
  value: '',
  ignoreFocusOut: true,
  validateInput: (value) => {
    return value.length > 500 ? 'Changelog too long (max 500 chars)' : undefined;
  }
});

// Step 2: Confirmation
const action = await vscode.window.showQuickPick([
  { label: '$(cloud-upload) Publish Now', action: 'publish' },
  { label: '$(diff) Review Changes', action: 'diff' },
  { label: '$(x) Cancel', action: 'cancel' },
], {
  placeHolder: `Publishing workflow: ${workflowName}`,
  ignoreFocusOut: true,
});
```

**Reference**: [VS Code API - window.showInputBox](https://code.visualstudio.com/api/references/vscode-api#window.showInputBox)

### 5. Rollback Implementation Strategy

**Decision**: Non-destructive rollback creating new version

**Alternatives Considered**:

1. **Destructive rollback (delete versions)**
   - Pros: Simpler version history
   - Cons: Loses audit trail, can't undo rollback
   - Verdict: ❌ Rejected - Dangerous, violates audit requirements

2. **Rollback pointer (mark current version)**
   - Pros: Preserves all versions
   - Cons: Confusing UX (which version is "current"?), complex state
   - Verdict: ❌ Rejected - Adds complexity

3. **Rollback as new version** ✅
   - Pros: Preserves history, can undo rollback, matches Git model
   - Cons: Version numbers keep incrementing
   - Verdict: ✅ **Selected** - Best for audit trail and user expectations

**Implementation Pattern**:
```typescript
async function rollbackWorkflow(
  workflowName: string,
  targetVersion: number
): Promise<void> {
  // Fetch target version content
  const content = await getWorkflowVersion(workflowName, targetVersion);

  // Publish as new version with auto-generated changelog
  await publishWorkflow({
    name: workflowName,
    content,
    changelog: `Rolled back to version ${targetVersion}`,
  });
}
```

**Example version timeline**:
```
v1: Initial version
v2: Added feature X
v3: Added feature Y
v4: Rollback to v2 (includes v2 content)
v5: New changes on top of v4
```

### 6. Sync Status Cache Strategy

**Decision**: In-memory cache with 5-minute TTL + event-based invalidation

**Alternatives Considered**:

1. **No caching (always fetch)**
   - Pros: Always accurate
   - Cons: Too many API calls, poor performance
   - Verdict: ❌ Rejected - Unacceptable latency

2. **Persistent cache in workspace state**
   - Pros: Survives extension restart
   - Cons: Can become stale, complex invalidation
   - Verdict: ❌ Rejected - Stale data risk

3. **In-memory cache with TTL + invalidation** ✅
   - Pros: Fast, automatic refresh, event-based updates
   - Cons: Lost on extension restart (acceptable)
   - Verdict: ✅ **Selected** - Best performance vs. accuracy tradeoff

**Cache Invalidation Events**:
- File save (`vscode.workspace.onDidSaveTextDocument`)
- Successful publish
- Successful rollback
- Manual refresh command
- Cache age > TTL (5 minutes)

**Implementation Pattern**:
```typescript
class SyncStatusCache {
  private cache = new Map<string, CachedStatus>();
  private readonly TTL = 5 * 60 * 1000; // 5 minutes

  async get(workflowName: string): Promise<SyncStatus> {
    const cached = this.cache.get(workflowName);

    if (cached && Date.now() - cached.cachedAt < this.TTL) {
      return cached.status;
    }

    // Fetch fresh status
    const status = await this.fetchSyncStatus(workflowName);
    this.cache.set(workflowName, { status, cachedAt: Date.now() });
    return status;
  }

  invalidate(workflowName: string): void {
    this.cache.delete(workflowName);
  }
}
```

### 7. API Error Handling

**Decision**: Retry with exponential backoff + user-friendly error messages

**Pattern**: Already implemented in `ApiClient` (inherited from TG-014)

**Error Mapping**:
| HTTP Status | Error Code | User Message | Action |
|-------------|------------|--------------|--------|
| 401 | `auth_expired` | "Please sign in again" | Open auth flow |
| 403 | `auth_failed` | "You don't have permission to publish workflows" | Show org settings |
| 409 | `conflict` | "Cloud version has changed. Please review differences." | Show diff UI |
| 422 | `validation_error` | "Invalid workflow: [specific error]" | Highlight error in file |
| 429 | `rate_limited` | "Too many requests. Please try again in a moment." | Show retry button |
| 500+ | `server_error` | "Server error. Please try again." | Automatic retry |

**Reference**: Existing `ApiClient.createApiError()` implementation

## Implementation Patterns

### Pattern 1: Command Registration

```typescript
// In extension.ts
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('generacy.publishWorkflow', async () => {
      await publishWorkflowCommand();
    }),

    vscode.commands.registerCommand('generacy.viewVersionHistory', async () => {
      await viewVersionHistoryCommand();
    }),

    vscode.commands.registerCommand('generacy.compareWithCloud', async () => {
      await compareWithCloudCommand();
    })
  );
}
```

### Pattern 2: URI Content Provider

```typescript
class CloudWorkflowContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parts = uri.path.split('/').filter(Boolean);
    const [workflowName, versionStr] = parts;
    const version = parseInt(versionStr);

    try {
      return await getWorkflowVersion(workflowName, version);
    } catch (error) {
      throw new Error(`Failed to load workflow version: ${error.message}`);
    }
  }
}
```

### Pattern 3: Progress Notification

```typescript
async function publishWorkflowCommand(): Promise<void> {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Publishing workflow",
    cancellable: false,
  }, async (progress) => {
    progress.report({ increment: 0, message: "Validating..." });

    // Validate workflow
    const content = await validateWorkflow();
    progress.report({ increment: 33, message: "Uploading..." });

    // Publish to API
    const result = await publishWorkflow({ name, content, changelog });
    progress.report({ increment: 66, message: "Updating status..." });

    // Invalidate cache and refresh UI
    await refreshSyncStatus(name);
    progress.report({ increment: 100, message: "Done!" });

    vscode.window.showInformationMessage(
      `Published ${name} as version ${result.version}`
    );
  });
}
```

## Key Sources

1. [VS Code Extension API Documentation](https://code.visualstudio.com/api)
2. [VS Code Extension Samples - Diff Editor](https://github.com/microsoft/vscode-extension-samples/tree/main/diff-editor-sample)
3. [VS Code Extension Samples - File Decorations](https://github.com/microsoft/vscode-extension-samples/tree/main/decorator-sample)
4. [Zod Documentation](https://zod.dev/)
5. [YAML npm package](https://www.npmjs.com/package/yaml)

## Testing References

1. [VS Code Extension Testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
2. [Vitest Documentation](https://vitest.dev/)
3. [@vscode/test-electron](https://www.npmjs.com/package/@vscode/test-electron)

## Performance Considerations

### API Call Optimization
- **Batch requests**: Combine version list + latest content when possible
- **Conditional requests**: Use ETag/If-None-Match headers (if API supports)
- **Pagination**: Limit version history to last 50 versions by default
- **Debounce**: Wait 500ms after file save before checking sync status

### Memory Management
- **Cache size**: Limit sync status cache to 100 workflows
- **Content disposal**: Dispose TextDocumentContentProvider content after diff closes
- **Event listener cleanup**: Properly dispose all event subscriptions

### Latency Targets
- **Publish command**: < 2s (excluding network)
- **Diff view open**: < 500ms
- **Version history load**: < 1s
- **Sync status check**: < 100ms (from cache)

---

*Generated by speckit*
