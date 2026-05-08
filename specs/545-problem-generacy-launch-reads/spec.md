# Feature Specification: Add `--cloud-url` flag to CLI commands

**Branch**: `545-problem-generacy-launch-reads` | **Date**: 2026-05-08 | **Status**: Draft

## Summary

Add a `--cloud-url <url>` CLI flag to `generacy launch` and `generacy deploy` so that non-production cloud environments can be targeted without shell-specific environment variable syntax. This unblocks the cloud UI's copy-paste onboarding flow (generacy-cloud#518) by providing a platform-agnostic way to embed the cloud URL in the command.

## Problem

`generacy launch` reads the cloud URL from a single source: the `GENERACY_CLOUD_URL` env var, falling back to `https://api.generacy.ai`. This forces users in non-prod environments (staging, dev) to set an env var before running the command — and that syntax differs across PowerShell, bash, fish, and cmd.exe. The cloud UI cannot generate a single copy-paste command that works everywhere.

## Proposed Solution

Add a `--cloud-url <url>` option with this precedence (highest first):

1. `--cloud-url` flag value, if provided
2. `GENERACY_CLOUD_URL` env var, if set
3. `https://api.generacy.ai` (current default)

Apply the same flag and precedence chain to `generacy deploy`.

## User Stories

### US1: Non-prod onboarding via copy-paste

**As a** developer onboarding to a staging/dev Generacy project,
**I want** to paste a single command from the cloud UI that includes the cloud URL,
**So that** I don't need to manually set environment variables or know which shell syntax to use.

**Acceptance Criteria**:
- [ ] `npx generacy launch --claim=<code> --cloud-url=https://api-staging.generacy.ai` works without any env var set
- [ ] The flag overrides `GENERACY_CLOUD_URL` when both are present
- [ ] Omitting both flag and env var defaults to `https://api.generacy.ai`

### US2: Deploy to non-prod environment

**As a** platform engineer deploying a cluster to a BYO VM against staging,
**I want** to pass `--cloud-url` to `generacy deploy`,
**So that** the device-flow activation and launch-config fetch target the correct cloud.

**Acceptance Criteria**:
- [ ] `generacy deploy ssh://user@host --cloud-url=https://api-staging.generacy.ai` activates against staging
- [ ] The same 3-tier precedence applies as in `launch`

### US3: Backward compatibility

**As an** existing user with `GENERACY_CLOUD_URL` set in my shell profile,
**I want** the env var to keep working when I don't pass `--cloud-url`,
**So that** my existing workflow is unaffected.

**Acceptance Criteria**:
- [ ] `GENERACY_CLOUD_URL` is still respected when `--cloud-url` is not provided
- [ ] No breaking changes to existing env-var-based workflows

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `--cloud-url <url>` option to `launch` command | P1 | Commander.js `.option()` |
| FR-002 | Add `--cloud-url <url>` option to `deploy` command | P1 | Same pattern |
| FR-003 | Implement 3-tier resolution: flag > env > default | P1 | Shared helper function |
| FR-004 | Validate `--cloud-url` input as a valid URL with scheme | P2 | Use `z.string().url()` for consistency with existing response validation |
| FR-005 | Pass resolved cloud URL through to `fetchLaunchConfig()` | P1 | Both launch and deploy call this |
| FR-006 | Pass resolved cloud URL to device-flow activation (deploy) | P1 | `activation.ts` uses cloud URL |
| FR-007 | Store resolved cloud URL in `cluster.json` and registry | P1 | Already done post-launch-config fetch; ensure flag value flows through |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Single-command onboarding | Works on bash, PowerShell, fish, cmd.exe | Manual test: paste generated command |
| SC-002 | Backward compat | Existing env-var workflows unchanged | Automated test: env-var-only path |
| SC-003 | Precedence correctness | Flag > env > default | Unit test the resolution helper |

## Assumptions

- The cloud UI (generacy-cloud#518) will embed `--cloud-url=` in generated copy-paste commands once this lands
- `--cloud-url` is verbose form; no short alias needed since primary consumer is generated copy-paste, not hand-typing
- Channel and cloud-url remain decoupled (no auto-selection of cloud URL based on `--channel`)

## Out of Scope

- Adding `--cloud-url` to `status`, `open`, or other commands that read cloud URL from the registry (they already have it stored from launch/deploy)
- Channel-based auto-selection of cloud URL (keeps channel and environment as independent concerns)
- Fixing the lossy 4xx error mapping in `cloud-client.ts` (separate issue)
- Updating the v1.5 onboarding doc (follow-up after this lands)

## Open Questions

- **Q1**: Validate flag input eagerly (Zod `z.string().url()`) or let HTTP client surface errors? Recommendation: validate eagerly for better UX.
- **Q2**: Should a shared `resolveCloudUrl(opts)` helper live in `commands/cluster/` or `cli/utils/`? Recommendation: `cli/utils/` since it's cross-command.

## Related

- generacy-ai/generacy-cloud#518 — companion cloud issue, needs this flag to land first
- Lossy 4xx error mapping in `cloud-client.ts:96-98` — separate issue to file
- v1.5 onboarding doc — update when this lands

---

*Generated by speckit*
