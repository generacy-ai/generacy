import type { BackendsConfig } from '../schemas/backends.js';
import type { CredentialsConfig } from '../schemas/credentials.js';
import type { RoleConfig } from '../schemas/roles.js';
import type { TrustedPluginsConfig } from '../schemas/trusted-plugins.js';
import type { ExposureKind } from '../types/exposure.js';

export interface ConfigError {
  file: string;
  field?: string;
  message: string;
  source?: 'committed' | 'overlay';
}

export interface LoadConfigOptions {
  agencyDir: string;
  pluginRegistry?: Map<string, ExposureKind[]>;
  logger?: { info(msg: string): void };
}

export interface ConfigResult {
  backends: BackendsConfig;
  credentials: CredentialsConfig;
  trustedPlugins: TrustedPluginsConfig | null;
  roles: Map<string, RoleConfig>;
  overlayIds: string[];
}
