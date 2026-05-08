# Feature Specification: ## Problem

The CLI's launch-config fetcher at [packages/generacy/src/cli/commands/launch/cloud-client

**Branch**: `547-problem-cli-s-launch` | **Date**: 2026-05-08 | **Status**: Draft

## Summary

## Problem

The CLI's launch-config fetcher at [packages/generacy/src/cli/commands/launch/cloud-client.ts:96-98](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/launch/cloud-client.ts#L96-L98) maps every HTTP 4xx response to a single user-facing string:

```ts
if (raw.status >= 400 && raw.status < 500) {
  throw new Error('Claim code is invalid or expired');
}
```

The CLI then surfaces this verbatim in [launch/index.ts:106](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/launch/index.ts#L106) as `Failed to fetch launch configuration: <msg>`. From the user's perspective, every 4xx looks identical — and most 4xx responses are *not* expired claims.

## Why this matters

During the v1.5 staging walkthrough on 2026-05-07/08, **three structurally distinct bugs** all surfaced as identical "Claim code is invalid or expired" messages, making each one disproportionately hard to diagnose:

1. **401 Unauthorized** — [auth middleware in the activate sub-router was leaking onto sibling routes](https://github.com/generacy-ai/generacy-cloud/pull/515). The launch-config endpoint was supposed to be unauthenticated, but a `app.use('*', requireAuth())` in a sibling sub-app caught the request first. Took ~30 minutes to track down with full GCP-side log access; would have been instant if the CLI had said "401 Unauthorized" instead of "expired".
2. **400 Invalid Claim (regex rejection)** — [the validator regex didn't match the mint alphabet](https://github.com/generacy-ai/generacy-cloud/pull/516). About 40% of fresh claims contained a `-` or `_` (base64url alphabet) and got rejected by `/^[A-Za-z0-9]{16}$/`. Looked identical to "expired" — user would mint a new claim, hit it again, mint another, intermittent until they happened to get one without `-` or `_`. Burned a full debug session before being noticed.
3. **404 Not Found (claim minted in different cloud)** — when `GENERACY_CLOUD_URL` defaults to prod but the claim was minted in staging. Prod returns 404 because the claim doesn't exist there. Same misleading string. Cost the user multiple "the deploy must have rolled back" hypothesis chases.

There's also a fourth class — 429 rate-limit — that would surface as "expired" today, with even less actionable feedback (the user would just keep retrying and making the rate limit worse).

## Proposed fix

Differentiate by status code in the cloud client. Suggested mapping:

| Status | Message |
|---|---|
| 400 | "The cloud rejected the claim format (got `<status>: <body.detail>` from `<url>`). Generate a fresh claim from your project page." |
| 401 / 403 | "The cloud rejected this request as unauthenticated (`<status>` from `<url>`). The claim endpoint should be public — this likely means the cloud is misconfigured. Report this with the URL above." |
| 404 | "The claim was not found at `<url>`. Did you mint the claim in a different environment? Set `GENERACY_CLOUD_URL` (or `--cloud-url`, see #545) to the cloud where the claim was minted." |
| 410 | "Claim has been consumed or expired (one-time-use, 10-min TTL). Generate a fresh claim from your project page." |
| 429 | "Rate-limited by the cloud (`Retry-After: <header>`). Wait and retry, or stop scripting `launch` calls." |
| Other 4xx | "Cloud returned `<status>` (`<body.detail>` from `<url>`). Report this if it persists." |

The cloud already returns RFC 7807 `application/problem+json` bodies with `type`, `title`, `detail`, `instance` — the CLI should at minimum surface `body.detail` in the error message rather than discarding it.

## Open questions for clarify phase

- **Q1**: Should the CLI use the response's `type` URI (e.g. `https://generacy.ai/problems/invalid-claim`, `.../claim-expired`, `.../rate-limited`) as the dispatch key instead of HTTP status? More precise (distinguishes "expired" from "consumed" from "format-invalid", all of which are 400/410), but couples the CLI to the exact problem-type vocabulary. Status-code dispatch is simpler and degrades gracefully.
- **Q2**: Should the CLI ever expose the raw response URL in the user-facing error? Helpful for debugging "wrong cloud" scenarios but leaks the cloud URL into screenshots if the user reports the issue.
- **Q3**: Should the same lossy-mapping pattern be audited elsewhere in the CLI? The same anti-pattern likely lives in `deploy/cloud-client.ts` (re-exports `fetchLaunchConfig`) and possibly other commands that talk to the cloud.

## Reproduction (any of three)

- **401**: Hit a launch-config endpoint while [generacy-ai/generacy-cloud#515](https://github.com/generacy-ai/generacy-cloud/pull/515) is unmerged.
- **400 regex**: With [generacy-ai/generacy-cloud#516](https://github.com/generacy-ai/generacy-cloud/pull/516) unmerged, mint claims until one contains a `-` or `_`.
- **404 wrong-cloud**: Mint a claim on staging.generacy.ai, run `npx -y @generacy-ai/generacy@preview launch --claim=<code>` without setting `GENERACY_CLOUD_URL`. Hits prod, 404s, surfaces as "expired".

All three say the same thing.

## Related

- generacy-ai/generacy-cloud#515 — auth middleware leak (one of the three)
- generacy-ai/generacy-cloud#516 — regex/base64url alphabet (two of the three)
- generacy-ai/generacy-cloud#518 — copy-paste UX (the three are easier to avoid if the cloud emits a complete command)
- #545 — `--cloud-url` flag (related to the 404 case)

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
