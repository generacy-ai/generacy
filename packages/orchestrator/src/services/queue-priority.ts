import type { QueueReason } from '../types/index.js';

/**
 * Compute a numeric priority score from a queue reason.
 * Lower score = higher priority (Redis ZPOPMIN semantics).
 *
 * - 'resume' → 0.{timestamp} (≈0.17, highest priority)
 * - 'retry'  → 1.{timestamp} (≈1.17)
 * - 'new'/undefined → Date.now() (≈1.7×10¹², lowest priority)
 */
export function getPriorityScore(reason: QueueReason | undefined): number {
  const timestamp = Date.now();
  switch (reason) {
    case 'resume': return parseFloat(`0.${timestamp}`);
    case 'retry':  return parseFloat(`1.${timestamp}`);
    case 'new':
    default:       return timestamp;
  }
}
