/**
 * ID Generator
 *
 * UUID generation for workflow IDs.
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a unique workflow ID.
 * Uses UUID v4 for guaranteed uniqueness.
 */
export function generateWorkflowId(): string {
  return uuidv4();
}

/**
 * Generate a prefixed workflow ID for easier identification.
 * @param prefix Optional prefix (default: 'wf')
 */
export function generatePrefixedId(prefix: string = 'wf'): string {
  return `${prefix}_${uuidv4()}`;
}

/**
 * Validate that a string is a valid UUID v4.
 */
export function isValidUuid(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

/**
 * Validate that a string is a valid prefixed ID.
 */
export function isValidPrefixedId(id: string, prefix: string = 'wf'): boolean {
  if (!id.startsWith(`${prefix}_`)) {
    return false;
  }
  const uuid = id.slice(prefix.length + 1);
  return isValidUuid(uuid);
}
