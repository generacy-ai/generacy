import { z } from 'zod';

export type RetainedStatus =
  | 'authorization_pending'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface RetainedTunnelEvent {
  event: 'cluster.vscode-tunnel';
  data: unknown;
  timestamp: string;
  status: RetainedStatus;
}

const RETAINED_STATUSES = [
  'authorization_pending',
  'connected',
  'disconnected',
  'error',
] as const;

const TERMINAL_STATUSES: ReadonlySet<RetainedStatus> = new Set([
  'connected',
  'disconnected',
  'error',
]);

// Emitted at exactly four call sites in
// packages/control-plane/src/services/vscode-tunnel-manager.ts. Matched with
// startsWith because two of them append variable text (exit code, err.message).
const NON_LIFECYCLE_ERROR_MARKERS = [
  'tunnel unregister timed out',
  'tunnel unregister exited with code',
  'tunnel unregister failed',
  'tunnel name collision',
] as const;

const RetainedTunnelEventDataSchema = z
  .object({
    status: z.enum(RETAINED_STATUSES),
    error: z.string().optional(),
  })
  .passthrough();

let retained: RetainedTunnelEvent | null = null;

export function getRetainedTunnelEvent(): RetainedTunnelEvent | null {
  return retained;
}

export function setRetainedTunnelEvent(event: RetainedTunnelEvent): void {
  const existing = retained;
  if (existing === null) {
    retained = event;
    return;
  }
  if (existing.status === 'authorization_pending') {
    retained = event;
    return;
  }
  // Existing is terminal.
  if (event.status === 'authorization_pending') {
    return;
  }
  retained = event;
}

export function clearRetainedTunnelEvent(): void {
  retained = null;
}

export function isRetentionEligible(
  payload: unknown,
):
  | { eligible: true; status: RetainedStatus }
  | { eligible: false } {
  const parsed = RetainedTunnelEventDataSchema.safeParse(payload);
  if (!parsed.success) {
    return { eligible: false };
  }
  const { status, error } = parsed.data;
  if (status === 'error' && typeof error === 'string') {
    for (const marker of NON_LIFECYCLE_ERROR_MARKERS) {
      if (error.startsWith(marker)) {
        return { eligible: false };
      }
    }
  }
  return { eligible: true, status };
}

export { TERMINAL_STATUSES, NON_LIFECYCLE_ERROR_MARKERS };
