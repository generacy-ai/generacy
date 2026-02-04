/**
 * GitHub action namespace registration.
 * Exports all github.* actions and provides namespace registration.
 */
import type { ActionNamespace, ActionHandler } from '../../types/index.js';

// Core GitHub actions
import { PreflightAction } from './preflight.js';
import { GetContextAction } from './get-context.js';
import { ReviewChangesAction } from './review-changes.js';
import { CommitAndPushAction } from './commit-and-push.js';
import { MergeFromBaseAction } from './merge-from-base.js';

// PR management actions
import { CreateDraftPRAction } from './create-draft-pr.js';
import { MarkPRReadyAction } from './mark-pr-ready.js';
import { UpdatePRAction } from './update-pr.js';
import { ReadPRFeedbackAction } from './read-pr-feedback.js';
import { RespondPRFeedbackAction } from './respond-pr-feedback.js';
import { AddCommentAction } from './add-comment.js';

// Infrastructure actions
import { SyncLabelsAction } from './sync-labels.js';

// Re-export action classes
export { PreflightAction } from './preflight.js';
export { GetContextAction } from './get-context.js';
export { ReviewChangesAction } from './review-changes.js';
export { CommitAndPushAction } from './commit-and-push.js';
export { MergeFromBaseAction } from './merge-from-base.js';
export { CreateDraftPRAction } from './create-draft-pr.js';
export { MarkPRReadyAction } from './mark-pr-ready.js';
export { UpdatePRAction } from './update-pr.js';
export { ReadPRFeedbackAction } from './read-pr-feedback.js';
export { RespondPRFeedbackAction } from './respond-pr-feedback.js';
export { AddCommentAction } from './add-comment.js';
export { SyncLabelsAction } from './sync-labels.js';

// Re-export client
export * from './client/index.js';

// Re-export URL parser utility
export { parseGitHubIssueUrl } from './preflight.js';

/**
 * All GitHub action handlers
 */
export const githubActionHandlers: ActionHandler[] = [
  // Core actions
  new PreflightAction(),
  new GetContextAction(),
  new ReviewChangesAction(),
  new CommitAndPushAction(),
  new MergeFromBaseAction(),
  // PR management actions
  new CreateDraftPRAction(),
  new MarkPRReadyAction(),
  new UpdatePRAction(),
  new ReadPRFeedbackAction(),
  new RespondPRFeedbackAction(),
  new AddCommentAction(),
  // Infrastructure actions
  new SyncLabelsAction(),
];

/**
 * GitHub action namespace definition
 */
export const githubNamespace: ActionNamespace = {
  namespace: 'github',
  description: 'GitHub API and git operations for workflow automation',
  handlers: githubActionHandlers,
};

/**
 * Get all GitHub action handlers
 */
export function getGitHubActionHandlers(): ActionHandler[] {
  return [...githubActionHandlers];
}
