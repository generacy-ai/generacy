import { randomUUID } from 'node:crypto';

/**
 * Generate a unique identifier using crypto.randomUUID()
 * @returns A UUID v4 string
 */
export function generateId(): string {
  return randomUUID();
}
