# Tasks to Issues Workflow

Convert tasks.md into backlog tickets with human review checkpoint.

## Overview

This workflow automates the process of converting tasks defined in a `tasks.md` file into backlog issues (GitHub Issues, Jira tickets, Shortcut stories, or local files). It includes a human review checkpoint to ensure all issues are reviewed before creation.

## Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `feature_dir` | string | Yes | - | Feature directory containing tasks.md |
| `grouping` | enum | No | `per-task` | How to group tasks into issues |
| `provider` | enum | No | auto-detect | Backlog provider to use |
| `dry_run` | boolean | No | `false` | Preview only, don't create issues |

### Grouping Strategies

- **per-task**: Create one issue per task (most granular)
- **per-story**: Group tasks by user story into single issues
- **per-phase**: Group tasks by implementation phase (Setup, Core, Tests, etc.)

### Provider Options

- **github**: Create GitHub Issues
- **jira**: Create Jira tickets
- **shortcut**: Create Shortcut stories
- **local**: Create local markdown files in `issues/` directory

When not specified, the provider is auto-detected:
1. Check for `.github/` directory → GitHub
2. Check for `.jira/` or `jira.config.json` → Jira
3. Check for `shortcut.json` → Shortcut
4. Default to `local` (file-based)

## Workflow Steps

1. **parse_tasks** - Resolve file paths from the feature directory
2. **validate_tasks** - Check for circular dependencies and missing references
3. **preview** - Generate a dry-run preview of issues to be created
4. **review** - Human approval checkpoint (waits indefinitely)
5. **create** - Create the actual issues if approved and not in dry-run mode

## Outputs

```yaml
outputs:
  issues:
    - id: "42"           # Issue identifier
      url: "https://..."  # Full URL to the issue
      title: "..."        # Issue title
      provider: "github"  # Provider type used
```

### Provider-Specific Output Formats

**GitHub**:
```yaml
id: "42"                # Issue number
url: "https://github.com/owner/repo/issues/42"
provider: "github"
```

**Jira**:
```yaml
id: "PROJ-123"          # Issue key
url: "https://domain.atlassian.net/browse/PROJ-123"
provider: "jira"
```

**Shortcut**:
```yaml
id: "12345"             # Story ID
url: "https://app.shortcut.com/workspace/story/12345"
provider: "shortcut"
```

**Local**:
```yaml
id: "local-1"           # Generated ID
url: "file:///path/to/issues/local-1.md"
provider: "local"
```

## Triggers

The workflow can be triggered by:

### 1. Manual Invocation

From the Generacy CLI:
```bash
generacy workflow run tasks-to-issues --feature-dir specs/my-feature/
```

From the Generacy UI:
- Navigate to the feature directory
- Click "Run Workflow" → "Tasks to Issues"

### 2. Workflow Step

As part of a larger SDLC workflow:
```yaml
steps:
  - id: create_tasks
    action: speckit.tasks
    with:
      feature_dir: ${{ inputs.feature_dir }}

  - id: create_issues
    action: workflow.run
    with:
      workflow: tasks-to-issues
      inputs:
        feature_dir: ${{ inputs.feature_dir }}
        grouping: per-story
```

### 3. Event Trigger

Triggered when tasks.md is committed:
```yaml
triggers:
  - type: file_commit
    pattern: "specs/*/tasks.md"
    workflow: tasks-to-issues
    inputs:
      feature_dir: ${{ trigger.file.directory }}
```

## Usage Examples

### Basic Usage

Create one issue per task with auto-detected provider:
```bash
generacy workflow run tasks-to-issues \
  --feature-dir specs/my-feature/
```

### Grouped by Story

Create issues grouped by user story:
```bash
generacy workflow run tasks-to-issues \
  --feature-dir specs/my-feature/ \
  --grouping per-story
```

### Dry Run Preview

Preview issues without creating them:
```bash
generacy workflow run tasks-to-issues \
  --feature-dir specs/my-feature/ \
  --dry-run true
```

### Specific Provider

Force a specific provider:
```bash
generacy workflow run tasks-to-issues \
  --feature-dir specs/my-feature/ \
  --provider jira
```

### Complete Example

```bash
# Preview first
generacy workflow run tasks-to-issues \
  --feature-dir specs/user-auth/ \
  --grouping per-phase \
  --dry-run true

# Review the preview, then create
generacy workflow run tasks-to-issues \
  --feature-dir specs/user-auth/ \
  --grouping per-phase \
  --provider github
```

## Error Handling

The workflow uses a **fail-fast** approach:

- If any step fails, the entire workflow stops
- Partial issue creation is avoided (all or nothing)
- Clear error messages are provided for debugging

Common errors:

| Error | Cause | Solution |
|-------|-------|----------|
| "Feature directory not found" | Invalid path | Check the feature_dir path |
| "tasks.md not found" | Missing file | Ensure tasks.md exists in the directory |
| "Circular dependency detected" | Task A → B → A | Fix the dependency chain in tasks.md |
| "Provider authentication failed" | Missing credentials | Run provider auth (e.g., `gh auth login`) |

## Dependencies

- **Agency spec-kit plugin**: Provides the `tasks_to_issues` tool
- **Humancy plugin**: Provides the human review checkpoint
- **Provider credentials**: GitHub CLI, Jira API token, or Shortcut API token

## Related Workflows

- `speckit:specify` - Create specification from requirements
- `speckit:plan` - Generate implementation plan
- `speckit:tasks` - Generate tasks from plan
