# Quickstart: Debug Adapter Enhancements

## Overview

This feature enhances the Generacy VS Code extension's debug adapter with:
- Proper step-out behavior (pause at next phase)
- Nested variable inspection (expand objects/arrays)
- Error pause support (pause on step failure)

## Installation

No additional installation required. These are enhancements to the existing debug adapter.

## Usage

### Step-Out Debugging

When debugging a workflow:

1. Set a breakpoint in a step within a phase
2. Run the debugger (F5)
3. When paused at a step, click "Step Out" (Shift+F11)
4. Execution continues until the first step of the next phase

**Before**: Step-out was same as Continue (ran to end)
**After**: Step-out pauses at phase boundary

### Inspecting Nested Variables

In the Variables panel during a debug session:

1. Expand any scope (Local, Phase, Workflow, Environment)
2. Objects and arrays now show an expand arrow
3. Click to expand and see immediate children
4. Nested children show as "Object" or "Array(N)" - use Debug Console to inspect deeper

**Example**:
```
▶ config: Object
    host: "localhost"
    port: 8080
    ▶ options: Object    ← Shows as non-expandable (1 level limit)
```

### Error Pause Feature

To enable pause-on-error in your launch configuration:

```json
{
  "type": "generacy",
  "request": "launch",
  "name": "Debug with Error Pause",
  "workflow": "${file}",
  "pauseOnError": true
}
```

When a step fails:
1. Debugger pauses with "Exception" reason
2. View error details in the Call Stack
3. Choose action:
   - Click Continue (F5) to skip the failed step
   - Click Stop (Shift+F5) to abort

## Launch Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `workflow` | string | `${file}` | Path to workflow YAML file |
| `stopOnEntry` | boolean | `true` | Pause at first step |
| `pauseOnError` | boolean | `false` | Pause when step fails |
| `env` | object | `{}` | Additional environment variables |
| `dryRun` | boolean | `false` | Dry run mode (no actual execution) |

## Example launch.json

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "generacy",
      "request": "launch",
      "name": "Debug Workflow",
      "workflow": "${file}",
      "stopOnEntry": true,
      "pauseOnError": true
    },
    {
      "type": "generacy",
      "request": "launch",
      "name": "Run Workflow (No Debug)",
      "workflow": "${file}",
      "stopOnEntry": false,
      "pauseOnError": false
    }
  ]
}
```

## Troubleshooting

### Step-Out Not Pausing

**Symptom**: Step-out runs to workflow end instead of pausing at next phase
**Cause**: You're in the last phase of the workflow
**Solution**: This is expected behavior - there's no next phase to pause at

### Variables Not Expanding

**Symptom**: Click expand arrow but nothing happens
**Cause**: Object is at depth limit (1 level) or empty
**Solution**: Use Debug Console to evaluate deeper paths: `config.options.timeout`

### Error Pause Not Working

**Symptom**: Step fails but debugger terminates instead of pausing
**Cause**: `pauseOnError` not set or set to `false`
**Solution**: Add `"pauseOnError": true` to launch configuration

### Skip Step Not Continuing

**Symptom**: After error pause, Continue doesn't move to next step
**Cause**: Step marked the workflow as failed internally
**Solution**: This is a bug - please report if encountered
