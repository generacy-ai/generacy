# Tasks: Differentiated 4xx Error Messages in `generacy launch`

**Input**: Design documents from `/specs/547-problem-cli-s-launch/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 Create `CloudError` class and helpers (`packages/generacy/src/cli/commands/launch/cloud-error.ts`). Export `CloudError extends Error` with fields: `statusCode`, `url`, `detail?`, `retryAfter?`, `problemType?`. Export `redactClaimUrl(url)` — replaces `claim=<value>` with `claim=<redacted>`. Export `sanitizeBody(raw, maxLen?)` — strips non-printables, collapses whitespace, truncates to 120 chars with `...`, returns `"(empty body)"` for empty input.

- [X] T002 Add status-code dispatch to `fetchLaunchConfig()` in `packages/generacy/src/cli/commands/launch/cloud-client.ts`. Replace the catch-all 4xx block (lines 96-98) with: (1) parse response body as JSON best-effort, (2) extract `detail` and `type` from RFC 7807 body, (3) build redacted URL via `redactClaimUrl()`, (4) dispatch on status code per the message table (400, 401/403, 404, 410, 429, other 4xx), (5) throw `CloudError` with structured fields. When `detail` is absent and body is non-empty, use `sanitizeBody()` for fallback display.

- [X] T003 Thread `Retry-After` header through the HTTP response promise in `cloud-client.ts`. Change the resolved type from `{ status, body }` to `{ status, body, retryAfter? }` by reading `res.headers['retry-after']` inside the response callback (line ~75).

- [X] T004 Redact claim code in debug log at `packages/generacy/src/cli/commands/launch/index.ts:94`. Change `logger.debug({ claimCode }, 'Using claim code')` to `logger.debug({ claimCode: '<redacted>' }, 'Using claim code')`.

## Phase 2: Tests

- [X] T005 [P] Create `packages/generacy/src/cli/commands/launch/__tests__/cloud-error.test.ts`. Unit tests for: `CloudError` constructor and all field access, `redactClaimUrl()` with various URL formats (with claim param, without, multiple params, encoded values), `sanitizeBody()` truncation at 120 chars, non-printable stripping, whitespace collapsing, empty body returns `"(empty body)"`.

- [X] T006 [P] Update `packages/generacy/src/cli/commands/launch/__tests__/cloud-client.test.ts`. Replace the two existing generic 4xx tests (lines 125-145) with per-status-code tests: (1) 400 throws `CloudError` with `statusCode: 400` and message containing "rejected the claim format", (2) 401 throws with message containing "unauthenticated", (3) 404 throws with message containing "not found" and "GENERACY_CLOUD_URL", (4) 410 throws with message containing "consumed or expired", (5) 429 throws with `retryAfter` field populated from `Retry-After` header, (6) 418 (other 4xx) throws with message containing "Cloud returned 418". Add tests: JSON body with `detail` field is surfaced in message, non-JSON body shows truncated sanitized body, claim code is NOT present in `error.url` or `error.message`.

## Dependencies & Execution Order

1. **T001** first — `CloudError` class and helpers are imported by everything else.
2. **T002 + T003** after T001 — both modify `cloud-client.ts` and should be done together (T003 is a small change within the same function modified by T002).
3. **T004** after T001 — independent file change, but logically part of the same fix.
4. **T005 and T006** in parallel after T001-T004 — they test different files and have no data dependencies.

**Parallel opportunities**: T005 and T006 can run in parallel. T002 and T003 modify the same file and should be done sequentially (or as one editing pass).
