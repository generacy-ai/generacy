/**
 * Handler module exports.
 * Provides phase lifecycle handlers for cross-repo workflows.
 */
export {
  siblingFanoutHandler,
  type SiblingFanoutContext,
  type SiblingFanoutResult,
  type SiblingOutcome,
} from './sibling-fanout.js';
