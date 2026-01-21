# Quickstart: Generacy VS Code Extension

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Press `Cmd+Shift+X` (macOS) or `Ctrl+Shift+X` (Windows/Linux)
3. Search for "Generacy"
4. Click Install

### From VSIX (Development)

```bash
# Build the extension
cd packages/generacy-extension
npm install
npm run package

# Install in VS Code
code --install-extension generacy-0.1.0.vsix
```

## Getting Started

### 1. Initialize Workflow Directory

Create a `.generacy` directory in your project root:

```bash
mkdir .generacy
```

Or use the command palette:
- Press `Cmd+Shift+P` / `Ctrl+Shift+P`
- Type "Generacy: Initialize"
- Select your project folder

### 2. Create Your First Workflow

Using the Workflow Explorer:
1. Open the Generacy sidebar (click the Generacy icon)
2. Click the "+" button
3. Choose a template or start from scratch
4. Name your workflow

Or create manually:

```yaml
# .generacy/my-workflow.yaml
version: "1.0"
metadata:
  name: My First Workflow
  description: A simple example workflow

phases:
  - id: setup
    name: Setup
    steps:
      - id: greet
        name: Greet User
        action: echo
        inputs:
          message: "Hello, Generacy!"
```

### 3. Run Your Workflow

**Quick Run (no debugging)**:
- Right-click the workflow file in Explorer
- Select "Run Workflow"

Or use the command palette:
- Press `Cmd+Shift+P` / `Ctrl+Shift+P`
- Type "Generacy: Run Workflow"
- Select your workflow

**Dry Run Mode**:
- Press `Cmd+Shift+P` / `Ctrl+Shift+P`
- Type "Generacy: Dry Run"
- Review execution plan without running

### 4. Debug Your Workflow

Set breakpoints:
1. Open your workflow YAML file
2. Click in the gutter next to a step
3. A red dot appears (breakpoint set)

Start debugging:
1. Press `F5` or click "Debug Workflow" in the Explorer
2. Execution pauses at breakpoints
3. Use the Debug toolbar to:
   - Continue (F5)
   - Step Over (F10)
   - Step Into (F11)
   - Step Out (Shift+F11)
4. Inspect variables in the Debug sidebar

## Local Mode Features

### Workflow Explorer

The sidebar shows all workflows in your `.generacy` directory:

```
📁 Workflows
  📄 build-and-test.yaml ✓
  📄 deploy-staging.yaml ✓
  📄 broken-workflow.yaml ✗
```

- ✓ indicates valid workflow
- ✗ indicates validation errors

Right-click for actions:
- Run
- Debug
- Duplicate
- Rename
- Delete

### YAML Editor Features

**IntelliSense**: Type to get suggestions for:
- Phase and step properties
- Action names
- Variable references (`${{ variables.name }}`)

**Hover Info**: Hover over properties to see documentation

**Validation**: Real-time validation with error highlights

**CodeLens**: Quick actions above phases and steps:
- "▶ Run from here"
- "🔴 Toggle breakpoint"

### Environment Variables

Configure environment variables for workflow execution:

1. Open Settings (`Cmd+,` / `Ctrl+,`)
2. Search for "Generacy"
3. Edit `generacy.environment` or create `.generacy/.env`

```ini
# .generacy/.env
API_KEY=your-key-here
DEBUG=true
```

## Cloud Mode Features

### Sign In

1. Click "Sign In" in the Generacy sidebar
2. Authenticate with GitHub
3. Select your organization (if applicable)

### Organization Dashboard

View your organization's:
- Active workflows
- Usage metrics
- Team members
- Billing summary

### Workflow Queue

Monitor cloud workflows:
- Filter by status (pending, running, completed, failed)
- View execution details
- Cancel or retry workflows
- Change priority

### Publishing Workflows

Push local workflows to cloud:

1. Right-click a workflow in Explorer
2. Select "Publish to Cloud"
3. Enter version notes
4. Confirm

Or use command palette:
- "Generacy: Publish Workflow"
- "Generacy: Sync All Workflows"

## Available Commands

| Command | Description | Shortcut |
|---------|-------------|----------|
| Generacy: Initialize | Create .generacy directory | - |
| Generacy: Create Workflow | New workflow from template | - |
| Generacy: Run Workflow | Execute selected workflow | - |
| Generacy: Dry Run | Preview execution without running | - |
| Generacy: Debug Workflow | Start debugging session | F5 |
| Generacy: Publish | Push to cloud | - |
| Generacy: Show Dashboard | Open organization dashboard | - |
| Generacy: Show Queue | Open workflow queue | - |

## Configuration

Access settings via `Preferences > Settings > Generacy`:

| Setting | Default | Description |
|---------|---------|-------------|
| `generacy.workflowDirectory` | `.generacy` | Workflow files location |
| `generacy.defaultTemplate` | `basic` | Default template for new workflows |
| `generacy.cloudEndpoint` | `https://api.generacy.ai` | Cloud API endpoint |
| `generacy.telemetry.enabled` | `false` | Send anonymous usage data |
| `generacy.editor.validateOnSave` | `true` | Validate workflow on save |
| `generacy.debug.showStepOutputs` | `true` | Show step outputs during debug |

## Troubleshooting

### "Workflow directory not found"

Solution: Initialize the workflow directory:
```bash
mkdir .generacy
```

### "Invalid workflow" errors

1. Check the Problems panel (`Cmd+Shift+M` / `Ctrl+Shift+M`)
2. Hover over red underlines for details
3. Common issues:
   - Missing required fields (version, metadata.name, phases)
   - Invalid YAML syntax
   - Unknown action names

### "Authentication failed"

1. Sign out: `Generacy: Sign Out`
2. Clear credentials: `Generacy: Clear Credentials`
3. Sign in again

### Debug session not starting

1. Ensure workflow is valid (no red underlines)
2. Check Output panel (`Generacy Debug`)
3. Try running without debug first

### Slow performance

1. Reduce number of workflows in directory
2. Disable `validateOnSave` if not needed
3. Close unused editor tabs

## Getting Help

- **Documentation**: [docs.generacy.ai](https://docs.generacy.ai)
- **Issues**: [GitHub Issues](https://github.com/generacy-ai/generacy/issues)
- **Community**: [Discord](https://discord.gg/generacy)

---

*Generated by speckit*
