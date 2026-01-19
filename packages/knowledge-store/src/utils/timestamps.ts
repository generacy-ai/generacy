/**
 * Get the current timestamp in ISO 8601 format
 * @returns ISO 8601 timestamp string
 */
export function now(): string {
  return new Date().toISOString();
}
