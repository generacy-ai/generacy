# Feature Specification: Migrate autodev workflow capabilities to Generacy actions

**Branch**: `157-migrate-autodev-workflow-capabilities` | **Date**: 2026-02-04 | **Status**: Draft

## Summary

## Description

Create Generacy workflow actions that implement the autodev GitHub issue workflow capabilities, including PR management, phase progression, label management, and epic handling.

## Problem

The autodev plugin in claude-plugins provides 23 MCP tools for GitHub issue-driven development workflows. These need to be available as Generacy workflow actions for the new stack.

## Current Autodev MCP Tools (to migrate)

### Core Workflow
| Tool | Purpose |
|------|---------|
| `preflight_check` | Validate environment before workflow |
| `get_feature_context` | Retrieve spec artifacts for context |
| `review_pending_changes` | Review uncommitted changes |
| `commit_and_push` | Commit with issue reference and push |
| `merge_from_base` | Merge from base branch with conflict detection |

### PR Management
| Tool | Purpose |
|------|---------|
| `create_draft_pr` | Create draft PR linking to issue |
| `mark_draft_pr_ready` | Convert draft to ready for review |
| `update_pr_progress` | Update PR description with phase status |
| `read_pr_feedback` | Get unresolved PR comments |
| `respond_pr_feedback` | Post responses to PR comments |

### Phase/Label Management
| Tool | Purpose |
|------|---------|
| `update_phase_labels` | Manage workflow phase labels |
| `check_review_gate` | Check if review gate allows proceeding |
| `manage_clarification_labels` | Handle clarification labels |
| `update_dependency_label` | Manage dependency blocking labels |
| `add_issue_comment` | Post progress comments |
| `update_stage_comment` | Update consolidated stage comments |

### Epic Management
| Tool | Purpose |
|------|---------|
| `post_tasks_summary` | Post task summary for epic review |
| `check_epic_completion` | Check child issue completion status |
| `update_epic_status` | Update epic progress comment |
| `create_epic_pr` | Create rollup PR from epic branch |
| `close_epic_issue` | Close epic after merge |
| `dispatch_children` | Dispatch child issues to queue |

### Infrastructure
| Tool | Purpose |
|------|---------|
| `sync_labels` | Create/update GitHub labels |

## Proposed Solution

### Workflow Actions

Create Generacy actions under `github.*` and `workflow.*` namespaces:

```yaml
# Example workflow using github/workflow actions
name: issue-to-pr
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
      prompt: "Implement the feature described in the issue"
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
      title: ${{ steps.context.outputs.issue_title }}
      
  - id: update_phase
    action: workflow.update_phase
    with:
      issue_number: ${{ steps.preflight.outputs.issue_number }}
      phase: implement
      status: complete
```

### Action Namespaces

**github.*** - GitHub API operations
- `github.preflight` - Environment validation
- `github.get_context` - Retrieve issue/PR context
- `github.commit_and_push` - Commit and push changes
- `github.merge_from_base` - Merge base branch
- `github.create_draft_pr` - Create draft PR
- `github.mark_pr_ready` - Mark PR ready for review
- `github.update_pr` - Update PR description
- `github.read_pr_feedback` - Get PR comments
- `github.respond_pr_feedback` - Reply to PR comments
- `github.add_comment` - Add issue comment

**workflow.*** - Workflow state management
- `workflow.update_phase` - Update phase labels
- `workflow.check_gate` - Check review gate status
- `workflow.update_stage` - Update stage comment
- `workflow.wait_for_gate` - Block until gate passes

**epic.*** - Epic-specific operations
- `epic.post_tasks_summary` - Post task summary
- `epic.check_completion` - Check child status
- `epic.update_status` - Update progress
- `epic.create_pr` - Create rollup PR
- `epic.close` - Close after merge
- `epic.dispatch_children` - Send children to queue

### Orchestrator Integration

The orchestrator needs to support:
1. Issue monitoring (poll for labeled issues)
2. PR feedback monitoring (detect new comments)
3. Job dispatch to workers
4. Phase progression tracking
5. Review gate enforcement

## Use Case

As a workflow author, I want GitHub integration actions so that my workflows can manage issues, PRs, and development lifecycle automatically.

As an orchestrator, I want phase management actions so that workflows can enforce review gates and track progress through the development lifecycle.

## Acceptance Criteria

1. `github.preflight` validates environment and returns issue context
2. `github.commit_and_push` commits with proper message format
3. `github.create_draft_pr` creates PR linked to issue
4. `workflow.update_phase` manages phase labels correctly
5. `workflow.check_gate` returns gate status accurately
6. `epic.dispatch_children` sends children to orchestrator queue
7. All actions handle errors gracefully with meaningful messages
8. Actions work with GitHub App authentication
9. Rate limiting handled appropriately
10. Comprehensive logging for debugging

## Related

- Parent epic: generacy-ai/triad-development#10
- Depends on: #155 (@generacy-ai/generacy npm package)
- Related: Current autodev implementation in claude-plugins/plugins/autodev

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
