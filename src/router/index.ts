/**
 * Public exports for router module.
 */

export {
  MessageRouter,
  type MessageRouterEvents,
  type RouteOptions,
} from './message-router.js';

export {
  determineRoute,
  validateMessageForRouting,
  expectsResponse,
  getSourceTypeConstraint,
  RoutingError,
  DestinationNotFoundError,
  NoRecipientsError,
  type RouteTarget,
  type RoutingDecision,
} from './routing-rules.js';

export {
  CorrelationManager,
  CorrelationTimeoutError,
  CorrelationCancelledError,
  type CorrelationManagerEvents,
} from './correlation-manager.js';
