# Data Model: Migrate autodev workflow capabilities

## Core Entities

### Issue

Represents a GitHub issue being worked on.

```typescript
interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  assignees: string[];
  milestone?: Milestone;
  created_at: string;
  updated_at: string;
}

interface Label {
  name: string;
  color: string;
  description?: string;
}

interface Milestone {
  number: number;
  title: string;
  state: 'open' | 'closed';
}
```

### Pull Request

Represents a GitHub pull request.

```typescript
interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  head: BranchRef;
  base: BranchRef;
  labels: Label[];
  mergeable?: boolean;
  created_at: string;
  updated_at: string;
}

interface BranchRef {
  ref: string;      // Branch name
  sha: string;      // Commit SHA
  repo: string;     // owner/repo
}
```

### Comment

Represents an issue or PR comment.

```typescript
interface Comment {
  id: number;
  body: string;
  author: string;
  created_at: string;
  updated_at: string;
  // PR review comments have additional fields
  path?: string;          // File path
  line?: number;          // Line number
  in_reply_to_id?: number;
  resolved?: boolean;
}
```

## Workflow Entities

### LabelStatus

Tracks workflow labels on an issue.

```typescript
interface LabelStatus {
  currentLabels: string[];
  configuredGates: ReviewGate[];
  waitingFor: string[];          // Labels like 'waiting-for:spec-review'
  completed: string[];           // Labels like 'completed:spec-review'
  blockedByGate: boolean;
  blockingGate?: string;
}

type ReviewGate =
  | 'spec-review'
  | 'clarification'
  | 'clarification-review'
  | 'plan-review'
  | 'tasks-review'
  | 'implementation-review'
  | 'manual-validation'
  | 'address-pr-feedback'
  | 'children-complete';

type CorePhase =
  | 'specify'
  | 'clarify'
  | 'plan'
  | 'tasks'
  | 'implement'
  | 'validate';
```

### EpicContext

Tracks epic relationship information.

```typescript
interface EpicContext {
  is_epic: boolean;
  is_epic_child: boolean;
  parent_epic_number?: number;
  parent_epic_branch?: string;
  children?: EpicChild[];
}

interface EpicChild {
  issue_number: number;
  title: string;
  state: 'open' | 'closed';
  pr_merged: boolean;
  labels: string[];
}

interface EpicCompletionStatus {
  percentage: number;
  ready_for_pr: boolean;
  total_children: number;
  completed_children: number;
  in_progress_children: number;
  blocked_children: number;
  children: EpicChild[];
}
```

### StageProgress

Tracks workflow stage progress for stage comments.

```typescript
interface StageProgress {
  command: string;              // e.g., '/speckit:specify'
  status: 'pending' | 'in_progress' | 'complete';
  summary?: string;
}

type WorkflowStage = 'specification' | 'planning' | 'implementation';

interface StageCommentData {
  issue_number: number;
  stage: WorkflowStage;
  status: 'in_progress' | 'complete' | 'blocked';
  progress: StageProgress[];
  branch?: string;
  pr_number?: number;
  next_step?: string;
  blocked_reason?: string;
}
```

## Action Input/Output Types

### github.preflight

```typescript
interface PreflightInput {
  issue_url: string;
  expected_branch?: string;
}

interface PreflightOutput {
  issue_number: number;
  issue_title: string;
  issue_body: string;
  issue_type: 'feature' | 'bug' | 'epic' | 'unknown';
  issue_labels: string[];
  current_branch: string;
  expected_branch: string;
  branch_exists: boolean;
  on_correct_branch: boolean;
  pr_exists: boolean;
  pr_number?: number;
  uncommitted_changes: boolean;
  unresolved_comments: number;
  speckit_status: SpeckitStatus;
  label_status: LabelStatus;
  existing_branches?: BranchInfo;
  epic_context: EpicContext;
  next_command?: string;
  artifact_warnings: string[];
  cleaned_labels?: CleanedLabels;
}

interface SpeckitStatus {
  spec_exists: boolean;
  plan_exists: boolean;
  tasks_exists: boolean;
}

interface BranchInfo {
  found: boolean;
  branches: Branch[];
  recommended?: Branch;
  has_multiple: boolean;
}

interface CleanedLabels {
  cleaned: string[];
  failed: string[];
  skipped: string[];
}
```

### github.commit_and_push

```typescript
interface CommitAndPushInput {
  message: string;
  issue_number: number;
  files?: string[];           // Specific files, or all if omitted
}

interface CommitAndPushOutput {
  commit_sha: string;
  pushed: boolean;
  files_committed: string[];
}
```

### github.merge_from_base

```typescript
interface MergeFromBaseInput {
  abort_on_conflict?: boolean;
  auto_resolve?: boolean;
  parent_epic_number?: number;
}

interface MergeFromBaseOutput {
  success: boolean;
  base_branch: string;
  merged_from_epic: boolean;
  commits_merged: number;
  already_up_to_date: boolean;
  conflicts_resolved: number;
  conflicts_remaining: ConflictInfo[];
  stash_created: boolean;
  summary: string;
}

interface ConflictInfo {
  path: string;
  ours: string;
  theirs: string;
  resolved?: boolean;
}
```

### github.create_draft_pr

```typescript
interface CreateDraftPRInput {
  issue_number: number;
  title: string;
  body?: string;
  base_branch?: string;
}

interface CreateDraftPROutput {
  pr_number: number;
  pr_url: string;
  state: 'draft';
  head_branch: string;
  base_branch: string;
}
```

### workflow.update_phase

```typescript
interface UpdatePhaseInput {
  issue_number: number;
  phase: CorePhase | ReviewGate;
  action: 'start' | 'complete' | 'block' | 'set_current' | 'add_completion';
}

interface UpdatePhaseOutput {
  success: boolean;
  phase: string;
  action: string;
  labels_added: string[];
  labels_removed: string[];
}
```

### workflow.check_gate

```typescript
interface CheckGateInput {
  issue_number: number;
  phase: ReviewGate;
}

interface CheckGateOutput {
  can_proceed: boolean;
  gate_active: boolean;
  waiting_for?: string;
  completed?: string;
  blocked_reason?: string;
}
```

### workflow.update_stage

```typescript
interface UpdateStageInput {
  issue_number: number;
  stage: WorkflowStage;
  status: 'in_progress' | 'complete' | 'blocked';
  progress: StageProgress[];
  branch?: string;
  pr_number?: number;
  next_step?: string;
  blocked_reason?: string;
}

interface UpdateStageOutput {
  success: boolean;
  comment_id: number;
  comment_url: string;
  created: boolean;         // true if new, false if updated
}
```

### epic.dispatch_children

```typescript
interface DispatchChildrenInput {
  epic_issue_number: number;
  child_issues: number[];
}

interface DispatchChildrenOutput {
  dispatched: number[];
  failed: DispatchFailure[];
  agent_account: string;
}

interface DispatchFailure {
  issue_number: number;
  reason: string;
}
```

## Validation Rules

### Issue URL Validation
- Must be a valid HTTPS URL
- Must match pattern: `https://github.com/{owner}/{repo}/issues/{number}`
- Number must be positive integer

### Label Validation
- Label names are case-sensitive
- Phase labels follow pattern: `phase:{phase}`, `completed:{phase}`, `waiting-for:{gate}`
- Type labels: `type:feature`, `type:bug`, `type:epic`

### Branch Naming
- Feature branches: `{number}-{slug}` (e.g., `157-migrate-autodev`)
- Epic child branches: `{epic_number}-{child_number}-{slug}`

### Commit Message Format
- References issue: `#{issue_number}`
- Max title length: 72 characters
- Body separated by blank line

## Entity Relationships

```
Issue 1───* Label
Issue 1───1 LabelStatus (computed)
Issue 1───0..1 EpicContext
Issue 1───0..1 PullRequest

PullRequest 1───* Comment
PullRequest 1───* Label

Epic (Issue) 1───* EpicChild (Issue)
EpicChild *───1 Epic
```

---

*Generated by speckit*
