import type { GeneracyConfig } from './schema.js';

/**
 * Validation error class for semantic validation failures
 */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly conflictingRepos?: string[],
    public readonly locations?: string[]
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Check for duplicate repositories across primary, dev, and clone lists
 *
 * This function implements detailed duplicate detection with clear error messages
 * indicating exactly which repositories conflict and in which lists they appear.
 *
 * Validation rules:
 * - Primary repo cannot appear in dev list
 * - Primary repo cannot appear in clone list
 * - No repository can appear in both dev and clone lists
 * - No repository can appear twice within the same list (dev or clone)
 *
 * @param config - Validated Generacy configuration
 * @throws ConfigValidationError if duplicates are found, with details about the conflict
 *
 * @example
 * ```typescript
 * // Valid configuration - no duplicates
 * validateNoDuplicateRepos({
 *   repos: {
 *     primary: 'github.com/acme/main',
 *     dev: ['github.com/acme/lib'],
 *     clone: ['github.com/acme/docs']
 *   }
 * });
 *
 * // Invalid - throws with details about which lists conflict
 * validateNoDuplicateRepos({
 *   repos: {
 *     primary: 'github.com/acme/main',
 *     dev: ['github.com/acme/main'], // Conflict!
 *     clone: []
 *   }
 * });
 * ```
 */
export function validateNoDuplicateRepos(config: GeneracyConfig): void {
  const { primary, dev = [], clone = [] } = config.repos;
  const allDuplicates = new Set<string>();
  const locations = new Set<string>();

  // Check if primary is in dev list
  if (dev.includes(primary)) {
    allDuplicates.add(primary);
    locations.add('primary').add('dev');
  }

  // Check if primary is in clone list
  if (clone.includes(primary)) {
    allDuplicates.add(primary);
    locations.add('primary').add('clone');
  }

  // Check for duplicates within dev list
  const devSeen = new Set<string>();
  for (const repo of dev) {
    if (devSeen.has(repo)) {
      allDuplicates.add(repo);
      locations.add('dev');
    }
    devSeen.add(repo);
  }

  // Check for duplicates within clone list
  const cloneSeen = new Set<string>();
  for (const repo of clone) {
    if (cloneSeen.has(repo)) {
      allDuplicates.add(repo);
      locations.add('clone');
    }
    cloneSeen.add(repo);
  }

  // Check for overlaps between dev and clone lists
  for (const repo of clone) {
    if (devSeen.has(repo)) {
      allDuplicates.add(repo);
      locations.add('dev').add('clone');
    }
  }

  // Report duplicates if found
  if (allDuplicates.size > 0) {
    const dupeList = Array.from(allDuplicates).join(', ');
    const locationList = Array.from(locations);
    throw new ConfigValidationError(
      `Duplicate repositories found: ${dupeList}. ` +
      'Each repository can only appear once across primary, dev, and clone lists.',
      Array.from(allDuplicates),
      locationList
    );
  }
}

/**
 * Perform all semantic validations on a configuration
 *
 * @param config - Validated Generacy configuration
 * @throws ConfigValidationError if any semantic validation fails
 *
 * @example
 * ```typescript
 * const config = validateConfig(rawConfig);
 * validateSemantics(config); // Throws if semantic rules violated
 * ```
 */
export function validateSemantics(config: GeneracyConfig): void {
  validateNoDuplicateRepos(config);
}
