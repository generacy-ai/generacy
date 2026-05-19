import type { BackendsConfig } from '../schemas/backends.js';
import type { CredentialEntry } from '../schemas/credentials.js';
import type { RoleConfig } from '../schemas/roles.js';
import type { ExposureKind } from '../types/exposure.js';
import type { ConfigError } from './types.js';

export function validateCredentialBackendRefs(
  credentials: CredentialEntry[],
  backends: BackendsConfig,
  credentialsFile: string,
  errors: ConfigError[],
): void {
  const backendIds = new Set(backends.backends.map((b) => b.id));
  for (const cred of credentials) {
    if (!backendIds.has(cred.backend)) {
      errors.push({
        file: credentialsFile,
        field: `credentials[id=${cred.id}].backend`,
        message: `Backend "${cred.backend}" not found in backends.yaml`,
      });
    }
  }
}

export function validateRoleCredentialRefs(
  roles: Map<string, RoleConfig>,
  credentialIds: Set<string>,
  errors: ConfigError[],
): void {
  for (const [roleId, role] of roles) {
    for (const credRef of role.credentials) {
      if (!credentialIds.has(credRef.ref)) {
        errors.push({
          file: `roles/${roleId}.yaml`,
          field: `credentials[ref=${credRef.ref}]`,
          message: `Credential "${credRef.ref}" not found in credentials`,
        });
      }
    }
  }
}

export function validateExposurePluginSupport(
  roles: Map<string, RoleConfig>,
  credentials: CredentialEntry[],
  pluginRegistry: Map<string, ExposureKind[]>,
  errors: ConfigError[],
): void {
  const credTypeMap = new Map(credentials.map((c) => [c.id, c.type]));

  for (const [roleId, role] of roles) {
    for (const credRef of role.credentials) {
      const credType = credTypeMap.get(credRef.ref);
      if (!credType) continue; // already caught by ref validation

      const supported = pluginRegistry.get(credType);
      if (!supported) continue; // plugin not in registry

      for (const expose of credRef.expose) {
        if (!supported.includes(expose.as)) {
          errors.push({
            file: `roles/${roleId}.yaml`,
            field: `credentials[ref=${credRef.ref}].expose[as=${expose.as}]`,
            message: `Exposure kind "${expose.as}" not supported by plugin type "${credType}"`,
          });
        }
      }
    }
  }
}
