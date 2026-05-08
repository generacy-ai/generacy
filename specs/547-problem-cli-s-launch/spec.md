# Feature Specification: Differentiated 4xx error messages in `generacy launch`

**Branch**: `547-problem-cli-s-launch` | **Date**: 2026-05-08 | **Status**: Draft

## Summary

The CLI's `fetchLaunchConfig()` in `packages/generacy/src/cli/commands/launch/cloud-client.ts` collapses all HTTP 4xx responses into a single "Claim code is invalid or expired" message. This makes structurally different failures (auth misconfiguration, format rejection, wrong cloud environment, rate limiting) indistinguishable from the user's perspective. The fix replaces the blanket 4xx handler with status-code-specific error messages that surface the cloud's RFC 7807 `detail` field.

## Background

During the v1.5 staging walkthrough (2026-05-07/08), three distinct bugs all surfaced as the same misleading error:

1. **401** — Auth middleware leak on the cloud side (generacy-cloud#515). The claim endpoint should be unauthenticated.
2. **400** — Claim format regex rejected base64url characters `-` and `_` (generacy-cloud#516). ~40% of fresh claims were silently invalid.
3. **404** — Claim minted in staging but CLI defaulted to prod. Claim doesn't exist there.

A fourth class (429 rate-limit) would also collapse into the same message, causing users to retry and worsen the rate limit.

The root cause is `cloud-client.ts:96-98`:
```ts
if (raw.status >= 400 && raw.status < 500) {
  throw new Error('Claim code is invalid or expired');
}
```

The cloud already returns RFC 7807 `application/problem+json` bodies with `type`, `title`, `detail`, `instance` — the CLI discards all of it.

## User Stories

### US1: Developer diagnosing a failed launch

**As a** developer running `generacy launch --claim=<code>`,
**I want** the CLI to tell me *why* the claim was rejected (wrong format, wrong cloud, auth error, expired, rate-limited),
**So that** I can fix the problem myself without needing server-side log access.

**Acceptance Criteria**:
- [ ] A 400 response shows the cloud's `detail` field and suggests generating a fresh claim
- [ ] A 401/403 response identifies the issue as an auth misconfiguration and suggests reporting it
- [ ] A 404 response suggests the user may be pointing at the wrong cloud environment
- [ ] A 410 response indicates the claim was consumed or expired
- [ ] A 429 response shows the `Retry-After` header value and advises waiting
- [ ] Any other 4xx shows the status code and `detail` from the response body

### US2: Platform engineer debugging cloud-side issues

**As a** platform engineer supporting users,
**I want** CLI errors to include the request URL and HTTP status code,
**So that** I can quickly identify which cloud endpoint is misbehaving.

**Acceptance Criteria**:
- [ ] Error messages include the HTTP status code
- [ ] Error messages include the target URL (cloud endpoint)
- [ ] The `detail` field from the RFC 7807 response body is surfaced when present

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Replace blanket 4xx handler in `fetchLaunchConfig()` with per-status-code error messages | P1 | Single site: `cloud-client.ts:96-98` |
| FR-002 | Parse response body as JSON and extract RFC 7807 `detail` field when present | P1 | Graceful fallback if body isn't JSON or lacks `detail` |
| FR-003 | Map 400 to format-rejection message including `detail` and URL | P1 | |
| FR-004 | Map 401/403 to auth-misconfiguration message including status and URL | P1 | |
| FR-005 | Map 404 to wrong-environment message suggesting `GENERACY_CLOUD_URL` / `--cloud-url` | P1 | References #545 |
| FR-006 | Map 410 to consumed/expired message | P1 | Only status that should say "expired" |
| FR-007 | Map 429 to rate-limit message including `Retry-After` header value | P2 | Requires reading response headers |
| FR-008 | Map other 4xx to generic message with status, `detail`, and URL | P1 | Catch-all |
| FR-009 | Deploy command inherits fix automatically (re-exports `fetchLaunchConfig`) | P1 | `deploy/cloud-client.ts` re-exports; no separate change needed |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Distinct error messages for each status code class | 6 distinct messages (400, 401/403, 404, 410, 429, other) | Unit tests |
| SC-002 | RFC 7807 `detail` field surfaced in error message | Present when cloud returns it | Unit tests with mock responses |
| SC-003 | No regression in happy path | `fetchLaunchConfig` still returns valid `LaunchConfig` on 200 | Existing tests pass |
| SC-004 | Deploy command coverage | Same improved errors via re-export | Verify re-export unchanged |

## Assumptions

- The cloud returns RFC 7807 `application/problem+json` bodies on error responses (confirmed in issue)
- The `detail` field may not always be present; the code must degrade gracefully to just showing the status code
- Response headers (e.g. `Retry-After`) are accessible from the existing `node:http` response object
- The `deploy/cloud-client.ts` re-export means fixing `launch/cloud-client.ts` automatically fixes deploy

## Out of Scope

- Switching dispatch key from HTTP status to RFC 7807 `type` URI (Q1 from issue — deferred, status-code dispatch is simpler and degrades gracefully)
- Adding `--cloud-url` flag to the CLI (#545 — separate issue)
- Auditing other CLI commands for similar lossy error mapping (Q3 — follow-up)
- Changing the cloud's error response format

---

*Generated by speckit*
