# Research: Differentiated 4xx Error Messages

## Technology Decisions

### 1. Dispatch Key: HTTP Status Code vs RFC 7807 `type` URI

**Decision**: HTTP status code as primary dispatch key.

**Rationale**: The cloud already returns RFC 7807 `application/problem+json` bodies, but dispatching on the `type` URI would couple the CLI to specific cloud error taxonomy. HTTP status codes are universal, self-documenting, and degrade gracefully when the cloud response isn't JSON (e.g., upstream proxy HTML error pages from Cloud Run or Cloudflare).

**Alternative considered**: Dispatching on `body.type` URI. Rejected because it fails when the body isn't JSON, adds coupling to cloud-specific error types, and provides no UX advantage for this use case. The `type` URI is captured as `problemType` on the error class for potential future use.

### 2. Error Representation: Plain Error vs Custom Class

**Decision**: `CloudError extends Error` with structured fields.

**Rationale**: The dispatch table already needs `statusCode` and `body.detail` internally; promoting them to class fields is trivial overhead. Benefits:
- Enables programmatic 429 auto-retry using `retryAfter` field
- Callers can branch on `statusCode` without parsing message strings
- `instanceof Error` still holds — backward compatible with all existing catch blocks
- `deploy/cloud-client.ts` (same consumer) benefits identically

**Alternative considered**: Plain `Error` with improved message strings. Simpler but prevents programmatic handling. Rejected per clarification Q2 answer.

### 3. Claim Code Redaction Strategy

**Decision**: Replace `claim=<value>` with `claim=<redacted>` in all error output and debug logs.

**Rationale**: Claims are live bootstrap secrets (~10-min TTL, one-time use). Users routinely paste CLI output into Slack, GitHub issues, and screenshots. The hostname and path in the URL provide the diagnostic value (which cloud environment was hit); the claim value itself adds no diagnostic information.

**Implementation**: Pure function `redactClaimUrl(url)` using simple string replacement on the serialized URL. Applied to:
- `CloudError.url` field
- Debug log at `launch/index.ts:94`

### 4. Non-JSON Body Fallback

**Decision**: Show status code + redacted URL + first 120 chars of sanitized raw body.

**Rationale**: HTML error pages from upstream proxies (Cloud Run 502, Cloudflare 403) are common in production. Even 120 chars reveals distinctive markers (e.g., `<title>502 Bad Gateway</title>` or `Cloudflare` brand). Sanitization strips non-printable characters and collapses whitespace to keep output terminal-safe.

## Implementation Patterns

### Status-Code Dispatch Table

The pattern is a simple switch/if-else chain in the 4xx handler, not a lookup map. Reasons:
- Each case constructs a message with different interpolated fields
- Only 6 cases (400, 401/403, 404, 410, 429, default) — a map adds indirection without simplification
- Matches the existing code style in `cloud-client.ts`

### Response Header Capture

The existing `raw` promise resolves `{ status, body }`. Extended to `{ status, body, retryAfter? }` by reading `res.headers['retry-after']` inside the response callback. Minimal change, no structural refactor needed.

### File Organization

`CloudError` and helpers (`redactClaimUrl`, `sanitizeBody`) go in a new `cloud-error.ts` file rather than inlining in `cloud-client.ts`. Reasons:
- Keeps `cloud-client.ts` focused on HTTP mechanics
- Error class is importable by callers who want `instanceof CloudError` checks
- Helpers are independently testable

## Key Sources

- [RFC 7807 — Problem Details for HTTP APIs](https://tools.ietf.org/html/rfc7807): The cloud's error response format. Fields: `type`, `title`, `status`, `detail`, `instance`.
- [RFC 8628 — OAuth 2.0 Device Authorization Grant](https://tools.ietf.org/html/rfc8628): Referenced by the activation flow; `slow_down` response is analogous to 429 handling.
- Issue #547 reproduction cases: 401 (auth middleware leak), 400 (regex rejection), 404 (wrong cloud environment).
