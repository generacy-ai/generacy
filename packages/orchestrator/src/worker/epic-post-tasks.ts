/**
 * Epic post-tasks handler.
 *
 * After the tasks phase completes for an epic workflow, this handler:
 * 1. Parses tasks.md and creates child GitHub issues (via executeTasksToIssues)
 * 2. Dispatches children by adding trigger labels and assigning to agent
 * 3. Posts a tasks summary comment on the epic issue
 * 4. Adds `waiting-for:children-complete` label to pause the epic
 *
 * All operations are deterministic — no Claude CLI is needed.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  executeTasksToIssues,
} from '@generacy-ai/workflow-engine';
import type {
  TasksToIssuesOutput,
  ActionContext,
} from '@generacy-ai/workflow-engine';
import type { WorkerContext, Logger } from './types.js';

/**
 * Result returned by EpicPostTasks.execute()
 */
export interface EpicPostTasksResult {
  /** Issue numbers of successfully created or already-existing child issues */
  childIssues: number[];
  /** Whether all post-tasks steps completed successfully */
  success: boolean;
  /** Output from the tasks-to-issues operation */
  tasksToIssuesOutput?: TasksToIssuesOutput;
}

/** Default trigger label applied to child issues */
const DEFAULT_TRIGGER_LABEL = 'process:speckit-feature';

/** Label applied to dispatched child issues */
const DISPATCHED_LABEL = 'agent:dispatched';

/** Default agent account to assign child issues to */
const DEFAULT_AGENT_ACCOUNT = 'generacy-bot';

/**
 * Handles post-tasks steps for epic workflows.
 *
 * This class is invoked after the phase loop completes for `speckit-epic`
 * workflows (i.e., after specify → clarify → plan → tasks). It replaces
 * the standard completion flow (markReadyForReview, onWorkflowComplete)
 * with epic-specific child issue creation and dispatch.
 */
export class EpicPostTasks {
  constructor(private readonly logger: Logger) {}

  /**
   * Execute all post-tasks steps for an epic workflow.
   *
   * Steps:
   * 1. Parse tasks.md → create child GitHub issues (idempotent)
   * 2. Dispatch children (add trigger labels, assign to agent)
   * 3. Post tasks summary comment on epic
   * 4. Add `waiting-for:children-complete` label
   */
  async execute(context: WorkerContext): Promise<EpicPostTasksResult> {
    const { item, github } = context;
    const { owner, repo, issueNumber } = item;

    this.logger.info(
      { owner, repo, issueNumber },
      'Starting epic post-tasks: creating child issues and dispatching',
    );

    // 1. Create child issues from tasks.md
    let tasksOutput: TasksToIssuesOutput;
    try {
      tasksOutput = await this.createChildIssues(context);
    } catch (error) {
      this.logger.error(
        { error: String(error), issueNumber },
        'Failed to create child issues from tasks.md',
      );
      return { childIssues: [], success: false };
    }

    // Collect all child issue numbers (created + already existing)
    const childIssues = [
      ...tasksOutput.created_issues.map((i) => i.issue_number),
      ...tasksOutput.skipped_issues.map((i) => i.issue_number),
    ];

    if (childIssues.length === 0 && tasksOutput.total_tasks > 0) {
      this.logger.error(
        { failedTasks: tasksOutput.failed_tasks.length, totalTasks: tasksOutput.total_tasks },
        'All tasks failed to create issues — aborting post-tasks',
      );
      return { childIssues: [], success: false, tasksToIssuesOutput: tasksOutput };
    }

    // 2. Dispatch children (add trigger labels and assign to agent)
    if (tasksOutput.created_issues.length > 0) {
      try {
        await this.dispatchChildren(context, tasksOutput.created_issues.map((i) => i.issue_number));
      } catch (error) {
        this.logger.warn(
          { error: String(error), issueNumber },
          'Failed to dispatch some children — continuing with remaining steps',
        );
      }
    }

    // 3. Post tasks summary comment on epic
    try {
      await this.postTasksSummary(context, tasksOutput);
    } catch (error) {
      this.logger.warn(
        { error: String(error), issueNumber },
        'Failed to post tasks summary comment — continuing',
      );
    }

    // 4. Add waiting-for:children-complete label
    try {
      await github.addLabels(owner, repo, issueNumber, ['waiting-for:children-complete']);
      this.logger.info(
        { issueNumber },
        'Added waiting-for:children-complete label to epic',
      );
    } catch (error) {
      this.logger.error(
        { error: String(error), issueNumber },
        'Failed to add waiting-for:children-complete label',
      );
      // This is a critical step — if we can't pause the epic, report failure
      return { childIssues, success: false, tasksToIssuesOutput: tasksOutput };
    }

    this.logger.info(
      { childIssues, created: tasksOutput.created_issues.length, skipped: tasksOutput.skipped_issues.length },
      'Epic post-tasks complete',
    );

    return { childIssues, success: true, tasksToIssuesOutput: tasksOutput };
  }

  /**
   * Step 1: Parse tasks.md and create child GitHub issues.
   *
   * Calls executeTasksToIssues() directly — this is the same function
   * used by the speckit.tasks_to_issues workflow-engine action.
   */
  private async createChildIssues(context: WorkerContext): Promise<TasksToIssuesOutput> {
    const { item } = context;

    // Resolve the feature directory path from the specs directory
    const featureDir = this.resolveFeatureDir(context);

    // Resolve the epic branch name (the branch the epic is working on)
    const epicBranch = await this.resolveEpicBranch(context);

    // Build a minimal ActionContext for the workflow-engine function
    const actionContext = this.buildActionContext(context);

    const output = await executeTasksToIssues(
      {
        feature_dir: featureDir,
        epic_issue_number: item.issueNumber,
        epic_branch: epicBranch,
        trigger_label: DEFAULT_TRIGGER_LABEL,
      },
      actionContext,
    );

    this.logger.info(
      {
        created: output.created_issues.length,
        skipped: output.skipped_issues.length,
        failed: output.failed_tasks.length,
        total: output.total_tasks,
      },
      'Tasks-to-issues operation complete',
    );

    return output;
  }

  /**
   * Step 2: Dispatch children by assigning to agent and adding dispatched label.
   *
   * This mirrors the logic in DispatchChildrenAction but operates directly
   * via the GitHub client, avoiding the need for a full ActionContext with
   * workflow/phase/step definitions.
   */
  private async dispatchChildren(
    context: WorkerContext,
    childIssueNumbers: number[],
  ): Promise<void> {
    const { github, item } = context;
    const { owner, repo } = item;
    const agentAccount = process.env.GENERACY_AGENT_ACCOUNT ?? DEFAULT_AGENT_ACCOUNT;

    this.logger.info(
      { children: childIssueNumbers.length, agentAccount },
      'Dispatching child issues',
    );

    let dispatched = 0;
    let failed = 0;

    for (const childNumber of childIssueNumbers) {
      try {
        // Assign to agent account
        await github.updateIssue(owner, repo, childNumber, {
          assignees: [agentAccount],
        });

        // Add dispatched label
        await github.addLabels(owner, repo, childNumber, [DISPATCHED_LABEL]);

        dispatched++;
        this.logger.debug(
          { childNumber },
          `Dispatched child #${childNumber}`,
        );
      } catch (error) {
        failed++;
        this.logger.warn(
          { error: String(error), childNumber },
          `Failed to dispatch child #${childNumber}`,
        );
      }
    }

    this.logger.info(
      { dispatched, failed, total: childIssueNumbers.length },
      'Child dispatch complete',
    );
  }

  /**
   * Step 3: Post a summary comment on the epic issue listing all child issues.
   */
  private async postTasksSummary(
    context: WorkerContext,
    tasksOutput: TasksToIssuesOutput,
  ): Promise<void> {
    const { github, item } = context;
    const { owner, repo, issueNumber } = item;

    const allIssues = [
      ...tasksOutput.created_issues.map((i) => ({
        number: i.issue_number,
        title: i.title,
        taskId: i.task_id,
        status: 'created' as const,
      })),
      ...tasksOutput.skipped_issues.map((i) => ({
        number: i.issue_number,
        title: i.title,
        taskId: i.task_id,
        status: 'existing' as const,
      })),
    ];

    const issueRows = allIssues
      .map((i) => `| ${i.taskId} | #${i.number} | ${i.title} | ${i.status === 'created' ? 'New' : 'Existing'} |`)
      .join('\n');

    const failedRows = tasksOutput.failed_tasks
      .map((f) => `| ${f.task_id} | ${f.title} | ${f.reason} |`)
      .join('\n');

    let body = `<!-- epic-children-summary -->\n## Child Issues Created\n\n`;
    body += `| Task | Issue | Title | Status |\n|------|-------|-------|--------|\n${issueRows}\n\n`;

    if (tasksOutput.failed_tasks.length > 0) {
      body += `### Failed Tasks\n\n| Task | Title | Reason |\n|------|-------|--------|\n${failedRows}\n\n`;
    }

    body += `**Total**: ${tasksOutput.total_tasks} tasks, ${tasksOutput.created_issues.length} created, ${tasksOutput.skipped_issues.length} existing, ${tasksOutput.failed_tasks.length} failed\n`;

    await github.addIssueComment(owner, repo, issueNumber, body);

    this.logger.info(
      { issueNumber, childCount: allIssues.length },
      'Posted tasks summary comment on epic',
    );
  }

  /**
   * Resolve the feature directory for this epic.
   * Looks in the specs/ directory for a folder matching the issue number.
   */
  private resolveFeatureDir(context: WorkerContext): string {
    const { item, checkoutPath } = context;
    const { issueNumber } = item;

    // Convention: specs/{issueNumber}-{short-name}/
    const specsDir = join(checkoutPath, 'specs');

    try {
      const dirs = readdirSync(specsDir);
      const match = dirs.find((d) => d.startsWith(`${issueNumber}-`));
      if (match) {
        return join(specsDir, match);
      }
    } catch {
      // specs directory may not exist
    }

    // Fallback: use the issue number directly
    return join(checkoutPath, 'specs', `${issueNumber}`);
  }

  /**
   * Resolve the epic branch name.
   * The epic branch is the current working branch (created during specify phase).
   */
  private async resolveEpicBranch(context: WorkerContext): Promise<string> {
    const { github, item } = context;

    try {
      return await github.getCurrentBranch();
    } catch {
      // Fall through to branch lookup
    }

    // Fallback: find branch by issue number prefix
    try {
      const branches = await github.listBranches(item.owner, item.repo);
      const epicBranch = branches.find((b) => b.startsWith(`${item.issueNumber}-`));
      if (epicBranch) {
        return epicBranch;
      }
    } catch {
      // Fall through to last resort
    }

    // Last resort: construct from issue number
    return `${item.issueNumber}-epic`;
  }

  /**
   * Build a minimal ActionContext compatible with the workflow-engine's
   * executeTasksToIssues() function.
   *
   * The function only uses `context.workdir` and `context.logger`, so we
   * provide those and stub the rest.
   */
  private buildActionContext(context: WorkerContext): ActionContext {
    // Adapt the orchestrator logger to the workflow-engine logger interface
    const logger = {
      info: (msg: string) => this.logger.info(msg),
      warn: (msg: string) => this.logger.warn(msg),
      error: (msg: string) => this.logger.error(msg),
      debug: (msg: string) => this.logger.debug(msg),
    };

    return {
      workdir: context.checkoutPath,
      logger,
      // These fields are required by ActionContext but not used by executeTasksToIssues
      workflow: {} as ActionContext['workflow'],
      phase: {} as ActionContext['phase'],
      step: {} as ActionContext['step'],
      inputs: {},
      stepOutputs: new Map(),
      env: {},
      signal: context.signal,
    };
  }
}
