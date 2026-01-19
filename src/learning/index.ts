/**
 * Learning Module
 *
 * The learning loop processor that processes human decisions and coaching
 * into knowledge updates for the protégé recommendation system.
 *
 * @example
 * ```typescript
 * import {
 *   LearningLoopProcessor,
 *   type KnowledgeStoreClient,
 * } from './learning';
 *
 * // Create processor with optional knowledge store client
 * const processor = new LearningLoopProcessor(knowledgeStoreClient);
 *
 * // Process a decision
 * const result = await processor.processDecision({
 *   id: 'decision-1',
 *   userId: 'user-1',
 *   request: decisionRequest,
 *   baseline: baselineRecommendation,
 *   protege: protegeRecommendation,
 *   finalChoice: 'opt-2', // User chose different from protégé
 *   coaching: {
 *     overrideReason: 'missing_context',
 *     explanation: 'System did not know about deadline',
 *     missingContext: 'Project deadline is tomorrow',
 *     shouldRemember: true,
 *   },
 * });
 *
 * console.log(result.suggestedUpdates); // Knowledge updates to apply
 * console.log(result.principlesContradicted); // Principles that were wrong
 * ```
 */

// Main processor
export {
  LearningLoopProcessor,
  type KnowledgeStoreClient,
  type ApplyResult,
  type LearningLoopConfig,
  type ProcessCoachingResult,
} from './learning-loop-processor.js';

// Core types
export type {
  // Override reasons
  OverrideReason,

  // Coaching data
  CoachingData,

  // Captured decision
  CapturedDecision,

  // Learning events
  LearningEventType,
  LearningEvent,
  LearningEventPayload,
  PrincipleReinforcedPayload,
  PrincipleContradictedPayload,
  CoachingReceivedPayload,
  UpdateProposedPayload,

  // Knowledge updates
  KnowledgeUpdateType,
  UpdateStatus,
  KnowledgeUpdate,
  UpdatePayload,
  PrincipleReinforcementPayload,
  PrincipleWeakeningPayload,
  PrincipleRefinementPayload,
  NewPrinciplePayload,
  ContextUpdatePayload,
  PriorityUpdatePayload,
  ExceptionNotePayload,

  // Learning result
  LearningResult,
  MetricsImpact,

  // Query options
  DecisionQueryOptions,
} from './types.js';

// Decision module
export {
  DecisionCapture,
  type DecisionCaptureInput,
  type DecisionCaptureResult,
  DecisionRepository,
  InMemoryDecisionRepository,
} from './decision/index.js';

// Coaching module
export {
  CoachingProcessor,
  type CoachingProcessResult,
  type CoachingProcessorConfig,
  UpdateGenerator,
  type UpdateGeneratorConfig,
} from './coaching/index.js';

// Updates module
export {
  ApprovalClassifier,
  type ApprovalThresholds,
  type ClassificationResult,
  UpdateQueue,
  type QueuedUpdate,
  type UpdateActionResult,
  type QueueStats,
} from './updates/index.js';
