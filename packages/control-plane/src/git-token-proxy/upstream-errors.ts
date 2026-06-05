/**
 * The only upstream-side error code this bin emits. Single closed union: the
 * CLI wrapper (#766) cares only that the upstream is unreachable; the per-
 * request stdout log line tells operators which transport mode triggered it.
 */
export type UpstreamErrorCode = 'CONTROL_SOCKET_UNREACHABLE';

/**
 * Collapses every upstream-transport failure (ECONNREFUSED, ENOENT,
 * ECONNRESET, EPIPE, timeout/AbortError, generic Error, undefined) to the
 * single error code. Identity-style mapper — a single source of truth so the
 * handler never branches on errno strings inline.
 */
export function mapUpstreamErrorToCode(_err: unknown): UpstreamErrorCode {
  return 'CONTROL_SOCKET_UNREACHABLE';
}
