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

## Workflow Structure — T003 Extraction

Source: `workflows/speckit-feature.yaml` (114 lines, version 1.1.0)

### 7-Phase Structure

| # | Phase Name | Action(s) Used | Purpose | Notes |
|---|-----------|----------------|---------|-------|
| 1 | `setup` | `speckit.create_feature` | Creates feature branch and spec directory | Takes `description` and optional `short_name` |
| 2 | `specification` | `speckit.specify` | Generates spec from description | After completion: orchestrator commits, pushes, creates draft PR |
| 3 | `clarification` | `speckit.clarify` | Posts questions, integrates answers | In headless mode: posts to issue, exits; orchestrator pauses via gate |
| 4 | `planning` | `speckit.plan` | Generates implementation plan | Consumes feature_dir from setup |
| 5 | `task-generation` | `speckit.tasks` | Generates task breakdown | Consumes feature_dir from setup |
| 6 | `implementation` | `speckit.implement` | Executes implementation | 1-hour timeout (`3600000` ms) |
| 7 | `verification` | `verification.check` (×2) | Runs tests and lint | Two steps: `npm test` + `npm run lint`, both with `continueOnError: true` |

### YAML Structure

The workflow YAML has these top-level keys:

| Key | Type | Description |
|-----|------|-------------|
| `name` | `string` | Workflow identifier (e.g., `speckit-feature`) |
| `description` | `string` (multiline) | Human-readable description of what the workflow does |
| `version` | `string` | Semantic version (e.g., `"1.1.0"`) |
| `inputs` | `array` | Workflow parameters, each with `name`, `description`, `type`, `required` |
| `phases` | `array` | Ordered execution phases |

Each **phase** has:

| Key | Type | Description |
|-----|------|-------------|
| `name` | `string` | Phase identifier (e.g., `setup`, `specification`) |
| `steps` | `array` | Ordered steps within the phase |
| `condition` | `string` (optional) | Expression guard (e.g., `${{ success() }}` in bugfix workflow) |

Each **step** has:

| Key | Type | Description |
|-----|------|-------------|
| `name` | `string` | Step identifier (e.g., `create-feature`, `specify`) |
| `uses` | `string` | Action reference in `namespace.action` format |
| `with` | `object` | Input parameters, supports `${{ }}` interpolation |
| `timeout` | `number` (optional) | Max execution time in milliseconds |
| `continueOnError` | `boolean` (optional) | If true, step failure doesn't halt the phase |
| `gate` | `string` (optional) | Review gate name (seen in epic workflow, e.g., `spec-review`) |

### Interpolation Syntax

Uses `${{ }}` expressions to reference:
- `inputs.<name>` — workflow input parameters (e.g., `${{ inputs.description }}`)
- `steps.<step-name>.output.<field>` — output from a prior step (e.g., `${{ steps.create-feature.output.feature_dir }}`)
- `success()` — function checking if previous phases succeeded

### Minimal Excerpt for Customization Section

A 3-phase excerpt showing the core YAML structure (setup → specification → clarification):

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

> Simplified for illustration — the full workflow has 7 phases. See `workflows/speckit-feature.yaml` for the complete definition.

### Built-in Action Namespaces

Extracted from all workflow YAML files (`speckit-feature`, `speckit-bugfix`, `speckit-epic`, `tasks-to-issues`):

| Namespace | Actions | Description |
|-----------|---------|-------------|
| `speckit.*` | `create_feature`, `specify`, `clarify`, `plan`, `tasks`, `implement`, `taskstoissues` | Spec-driven development lifecycle — from feature creation through implementation |
| `verification.*` | `check` | Run verification commands (tests, linting) with configurable `command` and `continueOnError` |
| `pr.*` | `create` | PR creation with `title`, `body`, `draft` parameters (used in bugfix workflow) |
| `shell` | (direct command) | Run arbitrary shell commands (used in epic workflow for `gh` CLI calls) |
| `agent.*` | `invoke` | Invoke AI agent with a prompt (used in tasks-to-issues for validation) |
| `humancy.*` | `request_review` | Human review checkpoint with `artifact` and `context` (used in tasks-to-issues) |
| `spec_kit.*` | `get_paths`, `tasks_to_issues` | Spec toolkit utilities (used in tasks-to-issues workflow) |

**Note for overview doc**: Per plan, only these four namespaces should appear in the adopter-facing overview:
- `speckit.*` — specification, clarification, planning, tasks, implementation
- `verification.*` — test and lint checking
- `github.*` — label management, PR operations
- `workflow.*` — gate checking, flow control

The `pr.*`, `shell`, `agent.*`, `humancy.*`, and `spec_kit.*` namespaces are used in specific workflows but aren't part of the primary adopter-facing action API. The `github.*` and `workflow.*` namespaces referenced in the plan likely map to orchestrator-level actions not directly visible in workflow YAML files (they're invoked by the orchestrator infrastructure, not by workflow authors).

## Stage Comments — T004 Extraction

From `packages/orchestrator/src/worker/stage-comment-manager.ts` and `types.ts`:

### Stage Structure

Three stage comments are maintained per issue, identified by HTML markers:
- `<!-- generacy-stage:specification -->` — covers specify + clarify phases
- `<!-- generacy-stage:planning -->` — covers plan + tasks phases
- `<!-- generacy-stage:implementation -->` — covers implement + validate phases

Each stage has a display title with emoji prefix:
- Specification stage: "📋 Specification"
- Planning stage: "📐 Planning"
- Implementation stage: "🔨 Implementation"

### Comment Format

Each stage comment renders as a markdown table with metadata:

```markdown
## 📋 Specification Stage

| Phase | Status | Started | Completed |
|-------|--------|---------|-----------|
| specify | ✅ complete | 2026-02-28T10:15:00Z | 2026-02-28T10:45:00Z |
| clarify | 🔄 in_progress | 2026-02-28T10:46:00Z | — |

**Status**: 🔄 In Progress
**Started**: 2026-02-28T10:15:00Z
**PR**: https://github.com/org/repo/pull/123
```

### Status Icons

| Status | Icon | Label |
|--------|------|-------|
| `pending` | ⏳ | (raw status shown) |
| `in_progress` | 🔄 | In Progress |
| `complete` | ✅ | Complete |
| `error` | ❌ | Error |

### Behavior

- Comments are found via HTML marker search, or created if not found
- Updates edit existing comments in-place (never create duplicates)
- Timestamps use ISO 8601 format
- PR URL appears on implementation stage (and planning stage once PR is created)
- Phase progress tracks: phase name, status, startedAt, completedAt

### Phase-to-Stage Mapping (from types.ts)

| Phase | Stage |
|-------|-------|
| `specify` | specification |
| `clarify` | specification |
| `plan` | planning |
| `tasks` | planning |
| `implement` | implementation |
| `validate` | implementation |

## Phase Resolver — T004 Extraction

From `packages/orchestrator/src/worker/phase-resolver.ts` and `types.ts`:

### Phase Sequence

Default phase sequence (feature/bugfix workflows):
`specify → clarify → plan → tasks → implement → validate`

Epic workflow sequence:
`specify → clarify → plan → tasks` (no implement/validate — epics create child issues)

### Gate-to-Phase Mapping

Global gate mapping (applies to feature and bugfix workflows):

| Gate Name | Owning Phase | Resume From |
|-----------|-------------|-------------|
| `clarification` | clarify | plan |
| `spec-review` | specify | clarify |
| `clarification-review` | clarify | plan |
| `plan-review` | plan | tasks |
| `tasks-review` | tasks | implement |
| `implementation-review` | implement | validate |
| `manual-validation` | validate | validate |

Epic workflow overrides:

| Gate Name | Owning Phase | Resume From | Notes |
|-----------|-------------|-------------|-------|
| `tasks-review` | tasks | tasks | Triggers child issue creation instead of implement |
| `children-complete` | tasks | tasks | Routes to epic-complete command |
| `epic-approval` | tasks | tasks | Routes to epic-close |

### Resolution Logic

The phase resolver handles two command types:

**`process` command** (initial trigger):
1. If a `phase:*` label exists → resume from that phase
2. If `completed:*` labels exist → find next uncompleted phase (gate names normalized to phase names)
3. No phase labels → start from `specify`

**`continue` command** (after review gate satisfied):
1. Match `completed:*` labels against gate mapping
2. Most advanced gate wins (latest in phase sequence)
3. Return the gate's `resumeFrom` phase
4. Fallback: use process resolver logic

### Adopter-Relevant Gate Summary

These are the gates adopters interact with (omitting system-internal gates):

| You Complete | System Was Waiting At | Workflow Resumes With |
|-------------|----------------------|----------------------|
| `completed:clarification` | clarify phase | plan phase |
| `completed:spec-review` | specify phase | clarify phase |
| `completed:plan-review` | plan phase | tasks phase |
| `completed:tasks-review` | tasks phase | implement phase |
| PR review comments | implement phase | (auto-addresses feedback) |

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

## T005 — Intro Page and Sidebar Consistency Review

### Progressive Adoption Levels (intro.md lines 52-61)

The intro defines four levels:
- Level 1: Agency only (local agent enhancement)
- Level 2: Agency + Humancy (add human oversight)
- Level 3: Full Local (complete local stack)
- Level 4: Cloud (team/enterprise deployment)

The overview.md correctly scopes itself to "Level 3+" (line 7) and links to Level 1 and Level 2 guides (line 9). The internals.md has a consistent progressive adoption table (lines 210-219).

### Sidebar Structure (sidebars.ts lines 103-115)

The Architecture category already has the correct structure:
- `architecture/overview`
- `architecture/internals` (already present at line 112)
- `architecture/contracts`
- `architecture/security`

This matches the plan's specified order.

### Fix Applied

`internals.md` frontmatter had `sidebar_position: 4` but is listed second in the sidebar items array. Changed to `sidebar_position: 2` for consistency. (The items array takes precedence over frontmatter position, but the frontmatter should match to avoid confusion.)
