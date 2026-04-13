import type { CredentialTypePlugin } from '../types/plugin.js';
import type { ExposureKind } from '../types/exposure.js';

const VALID_EXPOSURE_KINDS: ReadonlySet<string> = new Set<ExposureKind>([
  'env',
  'git-credential-helper',
  'gcloud-external-account',
  'localhost-proxy',
  'docker-socket-proxy',
]);

/**
 * Validate that a dynamically imported module implements the CredentialTypePlugin interface.
 *
 * Performs runtime duck-type checking since TypeScript interfaces don't exist at runtime.
 * Throws descriptive errors for any missing or invalid fields.
 */
export function validatePlugin(
  mod: unknown,
  pluginName: string,
): CredentialTypePlugin {
  const obj = mod as Record<string, unknown>;

  // type: non-empty string
  if (typeof obj['type'] !== 'string' || obj['type'].length === 0) {
    throw new Error(
      `Plugin '${pluginName}' does not implement CredentialTypePlugin: missing or invalid 'type'`,
    );
  }

  // credentialSchema: must have .parse method (Zod schema)
  const schema = obj['credentialSchema'];
  if (
    !schema ||
    typeof schema !== 'object' ||
    typeof (schema as Record<string, unknown>)['parse'] !== 'function'
  ) {
    throw new Error(
      `Plugin '${pluginName}' credentialSchema is not a valid Zod schema`,
    );
  }

  // scopeSchema: optional, but if present must have .parse
  if (obj['scopeSchema'] !== undefined) {
    const scope = obj['scopeSchema'];
    if (
      !scope ||
      typeof scope !== 'object' ||
      typeof (scope as Record<string, unknown>)['parse'] !== 'function'
    ) {
      throw new Error(
        `Plugin '${pluginName}' scopeSchema is not a valid Zod schema`,
      );
    }
  }

  // supportedExposures: non-empty array of valid ExposureKind values
  const exposures = obj['supportedExposures'];
  if (!Array.isArray(exposures) || exposures.length === 0) {
    throw new Error(
      `Plugin '${pluginName}' supportedExposures must be a non-empty array of valid exposure kinds`,
    );
  }
  for (const e of exposures) {
    if (!VALID_EXPOSURE_KINDS.has(e as string)) {
      throw new Error(
        `Plugin '${pluginName}' supportedExposures contains invalid kind: '${String(e)}'`,
      );
    }
  }

  // renderExposure: must be a function
  if (typeof obj['renderExposure'] !== 'function') {
    throw new Error(
      `Plugin '${pluginName}' missing renderExposure function`,
    );
  }

  return obj as unknown as CredentialTypePlugin;
}
