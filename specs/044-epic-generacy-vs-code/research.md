# Research: Generacy VS Code Extension

## Technology Decisions

### VS Code Extension Development

**Decision**: Use VS Code Extension API with TypeScript

**Rationale**:
- Native integration with VS Code features
- TypeScript provides type safety and excellent tooling
- Large ecosystem of extension development resources
- Consistent with existing codebase (TypeScript throughout)

**Alternatives Considered**:
1. **Language Server Protocol (LSP)**: Considered for YAML language features, but VS Code's built-in YAML support with custom schemas is sufficient
2. **Web Extension**: Rejected as we need file system access for local workflow execution
3. **Separate Electron App**: Rejected as VS Code integration provides better developer experience

### Debug Adapter Protocol (DAP)

**Decision**: Implement full Debug Adapter Protocol for workflow debugging

**Rationale**:
- Native VS Code debugger integration
- Standard protocol with well-defined semantics
- Supports breakpoints, stepping, variable inspection
- Familiar UX for developers

**Implementation Approach**:
```typescript
// Debug adapter will implement standard DAP handlers
interface WorkflowDebugAdapter {
  launch(config: DebugConfiguration): Promise<void>;
  setBreakpoints(path: string, breakpoints: SourceBreakpoint[]): void;
  continue(): void;
  stepIn(): void;
  stepOut(): void;
  evaluate(expression: string, frameId: number): any;
}
```

### YAML Schema Validation

**Decision**: Use JSON Schema with VS Code YAML extension integration

**Rationale**:
- VS Code's YAML extension supports JSON Schema for validation
- Provides IntelliSense, hover, and validation out of the box
- Schema can be bundled with extension or fetched from server
- Consistent validation between editor and runtime

**Schema Location Strategy**:
```json
// package.json contributes
{
  "yaml.schemas": {
    "./schemas/workflow.schema.json": ".generacy/*.yaml"
  }
}
```

### API Client Architecture

**Decision**: Custom fetch-based client with Zod validation

**Rationale**:
- Minimal dependencies (fetch is built-in)
- Zod provides runtime type validation (consistent with orchestrator)
- Easy to test and mock
- Type-safe API responses

**Implementation Pattern**:
```typescript
// API client with typed responses
const client = {
  async getQueue(): Promise<QueueItem[]> {
    const response = await fetch(`${baseUrl}/queue`, { headers });
    const data = await response.json();
    return QueueItemSchema.array().parse(data);
  }
};
```

### Authentication Flow

**Decision**: GitHub OAuth via VS Code URI handler

**Rationale**:
- Leverages VS Code's built-in URI handling
- No need for local server or manual token entry
- Consistent with VS Code GitHub extension pattern
- Secure callback handling

**Flow**:
1. User clicks "Sign in with GitHub"
2. Open browser to generacy.ai OAuth URL
3. User authenticates and authorizes
4. Callback redirects to `vscode://generacy-ai.generacy/callback?token=xxx`
5. Extension receives token via URI handler
6. Token stored securely in SecretStorage

### State Management

**Decision**: VS Code Memento API + Extension Context

**Rationale**:
- Built-in persistence across sessions
- Global and workspace-scoped storage
- No additional dependencies
- Handles serialization automatically

**Usage Pattern**:
```typescript
// Global state (user preferences)
context.globalState.update('lastUsedTemplate', 'basic');

// Workspace state (project-specific)
context.workspaceState.update('debugBreakpoints', breakpoints);

// Secrets (tokens)
context.secrets.store('authToken', token);
```

## Implementation Patterns

### Tree View Provider Pattern

For Workflow Explorer and Queue views:

```typescript
class WorkflowTreeProvider implements vscode.TreeDataProvider<WorkflowItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WorkflowItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  getTreeItem(element: WorkflowItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorkflowItem): Thenable<WorkflowItem[]> {
    // Return children based on element or root items
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }
}
```

### Webview Panel Pattern

For Organization Dashboard:

```typescript
class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;

  public static createOrShow(context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'generacyDashboard',
      'Generacy Dashboard',
      column || vscode.ViewColumn.One,
      { enableScripts: true }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel, context);
  }
}
```

### Command Registration Pattern

```typescript
// commands/index.ts
export function registerCommands(context: vscode.ExtensionContext) {
  const commands: [string, (...args: any[]) => any][] = [
    ['generacy.createWorkflow', createWorkflow],
    ['generacy.runWorkflow', runWorkflow],
    ['generacy.debugWorkflow', debugWorkflow],
    ['generacy.publishWorkflow', publishWorkflow],
  ];

  for (const [id, handler] of commands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, handler)
    );
  }
}
```

## Key Sources and References

### VS Code Extension Development
- [VS Code Extension API](https://code.visualstudio.com/api)
- [Extension Samples](https://github.com/microsoft/vscode-extension-samples)
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)

### Comparable Extensions
- **vscode-yaml**: YAML language support implementation
- **vscode-docker**: Tree view + webview patterns
- **GitHub Pull Requests**: OAuth flow reference
- **Thunder Client**: API client webview design

### Technology Documentation
- [Zod Documentation](https://zod.dev)
- [esbuild for VS Code](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)
- [VS Code Testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| DAP complexity | Medium | High | Start with basic stepping, add features incrementally |
| API changes | Low | Medium | Version API endpoints, handle gracefully |
| Performance on large workspaces | Medium | Medium | Virtual trees, lazy loading, caching |
| OAuth flow issues | Low | High | Fallback to manual token entry |

## Open Questions (Resolved)

1. **Q**: Should we bundle YAML extension or depend on it?
   **A**: Depend on it - most users already have it installed, reduces our bundle size

2. **Q**: How to handle offline mode in cloud features?
   **A**: Cache last known state, show "offline" indicator, queue actions for later

3. **Q**: Workspace vs folder-scoped workflows?
   **A**: Support both - detect `.generacy` in workspace root or any open folder

---

*Generated by speckit*
