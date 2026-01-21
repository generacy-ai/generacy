# Implementation Plan: Generacy VS Code Extension

**Feature**: VS Code Extension for workflow development IDE and cloud orchestration management
**Branch**: `044-epic-generacy-vs-code`
**Status**: Complete

## Summary

Build the Generacy VS Code Extension - a comprehensive workflow development IDE that provides:
1. **Local Mode (FREE)**: Workflow Explorer, YAML Editor with intellisense, Local Runner, and Debugger
2. **Cloud Mode (Paid)**: Organization Dashboard, Workflow Queue, Integration Management, and Publishing

The extension bridges individual development and team-scale AI-driven workflows via the generacy.ai platform.

## Technical Context

| Aspect | Choice | Rationale |
|--------|--------|-----------|
| Language | TypeScript | VS Code extension standard, type safety, team expertise |
| Framework | VS Code Extension API | Native extension development |
| YAML Handling | yaml (^2.4.0) | Already used in orchestrator, consistent parsing |
| Validation | Zod (^3.23.0) | Schema validation, consistent with orchestrator |
| Debug Protocol | VS Code Debug Adapter Protocol | Native debugging support |
| API Client | fetch + Zod | Platform API communication |
| State Management | VS Code Memento API | Extension state persistence |
| Testing | Vitest + @vscode/test-electron | Unit + integration testing |

## Project Structure

```
packages/
└── generacy-extension/
    ├── package.json              # Extension manifest
    ├── tsconfig.json             # TypeScript config
    ├── .vscodeignore             # Files to exclude from packaging
    ├── CHANGELOG.md              # Version history
    ├── README.md                 # Marketplace description
    ├── resources/                # Icons and images
    │   ├── icon.png              # Extension icon
    │   └── images/               # Screenshots for marketplace
    ├── schemas/                  # YAML schema definitions
    │   └── workflow.schema.json  # Workflow file schema
    └── src/
        ├── extension.ts          # Extension entry point
        ├── constants.ts          # Extension-wide constants
        │
        ├── commands/             # VS Code command handlers
        │   ├── index.ts          # Command registration
        │   ├── workflow.ts       # Workflow CRUD commands
        │   ├── runner.ts         # Run/debug commands
        │   └── cloud.ts          # Cloud mode commands
        │
        ├── views/
        │   ├── local/
        │   │   ├── explorer/     # Workflow file tree
        │   │   │   ├── provider.ts
        │   │   │   ├── tree-item.ts
        │   │   │   └── decorations.ts
        │   │   ├── editor/       # YAML editor integration
        │   │   │   ├── completion.ts
        │   │   │   ├── diagnostics.ts
        │   │   │   ├── hover.ts
        │   │   │   └── codelens.ts
        │   │   ├── runner/       # Local execution
        │   │   │   ├── output-channel.ts
        │   │   │   ├── terminal.ts
        │   │   │   └── executor.ts
        │   │   └── debugger/     # Step-through debugging
        │   │       ├── adapter.ts
        │   │       ├── session.ts
        │   │       └── breakpoints.ts
        │   └── cloud/
        │       ├── dashboard/    # Org overview
        │       │   ├── webview.ts
        │       │   └── panel.ts
        │       ├── queue/        # Workflow queue
        │       │   ├── provider.ts
        │       │   ├── tree-item.ts
        │       │   └── actions.ts
        │       ├── integrations/ # Connection management
        │       │   ├── github.ts
        │       │   ├── status.ts
        │       │   └── config.ts
        │       └── publish/      # Workflow publishing
        │           ├── compare.ts
        │           ├── sync.ts
        │           └── version.ts
        │
        ├── providers/            # Tree view providers
        │   ├── workflow-tree.ts
        │   ├── queue-tree.ts
        │   └── status-bar.ts
        │
        ├── debug/                # Debug adapter
        │   ├── adapter.ts        # Debug adapter implementation
        │   ├── protocol.ts       # DAP message handling
        │   ├── runtime.ts        # Workflow runtime
        │   └── state.ts          # Execution state
        │
        ├── language/             # YAML language features
        │   ├── schema.ts         # Schema loading
        │   ├── validator.ts      # YAML validation
        │   └── formatter.ts      # YAML formatting
        │
        ├── api/                  # generacy.ai API client
        │   ├── client.ts         # HTTP client
        │   ├── auth.ts           # Authentication
        │   ├── types.ts          # API types
        │   └── endpoints/
        │       ├── workflows.ts
        │       ├── orgs.ts
        │       ├── queue.ts
        │       └── integrations.ts
        │
        └── utils/
            ├── config.ts         # Extension configuration
            ├── telemetry.ts      # Usage telemetry (opt-in)
            ├── logger.ts         # Extension logging
            └── errors.ts         # Error handling
```

## Dependencies

### Runtime Dependencies
```json
{
  "yaml": "^2.4.0",
  "zod": "^3.23.0",
  "jsonc-parser": "^3.2.0"
}
```

### Dev Dependencies
```json
{
  "@types/vscode": "^1.85.0",
  "@vscode/test-electron": "^2.3.0",
  "@vscode/vsce": "^2.22.0",
  "typescript": "^5.6.0",
  "vitest": "^2.0.0",
  "esbuild": "^0.19.0"
}
```

## Implementation Phases

### Phase 1: Foundation & Explorer (Local Mode Core)
- Extension scaffolding and manifest
- Workflow Explorer tree view
- Basic file operations (create/rename/delete)
- Template library with starter workflows

### Phase 2: Editor Features (Local Mode Core)
- YAML schema integration
- IntelliSense (completions, hover, diagnostics)
- CodeLens for quick actions
- Variable/secret reference support

### Phase 3: Runner (Local Mode)
- Local workflow execution
- Output channel integration
- Environment variable configuration
- Dry-run mode

### Phase 4: Debugger (Local Mode)
- Debug Adapter Protocol implementation
- Breakpoint support (phases/steps)
- Step-through execution
- State inspection (variables, context, outputs)
- Replay from specific step

### Phase 5: Authentication & API
- GitHub OAuth integration
- API client implementation
- Token management
- Progressive authentication flow

### Phase 6: Cloud Dashboard (Cloud Mode)
- Organization overview webview
- Member management
- Usage and billing summary

### Phase 7: Workflow Queue (Cloud Mode)
- Queue tree view
- Status filtering
- Priority management
- Cancel/retry actions

### Phase 8: Integrations (Cloud Mode)
- GitHub App connection status
- Integration configuration
- Webhook management

### Phase 9: Publishing (Cloud Mode)
- Local to cloud sync
- Version management
- Rollback capability
- Diff comparison

### Phase 10: Polish & Marketplace
- Error handling improvements
- Telemetry (opt-in)
- Documentation
- Marketplace publishing

## API Integration Points

### generacy.ai Platform API

| Endpoint | Purpose | Used By |
|----------|---------|---------|
| `POST /auth/login` | OAuth callback | Authentication |
| `GET /orgs/:id` | Organization details | Dashboard |
| `GET /orgs/:id/members` | Member list | Dashboard |
| `GET /orgs/:id/usage` | Usage metrics | Dashboard |
| `GET /queue` | Workflow queue | Queue view |
| `POST /queue/:id/cancel` | Cancel workflow | Queue actions |
| `POST /queue/:id/retry` | Retry workflow | Queue actions |
| `GET /integrations` | Integration status | Integrations view |
| `POST /workflows/publish` | Publish workflow | Publishing |
| `GET /workflows/:id/versions` | Version history | Publishing |

## Key Technical Decisions

1. **Webview for Dashboard**: Using VS Code webviews for rich org dashboard UI
2. **Tree Views for Lists**: Native tree views for workflow explorer and queue
3. **Debug Adapter Protocol**: Full DAP implementation for debugger features
4. **Bundling with esbuild**: Fast builds and small extension size
5. **Progressive Auth**: Graceful degradation without authentication

## Testing Strategy

| Layer | Tool | Focus |
|-------|------|-------|
| Unit | Vitest | Business logic, utilities |
| Integration | @vscode/test-electron | Extension activation, commands |
| E2E | Manual + Playwright | Workflow execution paths |

## Security Considerations

1. **Token Storage**: Use VS Code SecretStorage API for OAuth tokens
2. **API Communication**: HTTPS only, certificate validation
3. **Local Execution**: Sandbox workflow execution where possible
4. **Telemetry**: Opt-in only, no sensitive data

## Configuration

Extension settings:
```json
{
  "generacy.workflowDirectory": ".generacy",
  "generacy.defaultTemplate": "basic",
  "generacy.cloudEndpoint": "https://api.generacy.ai",
  "generacy.telemetry.enabled": false
}
```

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Extension activation | < 500ms | Performance testing |
| YAML validation | < 100ms | Per-file validation |
| Debugger responsiveness | < 50ms | Step/continue operations |
| Marketplace rating | 4+ stars | User reviews |

---

*Generated by speckit*
