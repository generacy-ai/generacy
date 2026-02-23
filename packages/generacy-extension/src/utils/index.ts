/**
 * Utility modules for Generacy VS Code extension
 */

// Configuration
export {
  ConfigurationManager,
  getConfig,
  type ExtensionConfig,
  type ConfigChangeEvent,
  type ConfigChangeListener,
} from './config';

// Logging
export {
  Logger,
  ChildLogger,
  getLogger,
  LogLevel,
  type LogEntry,
  type LoggerOptions,
} from './logger';

// Error handling
export {
  GeneracyError,
  ErrorCode,
  showError,
  showWarning,
  withErrorHandling,
  tryAsync,
  trySync,
  ok,
  err,
  assert,
  assertDefined,
  type Result,
  type ErrorDisplayOptions,
} from './errors';

// Telemetry
export {
  TelemetryService,
  getTelemetry,
  TelemetryEventType,
  type TelemetryEvent,
  type TelemetrySender,
} from './telemetry';

// Notifications
export {
  NotificationManager,
  type NotificationLevel,
} from './notifications';

// Capabilities
export {
  CapabilityChecker,
  getCapabilityChecker,
} from './capabilities';
