# Data Model: CloudError and Helpers

## Core Entity: `CloudError`

```typescript
/**
 * Structured error for HTTP 4xx responses from the Generacy cloud.
 * Extends Error for backward compatibility with existing catch blocks.
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
}
```

### Constructor Input

```typescript
interface CloudErrorOptions {
  statusCode: number;
  url: string;       // already redacted by caller
  message: string;   // user-facing message
  detail?: string;
  retryAfter?: string;
  problemType?: string;
}
```

## Helper: `redactClaimUrl`

```typescript
/**
 * Replace the claim query parameter value with <redacted>.
 * Input:  "https://api.generacy.ai/api/clusters/launch-config?claim=abc123"
 * Output: "https://api.generacy.ai/api/clusters/launch-config?claim=<redacted>"
 */
function redactClaimUrl(url: string): string
```

**Rules**:
- Matches `claim=<any-non-ampersand-chars>` in query string
- Replaces value with literal `<redacted>`
- If no `claim` param found, returns URL unchanged
- Works on both URL objects serialized to string and raw path+search strings

## Helper: `sanitizeBody`

```typescript
/**
 * Prepare a raw HTTP response body for display in error messages.
 * Strips non-printable characters, collapses whitespace, truncates.
 */
function sanitizeBody(raw: string, maxLen?: number): string
```

**Rules**:
- Default `maxLen`: 120
- Strip characters outside printable ASCII + common Unicode (regex: control chars)
- Collapse consecutive whitespace to single space
- Trim leading/trailing whitespace
- If result exceeds `maxLen`, truncate and append `...`
- Empty string after sanitization returns `"(empty body)"`

## Internal Type: Extended HTTP Response

```typescript
/** Resolved value from the HTTP request promise in fetchLaunchConfig */
interface RawResponse {
  status: number;
  body: string;
  retryAfter?: string;  // NEW — from res.headers['retry-after']
}
```

## Status-Code to Message Mapping

| Status | Fields Used | Message Pattern |
|--------|------------|-----------------|
| 400 | `statusCode`, `detail`, `url` | Format rejection with detail |
| 401, 403 | `statusCode`, `url` | Auth misconfiguration hint |
| 404 | `url` | Wrong-cloud hint with `GENERACY_CLOUD_URL` |
| 410 | — | Consumed/expired, regenerate |
| 429 | `retryAfter` | Rate limit with wait hint |
| Other 4xx | `statusCode`, `detail`, `url` | Generic with detail |

## Relationships

```
fetchLaunchConfig() ──throws──▶ CloudError
                                   │
                                   ├── .message     (human-readable, for display)
                                   ├── .statusCode  (for programmatic branching)
                                   ├── .url         (redacted, for diagnostics)
                                   ├── .detail      (from cloud body, optional)
                                   ├── .retryAfter  (for 429 auto-retry, optional)
                                   └── .problemType (for future use, optional)

launch/index.ts  ──catches──▶ displays error.message via p.log.error()
deploy/index.ts  ──catches──▶ (same pattern, inherits fix via re-export)
```
