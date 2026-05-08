# Clarifications: Differentiated 4xx error messages in `generacy launch`

## Batch 1 — 2026-05-08

### Q1: Claim code redaction in error URLs
**Context**: US2 requires error messages to include the target URL for debugging. The URL contains the claim code as a query parameter (`?claim=<code>`). For 404 (wrong cloud) the claim is still valid and usable — showing it in error output, logs, or screenshots could leak a live claim to anyone viewing the output.
**Question**: Should the claim code be redacted from the URL shown in error messages (e.g. `?claim=****`), or shown in full?
**Options**:
- A: Redact the claim code in the URL (e.g. `?claim=<redacted>`)
- B: Show the full URL including the claim code

**Answer**: *Pending*

### Q2: Error type — plain Error vs structured class
**Context**: The current code throws plain `Error` objects. Callers (e.g. `launch/index.ts:106`) catch these and display `message`. If a structured error class were used (e.g. `CloudError` with `statusCode`, `detail`, `url` properties), callers could programmatically react differently — for example, auto-retry on 429 using the `Retry-After` value, or offer different remediation steps based on status code.
**Question**: Should the fix use a custom error class with structured fields (statusCode, detail, url), or keep throwing plain `Error` with improved message strings?
**Options**:
- A: Plain `Error` with better messages (simplest, matches current pattern)
- B: Custom `CloudError` class with structured fields (enables programmatic handling by callers)

**Answer**: *Pending*

### Q3: Fallback when 4xx body is not JSON
**Context**: FR-002 says "Graceful fallback if body isn't JSON or lacks `detail`" but doesn't specify what the fallback message contains. The body could be an HTML error page, an empty string, or plain text. The error message needs to remain useful without the `detail` field.
**Question**: When a 4xx response body cannot be parsed as JSON or lacks a `detail` field, what should the error message show besides the status code and URL?
**Options**:
- A: Show only status code and URL (e.g. "Cloud returned 400 from <url>")
- B: Show status code, URL, and a truncated raw body (first ~120 chars)

**Answer**: *Pending*
