/**
 * @generacy-ai/generacy
 *
 * Headless CLI and library for running Generacy workflows.
 * Provides orchestrator integration, agency support, and workflow execution.
 */

// Orchestrator client
export {
  OrchestratorClient,
  OrchestratorClientError,
  HeartbeatManager,
  JobHandler,
} from './orchestrator/index.js';

export type {
  OrchestratorClientOptions,
  HeartbeatManagerOptions,
  WorkerStatus,
  JobHandlerOptions,
  Job,
  JobStatus,
  JobPriority,
  JobResult,
  WorkerRegistration,
  Heartbeat,
  HeartbeatResponse,
  PollResponse,
  OrchestratorError,
} from './orchestrator/index.js';

// Agency integration
export {
  createAgencyConnection,
  SubprocessAgency,
  NetworkAgency,
} from './agency/index.js';

export type {
  AgencyMode,
  AgencyConnection,
  AgencyConnectionOptions,
  ToolCallRequest,
  ToolCallResponse,
  SubprocessAgencyOptions,
  NetworkAgencyOptions,
} from './agency/index.js';

// Health server
export { createHealthServer } from './health/server.js';
export type { HealthStatus, HealthServerOptions, HealthServer } from './health/server.js';

// CLI utilities
export { createLogger, getLogger, setLogger, createWorkflowLogger, PinoWorkflowLogger } from './cli/utils/logger.js';
export type { LogLevel, LoggerOptions } from './cli/utils/logger.js';

export { resolveConfig, validateConfig, createConfig } from './cli/utils/config.js';
export type { CLIConfig } from './cli/utils/config.js';

// CLI entry point (for programmatic use)
export { createProgram, run } from './cli/index.js';

// Config schema and validation
export {
  ProjectConfigSchema,
  ReposConfigSchema,
  DefaultsConfigSchema,
  OrchestratorSettingsSchema,
  GeneracyConfigSchema,
  validateConfig as validateGeneracyConfig,
  ConfigValidationError,
  validateNoDuplicateRepos,
  validateSemantics,
  loadConfig,
  findConfigFile,
  parseConfig,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigSchemaError,
} from './config/index.js';

export type {
  ProjectConfig,
  ReposConfig,
  DefaultsConfig,
  OrchestratorSettings,
  GeneracyConfig,
  LoadConfigOptions,
} from './config/index.js';

// Re-export workflow engine
export * from '@generacy-ai/workflow-engine';
