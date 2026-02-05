/**
 * github.preflight action - validates environment before workflow execution.
 * Parses issue URL, detects branch state, analyzes labels, and checks prerequisites.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  PreflightInput,
  PreflightOutput,
  LabelStatus,
  SpeckitStatus,
  EpicContext,
  BranchLookupResult,
  ParsedIssueUrl,
  ReviewGate,
  CorePhase,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from './client/index.js';
import { createGitHubClient } from './client/index.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Parse a GitHub issue URL into owner, repo, and number
 */
export function parseGitHubIssueUrl(url: string): ParsedIssueUrl {
  const match = url.match(/https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid GitHub issue URL: ${url}`);
  }
  return {
    owner: match[1]!,
    repo: match[2]!,
    number: parseInt(match[3]!, 10),
  };
}

/**
 * Analyze labels to determine workflow status
 */
function analyzeLabelStatus(labels: string[]): LabelStatus {
  const waitingFor: string[] = [];
  const completed: string[] = [];
  const configuredGates: ReviewGate[] = [];

  for (const label of labels) {
    if (label.startsWith('waiting-for:')) {
      waitingFor.push(label.replace('waiting-for:', ''));
    } else if (label.startsWith('completed:')) {
      completed.push(label.replace('completed:', ''));
    } else if (label.startsWith('needs:')) {
      const gate = label.replace('needs:', '') as ReviewGate;
      if (!configuredGates.includes(gate)) {
        configuredGates.push(gate);
      }
    }
  }

  // Check if blocked by any gate
  let blockedByGate = false;
  let blockingGate: string | undefined;

  for (const gate of configuredGates) {
    if (waitingFor.includes(gate) && !completed.includes(gate)) {
      blockedByGate = true;
      blockingGate = gate;
      break;
    }
  }

  return {
    currentLabels: labels,
    configuredGates,
    waitingFor,
    completed,
    blockedByGate,
    blockingGate,
  };
}

/**
 * Detect issue type from labels
 */
function detectIssueType(labels: string[]): 'feature' | 'bug' | 'epic' | 'unknown' {
  for (const label of labels) {
    if (label === 'type:epic' || label === 'epic') return 'epic';
    if (label === 'type:bug' || label === 'bug') return 'bug';
    if (label === 'type:feature' || label === 'feature' || label === 'enhancement') return 'feature';
  }
  return 'unknown';
}

/**
 * Determine the current phase from labels
 */
function getCurrentPhase(labels: string[]): CorePhase | undefined {
  for (const label of labels) {
    if (label.startsWith('phase:')) {
      return label.replace('phase:', '') as CorePhase;
    }
  }
  return undefined;
}

/**
 * Determine the next command based on completed phases and artifacts
 */
function determineNextCommand(
  labelStatus: LabelStatus,
  speckitStatus: SpeckitStatus,
  currentPhase: CorePhase | undefined
): string | undefined {
  // Check if blocked by gate
  if (labelStatus.blockedByGate) {
    return undefined; // Blocked, no next command
  }

  // Determine based on what exists
  if (!speckitStatus.spec_exists) {
    return '/speckit:specify';
  }

  // Check if clarify is needed (based on labels)
  if (!labelStatus.completed.includes('clarification') &&
      !labelStatus.completed.includes('clarify')) {
    // Check if clarifications exist
    return '/speckit:clarify';
  }

  if (!speckitStatus.plan_exists) {
    return '/speckit:plan';
  }

  if (!speckitStatus.tasks_exists) {
    return '/speckit:tasks';
  }

  // If all artifacts exist, implement
  if (currentPhase === 'implement' || currentPhase === 'tasks') {
    return '/speckit:implement';
  }

  return undefined;
}

/**
 * github.preflight action handler
 */
export class PreflightAction extends BaseAction {
  readonly type: ActionIdentifier = 'github.preflight';

  private client: GitHubClient | undefined;

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'github.preflight' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get input
    const issueUrl = this.getRequiredInput<string>(step, context, 'issue_url');
    const expectedBranchOverride = this.getInput<string>(step, context, 'expected_branch');

    context.logger.info(`Preflight check for: ${issueUrl}`);

    try {
      // Parse issue URL
      const { owner, repo, number } = parseGitHubIssueUrl(issueUrl);

      // Get GitHub client
      this.client = createGitHubClient(context.workdir);

      // Fetch issue details
      const issue = await this.client.getIssue(owner, repo, number);
      const labelNames = issue.labels.map(l => l.name);

      // Detect issue type
      const issueType = detectIssueType(labelNames);

      // Get current branch and expected branch
      const currentBranch = await this.client.getCurrentBranch();
      const expectedBranch = expectedBranchOverride ?? this.generateExpectedBranch(number, issue.title);

      // Check if branch exists
      const branchExists = await this.client.branchExists(expectedBranch) ||
                          await this.client.branchExists(expectedBranch, true);

      // Check if on correct branch
      const onCorrectBranch = currentBranch === expectedBranch ||
                              currentBranch.startsWith(`${number}-`);

      // Check for existing PR
      const existingPR = await this.client.findPRForBranch(owner, repo, currentBranch);
      const prExists = existingPR !== null;
      const prNumber = existingPR?.number;

      // Get unresolved comments count
      let unresolvedComments = 0;
      if (prNumber) {
        try {
          const comments = await this.client.getPRComments(owner, repo, prNumber);
          unresolvedComments = comments.filter(c => c.resolved === false).length;
        } catch {
          // Ignore errors fetching comments
        }
      }

      // Check for uncommitted changes
      const status = await this.client.getStatus();
      const uncommittedChanges = status.has_changes;

      // Check speckit artifact status
      const speckitStatus = await this.checkSpeckitStatus(number, context.workdir);

      // Analyze labels
      const labelStatus = analyzeLabelStatus(labelNames);

      // Check epic context
      const epicContext = this.detectEpicContext(issue.body, labelNames);

      // Find existing branches for this issue
      const existingBranches = await this.findExistingBranches(number);

      // Get current phase
      const currentPhase = getCurrentPhase(labelNames);

      // Determine next command
      const nextCommand = determineNextCommand(labelStatus, speckitStatus, currentPhase);

      // Build output
      const output: PreflightOutput = {
        issue_number: number,
        issue_title: issue.title,
        issue_body: issue.body,
        issue_type: issueType,
        issue_labels: labelNames,
        current_branch: currentBranch,
        expected_branch: expectedBranch,
        branch_exists: branchExists,
        on_correct_branch: onCorrectBranch,
        pr_exists: prExists,
        pr_number: prNumber,
        uncommitted_changes: uncommittedChanges,
        unresolved_comments: unresolvedComments,
        speckit_status: speckitStatus,
        label_status: labelStatus,
        existing_branches: existingBranches,
        epic_context: epicContext,
        next_command: nextCommand,
        artifact_warnings: [],
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Generate expected branch name from issue number and title
   */
  private generateExpectedBranch(number: number, title: string): string {
    // Slugify the title
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);
    return `${number}-${slug}`;
  }

  /**
   * Check speckit artifact status
   */
  private async checkSpeckitStatus(issueNumber: number, workdir: string): Promise<SpeckitStatus> {
    // Look for specs directory
    const specsDir = join(workdir, 'specs');
    if (!existsSync(specsDir)) {
      return { spec_exists: false, plan_exists: false, tasks_exists: false };
    }

    // Find the feature directory
    const { readdirSync } = await import('node:fs');
    const dirs = readdirSync(specsDir);
    const featureDir = dirs.find(d => d.startsWith(`${issueNumber}-`));

    if (!featureDir) {
      return { spec_exists: false, plan_exists: false, tasks_exists: false };
    }

    const featurePath = join(specsDir, featureDir);
    return {
      spec_exists: existsSync(join(featurePath, 'spec.md')),
      plan_exists: existsSync(join(featurePath, 'plan.md')),
      tasks_exists: existsSync(join(featurePath, 'tasks.md')),
    };
  }

  /**
   * Detect epic context from issue body and labels
   */
  private detectEpicContext(body: string, labels: string[]): EpicContext {
    const isEpic = labels.includes('type:epic') || labels.includes('epic');

    // Check for epic parent marker
    const parentMatch = body.match(/<!--\s*epic-parent:\s*(\d+)\s*-->/);
    const isEpicChild = parentMatch !== null;
    const parentEpicNumber = parentMatch ? parseInt(parentMatch[1]!, 10) : undefined;

    // Extract parent epic branch if present
    const branchMatch = body.match(/<!--\s*epic-branch:\s*([^\s]+)\s*-->/);
    const parentEpicBranch = branchMatch ? branchMatch[1] : undefined;

    return {
      is_epic: isEpic,
      is_epic_child: isEpicChild,
      parent_epic_number: parentEpicNumber,
      parent_epic_branch: parentEpicBranch,
    };
  }

  /**
   * Find existing branches for an issue number
   */
  private async findExistingBranches(issueNumber: number): Promise<BranchLookupResult> {
    // This is a simplified implementation
    // In practice, you'd use git branch -a and filter
    const currentBranch = await this.client!.getCurrentBranch();

    const branches = [];
    if (currentBranch.startsWith(`${issueNumber}-`)) {
      branches.push({
        name: currentBranch,
        issueNumber: String(issueNumber),
        shortName: currentBranch.replace(`${issueNumber}-`, ''),
        isRemote: false,
      });
    }

    return {
      found: branches.length > 0,
      branches,
      recommended: branches[0],
      has_multiple: branches.length > 1,
    };
  }
}
