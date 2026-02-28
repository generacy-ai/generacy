# Research: Architecture Overview for Adopters

## Existing Documentation Landscape

### Current Architecture Overview
**Path**: `docs/docs/architecture/overview.md` (311 lines)

Contains internal implementation details that should be hidden from adopters:
- Redis + BullMQ queue architecture with Mermaid diagrams
- PostgreSQL for state management
- Worker pool topology (Worker 1, Worker 2, Worker N)
- S3 artifact storage
- Cloud deployment architecture with load balancers and Redis Cluster
- MCP protocol justification
- Message flow showing internal communication channels (REST, WebSocket, MCP)

These details are valuable for contributors but overwhelm adopters. They belong in a separate "internals" page.

### Docusaurus Configuration
- **Mermaid**: Enabled at `docusaurus.config.ts:25` (`markdown.mermaid: true`) and theme at line 28 (`@docusaurus/theme-mermaid`)
- **Mermaid theme**: light: 'neutral', dark: 'dark' (line 132)
- **Sidebar**: TypeScript-based at `sidebars.ts`, Architecture category at lines 103-115
- **Additional languages**: bash, json, typescript, yaml (prism config)

### Sidebar Structure (Architecture Category)
Currently:
```
Architecture/
├── overview     (sidebar_position: 1)
├── contracts
└── security
```

Will become:
```
Architecture/
├── overview     (sidebar_position: 1) — rewritten for adopters
├── internals    (sidebar_position: 2) — new, moved from overview
├── contracts    (sidebar_position: 3)
└── security     (sidebar_position: 4)
```

## Label Protocol — Adopter-Relevant Subset

From the canonical label protocol (`/workspaces/tetrad-development/docs/label-protocol.md`):

### Labels Adopters Add

| Label | When to Add | Effect |
|-------|-------------|--------|
| `process:speckit-feature` | Start feature workflow | Issue queued for full spec-driven development |
| `process:speckit-bugfix` | Start bugfix workflow | Issue queued for streamlined bug fix |
| `completed:clarification` | After answering questions | Resumes workflow from clarification pause |
| `completed:spec-review` | After reviewing spec | Resumes workflow past spec review gate |
| `completed:plan-review` | After reviewing plan | Resumes workflow past plan review gate |
| `completed:tasks-review` | After reviewing tasks | Resumes workflow past tasks review gate |
| `type:epic` | Mark issue as epic | Workflow generates child issues instead of single PR |

### Labels Adopters Observe

| Label | Meaning | Action Required |
|-------|---------|-----------------|
| `agent:in-progress` | Worker actively processing | None — wait |
| `agent:error` | Worker hit unrecoverable error | Check error comment, retry or intervene |
| `waiting-for:clarification` | Questions posted, awaiting answers | Answer questions in comment, add `completed:clarification` |
| `waiting-for:spec-review` | Spec ready for review | Review spec on PR, add `completed:spec-review` |
| `waiting-for:plan-review` | Plan ready for review | Review plan on PR, add `completed:plan-review` |
| `waiting-for:tasks-review` | Tasks ready for review | Review tasks on PR, add `completed:tasks-review` |
| `waiting-for:address-pr-feedback` | PR feedback being addressed | None — system handles automatically |
| `needs:intervention` | Automated processing failed | Human investigation required |

### Labels Omitted (System-Internal)

These are omitted from the adopter overview to reduce noise:
- `phase:specify`, `phase:clarify`, `phase:plan`, `phase:tasks`, `phase:implement`, `phase:validate` — system-managed phase tracking
- `completed:specify`, `completed:clarify`, `completed:plan`, `completed:tasks`, `completed:implement`, `completed:validate` — system-managed completion records (except those adopters add)
- `agent:dispatched`, `agent:paused` — internal worker state
- `waiting-for:clarification-review`, `waiting-for:implementation-review`, `waiting-for:manual-validation`, `waiting-for:children-complete` — less common gates
- `epic-child` — internal epic tracking

## Workflow YAML — Simplified Excerpt

From `workflows/speckit-feature.yaml` (114 lines), a simplified 3-phase excerpt for the overview:

```yaml
name: speckit-feature
version: "1.1.0"

inputs:
  - name: description
    type: string
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

  - name: clarification
    steps:
      - name: clarify
        uses: speckit.clarify
        with:
          feature_dir: ${{ steps.create-feature.output.feature_dir }}
```

Note: The full workflow has 7 phases. This excerpt shows 3 to illustrate the structure.

## Built-in Action Namespaces

Extracted from workflow YAML files and action source code:

| Namespace | Actions | Description |
|-----------|---------|-------------|
| `speckit.*` | `create_feature`, `specify`, `clarify`, `plan`, `tasks`, `implement`, `taskstoissues` | Spec-driven development lifecycle |
| `verification.*` | `check` | Run tests, linting, and other verification commands |
| `github.*` | Label management, PR operations | GitHub API interactions |
| `workflow.*` | `check-gate` | Flow control and gate checking |

## Stage Comments

From `packages/orchestrator/src/worker/stage-comment-manager.ts`:

Three stage comments are maintained per issue, identified by HTML markers:
- `<!-- generacy-stage:specification -->` — covers specify + clarify phases
- `<!-- generacy-stage:planning -->` — covers plan + tasks phases
- `<!-- generacy-stage:implementation -->` — covers implement + validate phases

Each comment shows a progress table with phase name, status, timestamps, and PR link. Comments are updated in-place (edit, not create new) as phases progress.

## Review Cycle — Unified Pattern

All review cycles follow the same pattern:

```
1. System completes a phase
2. System adds `waiting-for:{type}` label
3. System posts a comment explaining what needs review
4. Workflow pauses
5. Adopter reviews the artifact (spec, plan, tasks, or PR)
6. Adopter adds `completed:{type}` label (or leaves PR comments)
7. Monitor detects the label pair → enqueues "continue"
8. Workflow resumes from the next phase
```

Specific review types and what to look for:

| Review Type | Wait Label | Complete Label | Artifact to Review |
|-------------|-----------|---------------|-------------------|
| Clarification | `waiting-for:clarification` | `completed:clarification` | Questions in issue comment — post answers |
| Spec review | `waiting-for:spec-review` | `completed:spec-review` | `spec.md` on draft PR — check requirements |
| Plan review | `waiting-for:plan-review` | `completed:plan-review` | `plan.md` on draft PR — check approach |
| Tasks review | `waiting-for:tasks-review` | `completed:tasks-review` | `tasks.md` on draft PR — check task breakdown |
| PR feedback | `waiting-for:address-pr-feedback` | (automatic) | Standard PR review — leave comments, system addresses them |

## Error Handling — Common Scenarios

From `label-protocol.md` error section and orchestrator implementation:

When an error occurs:
1. `agent:error` label added to issue
2. Error comment posted with: phase, exit code, duration, error details, suggested next steps

**Recovery**: Remove `agent:error` label, then either:
- Add `process:speckit-feature` to retry from the beginning
- Add `completed:{phase}` to skip past the failed phase (if you've fixed the issue manually)

Common scenarios:
- **Timeout** (exit code timeout): Agent exceeded time limit. Consider breaking the task into smaller pieces or increasing the timeout.
- **Context overflow**: Issue requirements too complex for a single pass. Simplify requirements or convert to an epic.
- **Test failures**: Implementation didn't pass verification. Review test output in error comment, fix manually or retry.
- **Merge conflicts**: Feature branch diverged from base. Resolve conflicts on the branch and retry.

## Configuration — Minimal Setup

From Q5 answer, only these essentials belong in the overview:

1. **GitHub webhook URL**: The orchestrator URL that receives GitHub events
2. **Required webhook events**: `issues`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`
3. **Watched repositories YAML**:
```yaml
repositories:
  - owner: your-org
    repo: your-repo
    workflows:
      speckit-feature: true
      speckit-bugfix: true
```
4. **Authentication**: GitHub token (PAT or GitHub App installation token)

Everything else → link to `/docs/reference/config/generacy`
