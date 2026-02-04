# Quickstart: GitHub Workflow Actions

## Installation

The GitHub workflow actions are built into the `@generacy-ai/workflow-engine` package.

```bash
pnpm add @generacy-ai/workflow-engine
```

## Prerequisites

- **gh CLI**: GitHub CLI must be installed and authenticated
  ```bash
  gh auth status  # Verify authentication
  ```
- **Git**: Git must be available in PATH
- **Repository**: Must be run from within a Git repository

## Usage in Workflows

### Basic Issue-to-PR Workflow

```yaml
name: issue-to-pr
on:
  issues:
    types: [labeled]

steps:
  - id: preflight
    action: github.preflight
    with:
      issue_url: ${{ inputs.issue_url }}

  - id: context
    action: github.get_context
    with:
      issue_number: ${{ steps.preflight.outputs.issue_number }}

  - id: develop
    action: agent.invoke
    with:
      prompt: "Implement the feature"
      context: ${{ steps.context.outputs }}

  - id: commit
    action: github.commit_and_push
    with:
      message: "feat: implement feature"
      issue_number: ${{ steps.preflight.outputs.issue_number }}

  - id: create_pr
    action: github.create_draft_pr
    with:
      issue_number: ${{ steps.preflight.outputs.issue_number }}
      title: "feat: ${{ steps.context.outputs.issue_title }}"
```

### Phase Management

```yaml
steps:
  # Update to next phase
  - id: update_phase
    action: workflow.update_phase
    with:
      issue_number: 42
      phase: plan
      action: set_current

  # Check review gate
  - id: check_gate
    action: workflow.check_gate
    with:
      issue_number: 42
      phase: spec-review

  - if: ${{ steps.check_gate.outputs.can_proceed }}
    # Continue with next phase...
```

### Epic Workflow

```yaml
steps:
  # Check epic completion
  - id: epic_status
    action: epic.check_completion
    with:
      epic_issue_number: 10

  - if: ${{ steps.epic_status.outputs.ready_for_pr }}
    id: create_epic_pr
    action: epic.create_pr
    with:
      epic_issue_number: 10
      title: "Epic: Full feature implementation"
```

## Available Actions

### github.* namespace

| Action | Description |
|--------|-------------|
| `github.preflight` | Validate environment before workflow |
| `github.get_context` | Retrieve spec artifacts for context |
| `github.review_changes` | Review uncommitted changes |
| `github.commit_and_push` | Commit and push changes |
| `github.merge_from_base` | Merge from base branch |
| `github.create_draft_pr` | Create draft PR |
| `github.mark_pr_ready` | Mark PR ready for review |
| `github.update_pr` | Update PR description |
| `github.read_pr_feedback` | Get PR comments |
| `github.respond_pr_feedback` | Reply to PR comments |
| `github.add_comment` | Add issue comment |
| `github.sync_labels` | Sync workflow labels |

### workflow.* namespace

| Action | Description |
|--------|-------------|
| `workflow.update_phase` | Update workflow phase labels |
| `workflow.check_gate` | Check review gate status |
| `workflow.update_stage` | Update stage comment |

### epic.* namespace

| Action | Description |
|--------|-------------|
| `epic.post_tasks_summary` | Post task summary to issue |
| `epic.check_completion` | Check child issue status |
| `epic.update_status` | Update epic progress |
| `epic.create_pr` | Create rollup PR |
| `epic.close` | Close epic after merge |
| `epic.dispatch_children` | Dispatch children to queue |

## Programmatic Usage

```typescript
import { WorkflowExecutor } from '@generacy-ai/workflow-engine';

const executor = new WorkflowExecutor();

// Execute a single action
const result = await executor.executeAction('github.preflight', {
  issue_url: 'https://github.com/owner/repo/issues/42'
});

console.log(result.output.issue_number); // 42
console.log(result.output.label_status);
```

## Troubleshooting

### gh CLI not authenticated

```
Error: gh: not logged in to any GitHub hosts
```

**Solution**: Run `gh auth login` to authenticate.

### Rate limit exceeded

```
Error: API rate limit exceeded
```

**Solution**: Wait for rate limit reset or use GitHub App authentication.

### Branch not found

```
Error: Branch '42-feature' not found
```

**Solution**: Ensure the branch was created. Use `github.preflight` to check branch status.

### Merge conflicts

```
Error: MERGE_CONFLICT - conflicts in: src/file.ts
```

**Solution**: Resolve conflicts manually or use `merge_from_base` with `auto_resolve: true`.

## Configuration

### Custom GitHub Client

For GitHub App authentication (cloud workers):

```typescript
import { OctokitGitHubClient } from '@generacy-ai/workflow-engine';

const client = new OctokitGitHubClient({
  appId: process.env.GITHUB_APP_ID,
  privateKey: process.env.GITHUB_PRIVATE_KEY,
  installationId: process.env.GITHUB_INSTALLATION_ID,
});

const executor = new WorkflowExecutor({
  github: client,
});
```

### Label Configuration

Labels can be customized via `.generacy/labels.yaml`:

```yaml
phases:
  - specify
  - clarify
  - plan
  - tasks
  - implement
  - validate

gates:
  - spec-review
  - plan-review
  - tasks-review
  - implementation-review

prefixes:
  phase: "phase:"
  completed: "completed:"
  waiting: "waiting-for:"
  needs: "needs:"
```

---

*Generated by speckit*
