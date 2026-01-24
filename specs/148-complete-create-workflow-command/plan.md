# Implementation Plan: Complete Create Workflow Command

**Feature**: Complete the "Create Workflow" command implementation for the VS Code extension
**Branch**: `148-complete-create-workflow-command`
**Status**: Complete

## Summary

This feature implements the "Create Workflow" command that allows users to create new workflow YAML files from templates via the VS Code command palette. The implementation is **fully complete** and verified.

## Technical Context

### Language & Framework
- **Language**: TypeScript
- **Platform**: VS Code Extension API
- **Build**: Webpack bundling with npm scripts
- **Testing**: Vitest with vscode module mocking

### Dependencies
- `vscode` - VS Code extension API
- `yaml` - YAML parsing (in tree provider)
- `path` - Node.js path utilities

## Project Structure

```
packages/generacy-extension/
├── src/
│   ├── commands/
│   │   ├── workflow.ts           # Create/rename/delete/duplicate commands
│   │   ├── index.ts              # Command registration
│   │   └── __tests__/
│   │       └── workflow.test.ts  # Unit tests
│   ├── views/
│   │   └── local/
│   │       └── explorer/
│   │           ├── templates.ts   # TemplateManager and QuickPick UI
│   │           ├── provider.ts    # WorkflowTreeProvider with file watcher
│   │           ├── tree-item.ts   # Tree item definitions
│   │           └── index.ts       # Re-exports
│   ├── constants/
│   │   └── index.ts              # COMMANDS, WORKFLOW_TEMPLATES constants
│   └── utils/
│       ├── logger.ts             # Logging utility
│       ├── config.ts             # Configuration wrapper
│       └── error.ts              # Custom error types
└── resources/
    └── templates/
        ├── basic.yaml
        ├── multi-phase.yaml
        └── with-triggers.yaml
```

## Architecture

### Component Design

```
┌────────────────────────────────────────────────────────────────┐
│                     Command Handler Layer                       │
│  workflow.ts: createWorkflow(), renameWorkflow(), etc.         │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│                    Template Manager Layer                       │
│  templates.ts: TemplateManager, showTemplateQuickPick()        │
│  - Loads templates from extension resources                     │
│  - Provides QuickPick with live YAML preview                   │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│                    VS Code API Layer                            │
│  vscode.workspace.fs: File operations                          │
│  vscode.window: QuickPick, InputBox, Text Editor               │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│                   File System Layer                             │
│  .generacy/workflows/: Workflow YAML files                     │
└────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Command Invocation**: User triggers "Generacy: New Workflow" from command palette
2. **Template Selection**: QuickPick displays templates with preview panel
3. **Name Input**: User provides workflow name with validation
4. **File Creation**: Template content written to `.generacy/workflows/<name>.yaml`
5. **Editor Open**: New file automatically opens in editor
6. **Explorer Refresh**: File watcher triggers tree view update

## Implementation Details

### Key Files

| File | Purpose |
|------|---------|
| `workflow.ts:17-101` | `createWorkflow()` - Main command implementation |
| `templates.ts:67-185` | `TemplateManager` - Template loading and caching |
| `templates.ts:224-293` | `showTemplateQuickPick()` - Selection UI with preview |
| `provider.ts:67-105` | File watcher setup for auto-refresh |
| `index.ts:26-101` | Command registration with error handling |

### Validation Rules
- Name must start with a letter
- Name can contain letters, numbers, hyphens, underscores
- Maximum 64 characters
- No duplicate names allowed

### Template Library
| Template | Description |
|----------|-------------|
| basic | Single phase with simple steps |
| multi-phase | Setup, build, and deploy phases |
| with-triggers | Webhook and schedule triggers |

## Test Coverage

Unit tests in `workflow.test.ts` cover:
- Template selection flow (lines 211-218)
- Name input validation (lines 421-448)
- File creation with correct content (lines 236-260)
- Rename, delete, duplicate operations (lines 284-418)
- Edge cases for copy numbering (lines 392-418)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| File system race conditions | Use VS Code's atomic file operations |
| Template loading failure | Graceful error handling with user feedback |
| Name collisions | Pre-check file existence before creation |

## Future Considerations

- Custom template creation (out of scope)
- Template import from remote sources (out of scope)
- Multi-file workflow templates (out of scope)

---

*Generated by speckit*
