/**
 * Shared classification of label-provisioning errors.
 *
 * Both `LabelManager.ensureRepoLabelsExist` (per-worker per-phase ensure-pass)
 * and `LabelSyncService.syncRepo` (boot-time bulk sync) consume this helper to
 * distinguish a benign create-race (`already exists` / `already_exists`) from a
 * real provisioning failure (422 validation, 401 auth, 403 permission, 5xx).
 *
 * Single home per FR-004 / Q1→A — prevents the two provisioning surfaces from
 * drifting apart (the very bug shape #916 fixes).
 */

export type ProvisioningErrorClassification =
  | { readonly kind: 'already-exists' }
  | {
      readonly kind: 'error';
      readonly cause: string;
      readonly statusCode?: number;
    };

const CREATE_LABEL_PREFIX = /^Failed to create label [^:]+: /;

/**
 * Classify a caught error from `createLabel` (or an equivalent provisioning
 * call) into a race vs a real failure. Pure function — no I/O, no logging,
 * no throws.
 */
export function classifyLabelProvisioningError(err: unknown): ProvisioningErrorClassification {
  const message = err instanceof Error ? err.message : String(err);

  if (/already[ _]exists/i.test(message)) {
    return { kind: 'already-exists' };
  }

  const statusMatch = message.match(/HTTP\s+(\d{3})/);
  const statusCode = statusMatch ? Number.parseInt(statusMatch[1]!, 10) : undefined;

  const cause = message.replace(CREATE_LABEL_PREFIX, '');

  return statusCode !== undefined
    ? { kind: 'error', cause, statusCode }
    : { kind: 'error', cause };
}
