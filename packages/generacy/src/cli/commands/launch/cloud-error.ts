/**
 * Structured error for HTTP 4xx responses from the Generacy cloud.
 *
 * Extends Error for backward compatibility with existing catch blocks.
 * Surfaces status code, redacted URL, and RFC 7807 detail for
 * actionable error messages in `generacy launch` / `generacy deploy`.
 */
export class CloudError extends Error {
  /** HTTP status code (e.g., 400, 401, 404, 429) */
  readonly statusCode: number;

  /** Request URL with claim code redacted (e.g., ?claim=<redacted>) */
  readonly url: string;

  /** RFC 7807 detail field from response body, if present */
  readonly detail?: string;

  /** Retry-After header value for 429 responses */
  readonly retryAfter?: string;

  /** RFC 7807 type URI from response body, for future programmatic use */
  readonly problemType?: string;

  constructor(opts: {
    statusCode: number;
    url: string;
    message: string;
    detail?: string;
    retryAfter?: string;
    problemType?: string;
  }) {
    super(opts.message);
    this.name = 'CloudError';
    this.statusCode = opts.statusCode;
    this.url = opts.url;
    this.detail = opts.detail;
    this.retryAfter = opts.retryAfter;
    this.problemType = opts.problemType;
  }
}

/**
 * Replace the `claim` query parameter value with `<redacted>`.
 *
 * Claims are live bootstrap secrets — this prevents accidental leakage
 * when users paste error output into chat or issue trackers.
 */
export function redactClaimUrl(url: string): string {
  return url.replace(/([?&])claim=[^&]*/g, '$1claim=<redacted>');
}

/**
 * Prepare a raw HTTP response body for safe display in error messages.
 *
 * Strips non-printable characters, collapses whitespace, and truncates.
 */
export function sanitizeBody(raw: string, maxLen = 120): string {
  // Strip non-printable / control characters (keep printable ASCII + common Unicode)
  // eslint-disable-next-line no-control-regex
  let cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '');
  // Collapse consecutive whitespace to a single space
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (cleaned.length === 0) {
    return '(empty body)';
  }

  if (cleaned.length > maxLen) {
    return cleaned.slice(0, maxLen) + '...';
  }

  return cleaned;
}
