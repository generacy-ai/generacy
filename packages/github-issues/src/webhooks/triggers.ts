import type {
  TypedWebhookEvent,
  IssuesEventPayload,
  IssueCommentEventPayload,
  WorkflowAction,
  NoAction,
  QueueForProcessingAction,
  StartWorkflowAction,
  ResumeWorkflowAction,
} from '../types/index.js';
import {
  isIssuesEvent,
  isIssueCommentEvent,
} from './parser.js';

/**
 * Configuration for workflow triggers
 */
export interface TriggerConfig {
  /** Username of the agent account for assignment detection */
  agentAccount?: string;

  /** Labels that trigger workflow start */
  triggerLabels?: string[];

  /** Comment patterns that resume paused workflows */
  resumePatterns?: RegExp[];
}

/**
 * Default resume patterns
 */
const DEFAULT_RESUME_PATTERNS = [
  /@agent\s+continue/i,
  /@autodev\s+continue/i,
  /\/continue/i,
];

/**
 * Create a no-action result
 */
function noAction(reason: string): NoAction {
  return { type: 'no_action', reason };
}

/**
 * Create a queue-for-processing action
 */
function queueForProcessing(
  issueNumber: number,
  priority: 'high' | 'normal' | 'low' = 'normal'
): QueueForProcessingAction {
  return { type: 'queue_for_processing', issueNumber, priority };
}

/**
 * Create a start-workflow action
 */
function startWorkflow(issueNumber: number, workflowType?: string): StartWorkflowAction {
  return { type: 'start_workflow', issueNumber, workflowType };
}

/**
 * Create a resume-workflow action
 */
function resumeWorkflow(
  issueNumber: number,
  triggeredBy: 'comment' | 'label'
): ResumeWorkflowAction {
  return { type: 'resume_workflow', issueNumber, triggeredBy };
}

/**
 * Evaluate an issues event for workflow triggers
 */
function evaluateIssuesEvent(
  payload: IssuesEventPayload,
  config: TriggerConfig
): WorkflowAction {
  const { action, issue, assignee, label } = payload;
  const { agentAccount, triggerLabels = [] } = config;

  // Check for agent assignment
  if (action === 'assigned' && agentAccount) {
    if (assignee?.login === agentAccount) {
      return queueForProcessing(issue.number, 'normal');
    }
  }

  // Check for trigger label
  if (action === 'labeled' && label) {
    if (triggerLabels.includes(label.name)) {
      return startWorkflow(issue.number);
    }
  }

  // Check for ready label (common pattern)
  if (action === 'labeled' && label) {
    if (label.name === 'autodev:ready' || label.name === 'ready') {
      return startWorkflow(issue.number);
    }
  }

  // Issue opened - could be a signal to start work
  if (action === 'opened') {
    // Check if already assigned to agent
    if (agentAccount && issue.assignees.some((a) => a.login === agentAccount)) {
      return queueForProcessing(issue.number, 'normal');
    }

    // Check if has trigger label
    for (const triggerLabel of triggerLabels) {
      if (issue.labels.some((l) => l.name === triggerLabel)) {
        return startWorkflow(issue.number);
      }
    }
  }

  return noAction(`No trigger matched for issues.${action}`);
}

/**
 * Evaluate an issue_comment event for workflow triggers
 */
function evaluateIssueCommentEvent(
  payload: IssueCommentEventPayload,
  config: TriggerConfig
): WorkflowAction {
  const { action, issue, comment } = payload;
  const { resumePatterns = DEFAULT_RESUME_PATTERNS } = config;

  // Only process new comments
  if (action !== 'created') {
    return noAction(`Comment action '${action}' does not trigger workflows`);
  }

  // Check for resume patterns in comment body
  for (const pattern of resumePatterns) {
    if (pattern.test(comment.body)) {
      return resumeWorkflow(issue.number, 'comment');
    }
  }

  return noAction('No resume pattern matched in comment');
}

/**
 * Evaluate a webhook event against trigger configuration
 */
export function evaluateTriggers(
  event: TypedWebhookEvent,
  config: TriggerConfig
): WorkflowAction {
  if (isIssuesEvent(event)) {
    return evaluateIssuesEvent(event.payload, config);
  }

  if (isIssueCommentEvent(event)) {
    return evaluateIssueCommentEvent(event.payload, config);
  }

  // Pull request events don't directly trigger workflows in this implementation
  return noAction('Pull request events do not trigger workflows');
}

/**
 * Check if an action requires workflow processing
 */
export function requiresProcessing(action: WorkflowAction): boolean {
  return action.type !== 'no_action';
}

/**
 * Get the issue number from a workflow action
 */
export function getActionIssueNumber(action: WorkflowAction): number | null {
  if (action.type === 'no_action') {
    return null;
  }
  return action.issueNumber;
}
