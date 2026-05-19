import type { RoleConfig, RoleCredentialRef } from '../schemas/roles.js';
import type { ConfigError } from './types.js';

function mergeCredentials(
  parent: RoleCredentialRef[],
  child: RoleCredentialRef[],
): RoleCredentialRef[] {
  const map = new Map(parent.map((c) => [c.ref, c]));
  for (const entry of child) {
    map.set(entry.ref, entry);
  }
  return [...map.values()];
}

function resolveChain(
  roleId: string,
  rolesMap: Map<string, RoleConfig>,
  errors: ConfigError[],
  visited: Set<string>,
  resolved: Map<string, RoleConfig>,
): RoleConfig | null {
  if (resolved.has(roleId)) {
    return resolved.get(roleId)!;
  }

  if (visited.has(roleId)) {
    const chain = [...visited, roleId].join(' \u2192 ');
    errors.push({
      file: `roles/${roleId}.yaml`,
      message: `Circular extends chain detected: ${chain}`,
    });
    return null;
  }

  const role = rolesMap.get(roleId);
  if (!role) {
    return null;
  }

  if (!role.extends) {
    resolved.set(roleId, role);
    return role;
  }

  visited.add(roleId);

  const parentId = role.extends;
  if (!rolesMap.has(parentId)) {
    errors.push({
      file: `roles/${roleId}.yaml`,
      field: 'extends',
      message: `Parent role "${parentId}" not found`,
    });
    // Still usable without parent — return as-is
    const resolvedRole = { ...role, extends: undefined };
    resolved.set(roleId, resolvedRole);
    return resolvedRole;
  }

  const parent = resolveChain(parentId, rolesMap, errors, visited, resolved);
  if (!parent) {
    const resolvedRole = { ...role, extends: undefined };
    resolved.set(roleId, resolvedRole);
    return resolvedRole;
  }

  const mergedRole: RoleConfig = {
    ...role,
    extends: undefined,
    credentials: mergeCredentials(parent.credentials, role.credentials),
  };
  resolved.set(roleId, mergedRole);
  return mergedRole;
}

export function resolveRoleExtends(
  roles: Map<string, RoleConfig>,
  errors: ConfigError[],
): Map<string, RoleConfig> {
  const resolved = new Map<string, RoleConfig>();

  for (const roleId of roles.keys()) {
    resolveChain(roleId, roles, errors, new Set<string>(), resolved);
  }

  return resolved;
}
