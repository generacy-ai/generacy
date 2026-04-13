import { join } from 'node:path';
import { BackendsConfigSchema } from '../schemas/backends.js';
import { CredentialsConfigSchema } from '../schemas/credentials.js';
import { TrustedPluginsSchema } from '../schemas/trusted-plugins.js';
import { ConfigValidationError } from './errors.js';
import { readRequiredYaml, readOptionalYaml, readRoleDirectory } from './file-reader.js';
import { mergeCredentialOverlay } from './overlay.js';
import { resolveRoleExtends } from './role-resolver.js';
import {
  validateCredentialBackendRefs,
  validateRoleCredentialRefs,
  validateExposurePluginSupport,
} from './validator.js';
import type { ConfigError, ConfigResult, LoadConfigOptions } from './types.js';

export function loadConfig(options: LoadConfigOptions): ConfigResult {
  const { agencyDir, pluginRegistry, logger } = options;
  const secretsDir = join(agencyDir, 'secrets');
  const rolesDir = join(agencyDir, 'roles');
  const errors: ConfigError[] = [];

  // 1. Read required files
  const backends = readRequiredYaml(
    join(secretsDir, 'backends.yaml'),
    BackendsConfigSchema,
    errors,
    'committed',
  );

  const committedCredentials = readRequiredYaml(
    join(secretsDir, 'credentials.yaml'),
    CredentialsConfigSchema,
    errors,
    'committed',
  );

  // 2. Read optional overlay
  const overlayCredentials = readOptionalYaml(
    join(secretsDir, 'credentials.local.yaml'),
    CredentialsConfigSchema,
    errors,
    'overlay',
  );

  // 3. Merge overlay
  let mergedCredentialEntries = committedCredentials?.credentials ?? [];
  let overlayIds: string[] = [];
  if (committedCredentials && overlayCredentials) {
    const result = mergeCredentialOverlay(
      committedCredentials.credentials,
      overlayCredentials.credentials,
    );
    mergedCredentialEntries = result.merged;
    overlayIds = result.overlayIds;
  } else if (overlayCredentials && !committedCredentials) {
    // Overlay exists but committed doesn't — use overlay entries directly
    mergedCredentialEntries = overlayCredentials.credentials;
    overlayIds = overlayCredentials.credentials.map((c) => c.id);
  }

  // 4. Read optional trusted plugins
  const trustedPlugins = readOptionalYaml(
    join(secretsDir, 'trusted-plugins.yaml'),
    TrustedPluginsSchema,
    errors,
  );

  // 5. Read roles directory
  const rawRoles = readRoleDirectory(rolesDir, errors);

  // 6. Resolve role extends chains
  const roles = resolveRoleExtends(rawRoles, errors);

  // 7. Cross-reference validation
  if (backends) {
    validateCredentialBackendRefs(
      mergedCredentialEntries,
      backends,
      join(secretsDir, 'credentials.yaml'),
      errors,
    );
  }

  const credentialIds = new Set(mergedCredentialEntries.map((c) => c.id));
  validateRoleCredentialRefs(roles, credentialIds, errors);

  if (pluginRegistry) {
    validateExposurePluginSupport(roles, mergedCredentialEntries, pluginRegistry, errors);
  }

  // 8. Log overlay usage
  if (logger && overlayIds.length > 0) {
    logger.info(`Credential overlay applied for: ${overlayIds.join(', ')}`);
  }

  // 9. Throw if errors
  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }

  // 10. Build and return result
  const credentials = {
    schemaVersion: '1' as const,
    credentials: mergedCredentialEntries,
  };

  return {
    backends: backends!,
    credentials,
    trustedPlugins,
    roles,
    overlayIds,
  };
}
