// @generacy-ai/credhelper - Credentials architecture contracts

// Types
export { type Secret } from './types/secret.js';
export {
  type ExposureKind,
  type ExposureConfig,
  type ExposureOutput,
} from './types/exposure.js';
export {
  type BackendClient,
  type MintContext,
  type ResolveContext,
} from './types/context.js';
export { type CredentialTypePlugin } from './types/plugin.js';
export {
  type PluginExposureData,
  type PluginEnvExposure,
  type PluginGitCredentialHelperExposure,
  type PluginGcloudExternalAccountExposure,
  type PluginLocalhostProxyExposure,
} from './types/plugin-exposure.js';
export {
  type BeginSessionRequest,
  type BeginSessionResponse,
  type EndSessionRequest,
} from './types/session.js';
export { type LaunchRequestCredentials } from './types/launch.js';

// Schemas — backends
export {
  BackendAuthSchema,
  BackendEntrySchema,
  BackendsConfigSchema,
  type BackendsConfig,
  type BackendEntry,
  type BackendAuth,
} from './schemas/backends.js';

// Schemas — credentials
export {
  MintConfigSchema,
  CredentialEntrySchema,
  CredentialsConfigSchema,
  type CredentialsConfig,
  type CredentialEntry,
  type MintConfig,
} from './schemas/credentials.js';

// Schemas — roles
export {
  RoleExposeSchema,
  RoleCredentialRefSchema,
  ProxyRuleSchema,
  ProxyConfigSchema,
  DockerRuleSchema,
  DockerConfigSchema,
  RoleConfigSchema,
  type RoleConfig,
  type RoleCredentialRef,
  type RoleExpose,
  type ProxyConfig,
  type ProxyRule,
  type DockerConfig,
  type DockerRule,
} from './schemas/roles.js';

// Schemas — trusted plugins
export {
  PluginPinSchema,
  TrustedPluginsSchema,
  type TrustedPluginsConfig,
  type PluginPin,
} from './schemas/trusted-plugins.js';

// Schemas — exposure
export {
  ExposureConfigSchema,
  ExposureOutputSchema,
  type ExposureConfigParsed,
  type ExposureOutputParsed,
} from './schemas/exposure.js';

// Config loader
export {
  loadConfig,
  ConfigValidationError,
  type ConfigError,
  type ConfigResult,
  type LoadConfigOptions,
} from './config/index.js';

// Loader
export { loadCredentialPlugins } from './loader/index.js';
export {
  type LoaderConfig,
  type DiscoveredPlugin,
} from './loader/index.js';
