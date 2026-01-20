export {
  CORRELATION_ID_HEADER,
  generateCorrelationId,
  getCorrelationId,
  correlationIdHook,
  correlationIdResponseHook,
} from './correlation.js';

export {
  setupGracefulShutdown,
  isShuttingDown,
  resetShutdownState,
  type ShutdownOptions,
} from './shutdown.js';
