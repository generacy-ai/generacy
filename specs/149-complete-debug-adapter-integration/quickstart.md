# Quickstart: Debug Adapter Integration

## Overview

This feature wires the VS Code debug adapter (DAP) to the real workflow step executor, replacing placeholder simulation with actual step execution. After this integration, debugging a workflow in VS Code will run real actions and show real variable state.

## Usage

### Setting a Breakpoint

1. Open a workflow YAML file in VS Code
2. Click in the gutter next to a step definition to set a breakpoint
3. The breakpoint appears as a red dot

### Starting a Debug Session

1. Open the workflow YAML file
2. Press `F5` or click "Run and Debug" in the sidebar
3. Select "Generacy: Debug Workflow" configuration
4. The debugger starts and pauses at the first step (if `stopOnEntry` is true)

### Debug Controls

| Control | Shortcut | Behavior |
|---------|----------|----------|
| Continue | F5 | Resume to next breakpoint or completion |
| Step Over | F10 | Execute current step, pause at next step (any phase) |
| Step Into | F11 | Enter nested workflow (same as Step Over if not nested) |
| Step Out | Shift+F11 | Complete remaining steps in current phase, pause at next phase |
| Pause | F6 | Pause execution at next step boundary |
| Stop | Shift+F5 | Terminate the debug session |

### Inspecting Variables

When paused at a breakpoint, the Variables panel shows three scopes:
- **Inputs**: Current step's input parameters (from `with:` config)
- **Outputs**: Step outputs (current + previous steps)
- **Workflow**: Global workflow variables and environment

### Watch Expressions

Add watch expressions using dot-notation:
- `step.output.status` — access a field of the current step's output
- `outputs.myStep.result` — access a previous step's output
- `env.API_KEY` — access an environment variable
- `variables.counter` — access a workflow variable

### Error Behavior

By default, the debugger pauses on step errors (like an exception breakpoint). To disable:

```json
{
  "type": "generacy-workflow",
  "request": "launch",
  "name": "Debug Workflow",
  "workflow": "${file}",
  "pauseOnError": false
}
```

### Replay

The replay controller uses cached execution results from the history panel:
1. Run a workflow in debug mode (at least partially)
2. Open the History panel to see execution entries
3. Right-click an entry → "Replay from here"
4. A new debug session starts from that point using cached results

## Launch Configuration

Add to `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "generacy-workflow",
      "request": "launch",
      "name": "Debug Workflow",
      "workflow": "${file}",
      "stopOnEntry": true,
      "pauseOnError": true
    }
  ]
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `workflow` | string | required | Path to workflow YAML file |
| `stopOnEntry` | boolean | `true` | Pause at first step |
| `pauseOnError` | boolean | `true` | Pause when step fails |
| `dryRun` | boolean | `false` | Parse workflow without executing |

## Troubleshooting

**Breakpoints not hitting**: Ensure the breakpoint is set on a step line in the YAML file. Phase-level breakpoints are supported but must be on the phase declaration line.

**Variables not showing**: Variables populate after step execution. If paused before a step runs (stopOnEntry), the Inputs scope shows the step's configuration and the Outputs scope is empty.

**Step execution hangs**: Check step timeout configuration. The executor enforces timeouts at both the action and step level. Default timeout is inherited from the workflow definition.

**Error not pausing**: Verify `pauseOnError` is `true` in your launch configuration. If the step has `continueOnError: true`, the error is logged but execution continues without pausing.
