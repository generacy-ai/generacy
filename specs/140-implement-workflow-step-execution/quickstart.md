# Quickstart: Workflow Step Execution Engine

## Prerequisites

Before using the workflow execution engine, ensure you have:

1. **VS Code** with the Generacy extension installed
2. **Git** configured in your workspace
3. **Claude Code CLI** installed (`claude --version`)
4. **GitHub CLI** installed and authenticated (`gh auth status`)

## Basic Workflow Execution

### 1. Create a Workflow File

Create a file named `workflow.generacy.yaml` in your workspace:

```yaml
name: my-first-workflow
version: "1.0.0"
description: A simple workflow to test execution

phases:
  - name: main
    steps:
      - name: setup-branch
        uses: workspace.prepare
        with:
          branch: feature/test-execution

      - name: run-agent
        uses: agent.invoke
        with:
          prompt: "Create a simple hello world function in src/hello.ts"

      - name: verify-tests
        uses: verification.check
        with:
          command: npm test

      - name: create-pr
        uses: pr.create
        with:
          title: "Add hello world function"
          body: "Created by workflow execution"
          draft: true
```

### 2. Run the Workflow

- Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
- Run: `Generacy: Run Workflow`
- Select your workflow file

### 3. Monitor Execution

The Generacy Runner output channel shows real-time progress:

```
[12:00:00] Starting workflow: my-first-workflow
[12:00:00] ▸ Phase: main (1/1)
[12:00:00]   ▸ Step: setup-branch (1/4)
[12:00:01]   ✓ Step completed in 1.2s
[12:00:01]   ▸ Step: run-agent (2/4)
[12:01:30]   ✓ Step completed in 89.5s
...
```

## Action Types

### workspace.prepare

Git branch operations:

```yaml
- name: setup
  uses: workspace.prepare
  with:
    branch: feature/new-feature      # Branch to create/checkout
    baseBranch: main                  # Optional: base branch
    force: false                      # Optional: force checkout
```

**Output:**
```json
{
  "branch": "feature/new-feature",
  "previousBranch": "main",
  "created": true
}
```

### agent.invoke

Invoke Claude Code CLI:

```yaml
- name: implement
  uses: agent.invoke
  with:
    prompt: "Implement the UserService class"
    allowedTools: ["Read", "Write", "Edit"]  # Optional
    timeout: 300                              # Optional: seconds
    maxTurns: 10                              # Optional
```

**Output:**
```json
{
  "summary": "Created UserService with CRUD operations",
  "filesModified": ["src/services/user.ts", "src/types.ts"],
  "turns": 5
}
```

### verification.check

Run tests or linting:

```yaml
- name: test
  uses: verification.check
  with:
    command: npm test
    expectedExitCode: 0  # Optional, default is 0
```

**Output:**
```json
{
  "passed": true,
  "output": "Test Suites: 5 passed...",
  "testsPassed": 42,
  "testsFailed": 0
}
```

### pr.create

Create a GitHub pull request:

```yaml
- name: open-pr
  uses: pr.create
  with:
    title: "Add new feature"
    body: |
      ## Summary
      This PR adds the new feature.
    base: main          # Optional
    draft: true         # Optional
    labels:             # Optional
      - enhancement
    reviewers:          # Optional
      - teammate
```

**Output:**
```json
{
  "number": 42,
  "url": "https://github.com/owner/repo/pull/42",
  "state": "draft"
}
```

## Variable Interpolation

Reference values from previous steps:

```yaml
phases:
  - name: build
    steps:
      - name: setup-branch
        uses: workspace.prepare
        with:
          branch: feature/auto-${inputs.issueNumber}

      - name: implement
        uses: agent.invoke
        with:
          prompt: "Fix issue #${inputs.issueNumber}"

      - name: create-pr
        uses: pr.create
        with:
          title: "Fixes #${inputs.issueNumber}"
          body: |
            Branch: ${steps.setup-branch.output.branch}
            Agent Summary: ${steps.implement.output.summary}
```

### Supported Patterns

| Pattern | Description |
|---------|-------------|
| `${inputs.name}` | Workflow input parameter |
| `${steps.stepId.output}` | Full step output |
| `${steps.stepId.output.field}` | Specific field from output |
| `${env.VAR_NAME}` | Environment variable |

## Retry Configuration

Add retry logic to individual steps:

```yaml
- name: flaky-step
  uses: verification.check
  with:
    command: npm test
  retry:
    max_attempts: 3
    delay: 10s
    backoff: exponential
    max_delay: 5m
```

### Backoff Strategies

| Strategy | Behavior |
|----------|----------|
| `constant` | Same delay every retry |
| `linear` | delay * attempt |
| `exponential` | delay * 2^(attempt-1) |

## Timeout Configuration

Set timeouts at different levels:

```yaml
# Workflow-level (applies to all)
timeout: 30m

phases:
  - name: main
    # Phase-level
    timeout: 15m
    steps:
      - name: long-running
        uses: agent.invoke
        # Step-level (highest priority)
        timeout: 5m
```

## Debugging Workflows

### Enable Debug Mode

1. Open workflow file
2. Set breakpoints by clicking line numbers on steps
3. Run: `Generacy: Debug Workflow`

### Debug Controls

- **Continue** (`F5`): Run to next breakpoint
- **Step Over** (`F10`): Execute current step, pause at next
- **Stop** (`Shift+F5`): Cancel execution

### Inspect Variables

At breakpoints, hover over step names to see:
- Input values after interpolation
- Previous step outputs
- Current environment

## Troubleshooting

### "Claude Code CLI not found"

```bash
# Verify installation
claude --version

# If not installed, see:
# https://docs.claude.ai/claude-code/installation
```

### "gh: command not found"

```bash
# Install GitHub CLI
# macOS
brew install gh

# Windows
winget install --id GitHub.cli

# Authenticate
gh auth login
```

### "Step timed out"

Increase the timeout in your workflow:

```yaml
- name: slow-step
  uses: agent.invoke
  timeout: 10m  # Increase from default
```

### "Variable not found: ${steps.X.output.Y}"

1. Check step name matches exactly
2. Verify previous step completed successfully
3. Check output field exists in step result

---

*Generated by speckit*
