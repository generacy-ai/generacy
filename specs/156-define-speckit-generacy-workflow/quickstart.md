# Quickstart: Speckit Workflow Actions

## Overview

Speckit actions enable specification-driven development in Generacy workflows. They implement the speckit methodology:

```
specify → clarify → plan → tasks → implement
```

## Installation

The speckit actions are built into the workflow-engine package. No additional installation required.

```bash
# Verify workflow-engine is available
pnpm list @generacy/workflow-engine
```

## Quick Example

```yaml
# .generacy.yaml
name: feature-development
description: Develop a new feature using speckit methodology

inputs:
  - name: description
    description: Feature description
    required: true

phases:
  - name: setup
    steps:
      - name: create-feature
        uses: speckit.create_feature
        with:
          description: ${{ inputs.description }}

  - name: specification
    steps:
      - name: specify
        uses: speckit.specify
        with:
          feature_dir: ${{ steps.create-feature.output.feature_dir }}
        gate: spec-review

      - name: clarify
        uses: speckit.clarify
        with:
          feature_dir: ${{ steps.create-feature.output.feature_dir }}
        gate: clarification-review

  - name: planning
    steps:
      - name: plan
        uses: speckit.plan
        with:
          feature_dir: ${{ steps.create-feature.output.feature_dir }}
        gate: plan-review

      - name: tasks
        uses: speckit.tasks
        with:
          feature_dir: ${{ steps.create-feature.output.feature_dir }}
        gate: tasks-review

  - name: implementation
    steps:
      - name: implement
        uses: speckit.implement
        with:
          feature_dir: ${{ steps.create-feature.output.feature_dir }}
        gate: implementation-review
```

## Available Actions

### speckit.create_feature

Creates a new feature branch and initializes the spec directory.

```yaml
- name: setup
  uses: speckit.create_feature
  with:
    description: "Add user authentication with OAuth"
    short_name: "oauth-auth"    # optional
    number: 42                   # optional
```

**Outputs**:
- `branch_name`: Created branch name (e.g., `042-oauth-auth`)
- `feature_dir`: Path to feature directory
- `spec_file`: Path to generated spec.md
- `git_branch_created`: Whether git branch was created

### speckit.get_paths

Retrieves all paths for a feature directory.

```yaml
- name: get-paths
  uses: speckit.get_paths
  with:
    branch: "042-oauth-auth"  # optional, auto-detects from current branch
```

**Outputs**:
- `featureDir`: Feature directory path
- `specFile`, `planFile`, `tasksFile`: Artifact paths
- `exists`: Whether feature directory exists

### speckit.check_prereqs

Validates that required artifacts exist before proceeding.

```yaml
- name: validate
  uses: speckit.check_prereqs
  with:
    require_spec: true
    require_plan: true
```

**Outputs**:
- `valid`: Whether all prerequisites are met
- `availableDocs`: List of existing documents
- `errors`: Validation error messages

### speckit.copy_template

Copies template files to the feature directory.

```yaml
- name: copy-templates
  uses: speckit.copy_template
  with:
    templates: ["plan", "tasks", "checklist"]
    feature_dir: ${{ steps.setup.output.feature_dir }}
```

**Outputs**:
- `copied`: Files that were copied
- `skipped`: Files that already existed

### speckit.specify

Generates a feature specification using AI.

```yaml
- name: specify
  uses: speckit.specify
  with:
    feature_dir: ${{ steps.setup.output.feature_dir }}
    issue_url: "https://github.com/org/repo/issues/42"  # optional
    timeout: 300  # seconds
  gate: spec-review
```

**Outputs**:
- `spec_file`: Path to generated spec.md
- `summary`: Brief summary of the spec
- `user_stories_count`: Number of user stories generated

### speckit.clarify

Identifies clarification questions and posts to GitHub.

```yaml
- name: clarify
  uses: speckit.clarify
  with:
    feature_dir: ${{ steps.setup.output.feature_dir }}
    issue_number: 42  # optional, posts questions to this issue
    timeout: 300
  gate: clarification-review
```

**Outputs**:
- `questions_count`: Number of questions generated
- `questions`: Array of question objects
- `posted_to_issue`: Whether questions were posted to GitHub

### speckit.plan

Generates an implementation plan.

```yaml
- name: plan
  uses: speckit.plan
  with:
    feature_dir: ${{ steps.setup.output.feature_dir }}
    timeout: 600
  gate: plan-review
```

**Outputs**:
- `plan_file`: Path to generated plan.md
- `artifacts_created`: List of created artifacts (research.md, data-model.md, etc.)
- `technologies`: Identified technologies

### speckit.tasks

Generates a task list from the plan.

```yaml
- name: tasks
  uses: speckit.tasks
  with:
    feature_dir: ${{ steps.setup.output.feature_dir }}
    timeout: 300
  gate: tasks-review
```

**Outputs**:
- `tasks_file`: Path to generated tasks.md
- `task_count`: Number of tasks generated
- `phases`: List of task phases

### speckit.implement

Implements tasks from the task list.

```yaml
- name: implement
  uses: speckit.implement
  with:
    feature_dir: ${{ steps.setup.output.feature_dir }}
    task_filter: "Phase 1*"  # optional, filter specific tasks
    timeout: 600  # per task
  gate: implementation-review
```

**Outputs**:
- `tasks_completed`: Number of tasks completed
- `tasks_total`: Total number of tasks
- `files_modified`: List of modified files
- `tests_passed`: Whether tests pass after implementation

## Using Gates

Gates pause workflow execution for human review.

```yaml
- name: specify
  uses: speckit.specify
  with:
    feature_dir: ${{ steps.setup.output.feature_dir }}
  gate: spec-review  # Pauses here until approved
```

### Available Gate Types

| Gate | Pauses After |
|------|--------------|
| `spec-review` | speckit.specify |
| `clarification-review` | speckit.clarify |
| `plan-review` | speckit.plan |
| `tasks-review` | speckit.tasks |
| `implementation-review` | speckit.implement |

### Approving Gates

Gates can be approved via:
1. GitHub labels (`completed:spec-review`)
2. API call to workflow engine
3. CLI command: `generacy approve <workflow-id> --gate spec-review`

## Output Access

Access outputs from previous steps using interpolation:

```yaml
- name: setup
  uses: speckit.create_feature
  with:
    description: "New feature"

- name: specify
  uses: speckit.specify
  with:
    # Access output from 'setup' step
    feature_dir: ${{ steps.setup.output.feature_dir }}
```

### Output Access Patterns

```yaml
# Direct field access
${{ steps.setup.output.feature_dir }}

# Nested object access
${{ steps.setup.output.config.version }}

# Array access
${{ steps.plan.output.technologies[0] }}

# Exit code
${{ steps.build.exitCode }}

# Raw stdout
${{ steps.shell.raw }}
```

## Workflow Templates

Copy these templates to get started:

### Standard Feature Development

```bash
cp workflows/speckit-feature.yaml .generacy.yaml
```

### Epic with Child Issues

```bash
cp workflows/speckit-epic.yaml .generacy.yaml
```

### Simplified Bug Fix

```bash
cp workflows/speckit-bugfix.yaml .generacy.yaml
```

## Running Workflows

```bash
# Run with input
generacy run --input description="Add OAuth authentication"

# Run specific phase
generacy run --phase specification

# Resume after gate approval
generacy resume <workflow-id>
```

## Troubleshooting

### "Feature directory not found"

Ensure you're on a feature branch matching the pattern `###-name`:

```bash
git checkout -b 001-my-feature
# or
export SPECIFY_FEATURE=001-my-feature
```

### "Gate timeout"

Gates wait indefinitely by default. To approve:

```bash
# Via CLI
generacy approve <workflow-id> --gate plan-review

# Via GitHub label
# Add label: completed:plan-review
```

### "Agent timeout"

Increase timeout for AI operations:

```yaml
- name: plan
  uses: speckit.plan
  with:
    feature_dir: ${{ steps.setup.output.feature_dir }}
    timeout: 900  # 15 minutes
```

### "Prerequisites not met"

Ensure required artifacts exist before running dependent steps:

```yaml
- name: check
  uses: speckit.check_prereqs
  with:
    require_spec: true
    require_plan: true

- name: tasks
  uses: speckit.tasks
  condition: ${{ steps.check.output.valid }}
  with:
    feature_dir: ${{ steps.setup.output.feature_dir }}
```

---

*Generated by speckit*
