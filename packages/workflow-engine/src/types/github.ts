/**
 * GitHub types for workflow actions.
 * Defines interfaces for GitHub entities used by github.*, workflow.*, and epic.* actions.
 */

// =============================================================================
// Core GitHub Entities
// =============================================================================

/**
 * GitHub label representation
 */
export interface Label {
  name: string;
  color: string;
  description?: string;
}

/**
 * GitHub milestone representation
 */
export interface Milestone {
  number: number;
  title: string;
  state: 'open' | 'closed';
}

/**
 * GitHub issue representation
 */
export interface Issue {
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

/**
 * Branch reference for PRs
 */
export interface BranchRef {
  ref: string;      // Branch name
  sha: string;      // Commit SHA
  repo: string;     // owner/repo
}

/**
 * GitHub pull request representation
 */
export interface PullRequest {
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

/**
 * Issue or PR comment representation
 */
export interface Comment {
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

// =============================================================================
// Workflow Entities
// =============================================================================

/**
 * Review gate types
 */
export type ReviewGate =
  | 'spec-review'
  | 'clarification'
  | 'clarification-review'
  | 'plan-review'
  | 'tasks-review'
  | 'implementation-review'
  | 'manual-validation'
  | 'address-pr-feedback'
  | 'children-complete';

/**
 * Core workflow phases
 */
export type CorePhase =
  | 'specify'
  | 'clarify'
  | 'plan'
  | 'tasks'
  | 'implement'
  | 'validate';

/**
 * Workflow stages for stage comments
 */
export type WorkflowStage = 'specification' | 'planning' | 'implementation';

/**
 * Label status tracking for workflow
 */
export interface LabelStatus {
  currentLabels: string[];
  configuredGates: ReviewGate[];
  waitingFor: string[];          // Labels like 'waiting-for:spec-review'
  completed: string[];           // Labels like 'completed:spec-review'
  blockedByGate: boolean;
  blockingGate?: string;
}

/**
 * Stage progress item for stage comments
 */
export interface StageProgress {
  command: string;              // e.g., '/speckit:specify'
  status: 'pending' | 'in_progress' | 'complete';
  summary?: string;
}

/**
 * Stage comment data structure
 */
export interface StageCommentData {
  issue_number: number;
  stage: WorkflowStage;
  status: 'in_progress' | 'complete' | 'blocked';
  progress: StageProgress[];
  branch?: string;
  pr_number?: number;
  next_step?: string;
  blocked_reason?: string;
}

// =============================================================================
// Epic Entities
// =============================================================================

/**
 * Epic child issue summary
 */
export interface EpicChild {
  issue_number: number;
  title: string;
  state: 'open' | 'closed';
  pr_merged: boolean;
  labels: string[];
}

/**
 * Epic context information
 */
export interface EpicContext {
  is_epic: boolean;
  is_epic_child: boolean;
  parent_epic_number?: number;
  parent_epic_branch?: string;
  children?: EpicChild[];
}

/**
 * Epic completion status
 */
export interface EpicCompletionStatus {
  percentage: number;
  ready_for_pr: boolean;
  total_children: number;
  completed_children: number;
  in_progress_children: number;
  blocked_children: number;
  children: EpicChild[];
}

// =============================================================================
// Action Input/Output Types
// =============================================================================

/**
 * Branch information
 */
export interface BranchInfo {
  name: string;
  issueNumber?: string;
  shortName?: string;
  isRemote: boolean;
  lastCommitDate?: string;
}

/**
 * Branch lookup result
 */
export interface BranchLookupResult {
  found: boolean;
  branches: BranchInfo[];
  recommended?: BranchInfo;
  has_multiple: boolean;
}

/**
 * Speckit artifact status
 */
export interface SpeckitStatus {
  spec_exists: boolean;
  plan_exists: boolean;
  tasks_exists: boolean;
}

/**
 * Cleaned labels result
 */
export interface CleanedLabels {
  cleaned: string[];
  failed: string[];
  skipped: string[];
}

/**
 * github.preflight input
 */
export interface PreflightInput {
  issue_url: string;
  expected_branch?: string;
}

/**
 * github.preflight output
 */
export interface PreflightOutput {
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
  existing_branches?: BranchLookupResult;
  epic_context: EpicContext;
  next_command?: string;
  artifact_warnings: string[];
  cleaned_labels?: CleanedLabels;
}

/**
 * github.get_context input
 */
export interface GetContextInput {
  issue_number: number;
  parent_epic_number?: number;
  issue_body?: string;
}

/**
 * github.get_context output
 */
export interface GetContextOutput {
  spec?: string;
  plan?: string;
  tasks?: string;
  phase: CorePhase;
  feature_dir: string;
  epic_context?: {
    parent_spec?: string;
    parent_plan?: string;
    parent_tasks?: string;
  };
}

/**
 * github.review_changes input
 */
export interface ReviewChangesInput {
  include_untracked?: boolean;
}

/**
 * File change info
 */
export interface FileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  staged: boolean;
}

/**
 * github.review_changes output
 */
export interface ReviewChangesOutput {
  has_changes: boolean;
  files: FileChange[];
  summary: string;
}

/**
 * github.commit_and_push input
 */
export interface CommitAndPushInput {
  message: string;
  issue_number: number;
  files?: string[];           // Specific files, or all if omitted
}

/**
 * github.commit_and_push output
 */
export interface CommitAndPushOutput {
  commit_sha: string;
  pushed: boolean;
  files_committed: string[];
}

/**
 * Conflict information for merge operations
 */
export interface ConflictInfo {
  path: string;
  ours: string;
  theirs: string;
  resolved?: boolean;
}

/**
 * github.merge_from_base input
 */
export interface MergeFromBaseInput {
  abort_on_conflict?: boolean;
  auto_resolve?: boolean;
  parent_epic_number?: number;
}

/**
 * github.merge_from_base output
 */
export interface MergeFromBaseOutput {
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

/**
 * github.create_draft_pr input
 */
export interface CreateDraftPRInput {
  issue_number: number;
  title: string;
  body?: string;
  base_branch?: string;
}

/**
 * github.create_draft_pr output
 */
export interface CreateDraftPROutput {
  pr_number: number;
  pr_url: string;
  state: 'draft';
  head_branch: string;
  base_branch: string;
}

/**
 * github.mark_pr_ready input
 */
export interface MarkPRReadyInput {
  pr_number: number;
}

/**
 * github.mark_pr_ready output
 */
export interface MarkPRReadyOutput {
  success: boolean;
  pr_number: number;
  pr_url: string;
}

/**
 * github.update_pr input
 */
export interface UpdatePRInput {
  issue_number?: number;
  pr_number?: number;
  title?: string;
  body?: string;
}

/**
 * github.update_pr output
 */
export interface UpdatePROutput {
  pr_number: number;
  pr_url: string;
  updated: boolean;
}

/**
 * github.read_pr_feedback input
 */
export interface ReadPRFeedbackInput {
  pr_number: number;
  include_resolved?: boolean;
}

/**
 * github.read_pr_feedback output
 */
export interface ReadPRFeedbackOutput {
  comments: Comment[];
  has_unresolved: boolean;
  unresolved_count: number;
}

/**
 * Response to post for PR feedback
 */
export interface FeedbackResponse {
  comment_id: number;
  body: string;
}

/**
 * github.respond_pr_feedback input
 */
export interface RespondPRFeedbackInput {
  pr_number: number;
  responses: FeedbackResponse[];
}

/**
 * Posted response result
 */
export interface PostedResponse {
  comment_id: number;
  reply_id: number;
  success: boolean;
}

/**
 * github.respond_pr_feedback output
 */
export interface RespondPRFeedbackOutput {
  posted: PostedResponse[];
  failed: number[];
}

/**
 * github.add_comment input
 */
export interface AddCommentInput {
  issue_number: number;
  body: string;
  phase?: CorePhase;
}

/**
 * github.add_comment output
 */
export interface AddCommentOutput {
  comment_id: number;
  comment_url: string;
}

/**
 * workflow.update_phase input
 */
export interface UpdatePhaseInput {
  issue_number: number;
  phase: CorePhase | ReviewGate;
  action: 'start' | 'complete' | 'block' | 'set_current' | 'add_completion';
}

/**
 * workflow.update_phase output
 */
export interface UpdatePhaseOutput {
  success: boolean;
  phase: string;
  action: string;
  labels_added: string[];
  labels_removed: string[];
}

/**
 * workflow.check_gate input
 */
export interface CheckGateInput {
  issue_number: number;
  phase: ReviewGate;
}

/**
 * workflow.check_gate output
 */
export interface CheckGateOutput {
  can_proceed: boolean;
  gate_active: boolean;
  waiting_for?: string;
  completed?: string;
  blocked_reason?: string;
}

/**
 * workflow.update_stage input
 */
export interface UpdateStageInput {
  issue_number: number;
  stage: WorkflowStage;
  status: 'in_progress' | 'complete' | 'blocked';
  progress: StageProgress[];
  branch?: string;
  pr_number?: number;
  next_step?: string;
  blocked_reason?: string;
}

/**
 * workflow.update_stage output
 */
export interface UpdateStageOutput {
  success: boolean;
  comment_id: number;
  comment_url: string;
  created: boolean;         // true if new, false if updated
}

/**
 * A single task parsed from tasks.md
 */
export interface ParsedTask {
  /** Task identifier (e.g., 'T007') */
  task_id: string;
  /** Task title */
  title: string;
  /** Task description body */
  description: string;
  /** Issue type label (e.g., 'feature', 'bugfix') */
  type?: string;
  /** Additional labels to apply to the created issue */
  labels?: string[];
}

/**
 * speckit.tasks_to_issues input
 */
export interface TasksToIssuesInput {
  /** Path to the feature directory containing tasks.md */
  feature_dir: string;
  /** The epic issue number (parent) */
  epic_issue_number: number;
  /** The epic branch name for child issues to reference */
  epic_branch: string;
  /** Trigger label to apply to created child issues (default: 'process:speckit-feature') */
  trigger_label?: string;
}

/**
 * A successfully created child issue
 */
export interface CreatedIssue {
  /** The created issue number */
  issue_number: number;
  /** The issue title */
  title: string;
  /** The task ID this issue was created from */
  task_id: string;
}

/**
 * A skipped child issue (already existed)
 */
export interface SkippedIssue {
  /** The existing issue number */
  issue_number: number;
  /** The issue title */
  title: string;
  /** The task ID this issue corresponds to */
  task_id: string;
}

/**
 * A task that failed to create an issue
 */
export interface FailedTask {
  /** The task ID that failed */
  task_id: string;
  /** The task title */
  title: string;
  /** Reason for failure */
  reason: string;
}

/**
 * speckit.tasks_to_issues output
 */
export interface TasksToIssuesOutput {
  /** Issues that were successfully created */
  created_issues: CreatedIssue[];
  /** Issues that were skipped (already existed) */
  skipped_issues: SkippedIssue[];
  /** Tasks that failed to create issues */
  failed_tasks: FailedTask[];
  /** Total number of tasks parsed from tasks.md */
  total_tasks: number;
}

/**
 * epic.post_tasks_summary input
 */
export interface PostTasksSummaryInput {
  issue_number: number;
  feature_dir?: string;
  grouping_strategy?: 'per-task' | 'per-story' | 'per-phase';
}

/**
 * epic.post_tasks_summary output
 */
export interface PostTasksSummaryOutput {
  comment_id: number;
  comment_url: string;
  task_count: number;
  grouping_used: string;
}

/**
 * epic.check_completion input
 */
export interface CheckCompletionInput {
  epic_issue_number: number;
}

/**
 * epic.check_completion output
 */
export interface CheckCompletionOutput {
  percentage: number;
  ready_for_pr: boolean;
  total_children: number;
  completed_children: number;
  in_progress_children: number;
  blocked_children: number;
  children: EpicChild[];
}

/**
 * epic.update_status input
 */
export interface UpdateStatusInput {
  epic_issue_number: number;
  force_update?: boolean;
}

/**
 * epic.update_status output
 */
export interface UpdateStatusOutput {
  comment_id: number;
  comment_url: string;
  updated: boolean;
}

/**
 * epic.create_pr input
 */
export interface CreateEpicPRInput {
  epic_issue_number: number;
  title?: string;
  skip_approval_label?: boolean;
}

/**
 * epic.create_pr output
 */
export interface CreateEpicPROutput {
  pr_number: number;
  pr_url: string;
  commits_included: number;
  children_merged: number;
}

/**
 * epic.close input
 */
export interface CloseEpicInput {
  epic_issue_number: number;
  pr_number?: number;
}

/**
 * epic.close output
 */
export interface CloseEpicOutput {
  closed: boolean;
  issue_url: string;
}

/**
 * Dispatch failure info
 */
export interface DispatchFailure {
  issue_number: number;
  reason: string;
}

/**
 * epic.dispatch_children input
 */
export interface DispatchChildrenInput {
  epic_issue_number: number;
  child_issues: number[];
}

/**
 * epic.dispatch_children output
 */
export interface DispatchChildrenOutput {
  dispatched: number[];
  failed: DispatchFailure[];
  agent_account: string;
}

/**
 * github.sync_labels input
 */
export interface SyncLabelsInput {
  dry_run?: boolean;
}

/**
 * Label sync result
 */
export interface LabelSyncResult {
  name: string;
  action: 'created' | 'updated' | 'unchanged';
}

/**
 * github.sync_labels output
 */
export interface SyncLabelsOutput {
  created: string[];
  updated: string[];
  unchanged: string[];
  results: LabelSyncResult[];
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Action error codes
 */
export type ActionErrorCode =
  | 'VALIDATION_ERROR'
  | 'GITHUB_NOT_FOUND'
  | 'GITHUB_RATE_LIMIT'
  | 'GITHUB_AUTH_ERROR'
  | 'GITHUB_CONFLICT'
  | 'MERGE_CONFLICT'
  | 'NETWORK_ERROR'
  | 'GIT_ERROR'
  | 'UNKNOWN_ERROR';

/**
 * Structured action error
 */
export interface ActionError {
  code: ActionErrorCode;
  message: string;
  recoverable: boolean;
  retryAfter?: number;      // For rate limits
  details?: {
    conflicts?: string[];   // For merge conflicts
    missing?: string[];     // For not found errors
  };
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * GitHub issue URL parsing result
 */
export interface ParsedIssueUrl {
  owner: string;
  repo: string;
  number: number;
}

/**
 * GitHub repository info
 */
export interface RepoInfo {
  owner: string;
  repo: string;
  default_branch: string;
}
