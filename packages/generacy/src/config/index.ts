/**
 * @generacy-ai/generacy/config
 *
 * Configuration schema and validation for Generacy projects.
 * Defines the .generacy/config.yaml schema and provides type-safe validation.
 */

// Export all schemas and types
export {
  ProjectConfigSchema,
  type ProjectConfig,
  ReposConfigSchema,
  type ReposConfig,
  DefaultsConfigSchema,
  type DefaultsConfig,
  OrchestratorSettingsSchema,
  type OrchestratorSettings,
  ClusterConfigSchema,
  type ClusterConfig,
  GeneracyConfigSchema,
  type GeneracyConfig,
  validateConfig,
} from './schema.js';

// Export validation utilities
export {
  ConfigValidationError,
  validateNoDuplicateRepos,
  validateSemantics,
} from './validator.js';

// Export loader utilities
export {
  loadConfig,
  findConfigFile,
  parseConfig,
  type LoadConfigOptions,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigSchemaError,
} from './loader.js';
