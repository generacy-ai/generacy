# Bug Fix Specification: CLI launch-config schema: dev/clone repos should be string[], not single string

`npx generacy launch` fails Zod validation against the cloud's launch-config response for any project with dev or clone repos.

**Issue**: [#528](https://github.com/generacy-ai/generacy/issues/528) | **Branch**: `528-context-npx-generacy-launch` | **Date**: 2026-05-01 | **Status**: Draft | **Labels**: v1.5, v1.5/phase-5, v1.5/blocker

## Summary

The CLI's `LaunchConfigSchema` declares `repos.dev` and `repos.clone` as `z.string().optional()`, but the cloud API returns these fields as `string[]`. This causes Zod validation to reject every launch-config response, breaking `npx generacy launch --claim=<code>` for all projects. The fix is a one-line schema change plus verification that downstream consumers handle arrays correctly.

## Root Cause

- `packages/generacy/src/cli/commands/launch/types.ts:28-29` declares `dev: z.string().optional()` and `clone: z.string().optional()`.
- The cloud API (`services/api/src/services/launch-config.ts:16-20` in generacy-cloud) returns `dev: project.devRepos` and `clone: project.cloneRepos`, where both are `string[]`.
- Zod rejects the response because it receives an array where it expects a string.
- This fails for all projects — even single-repo projects send `["repo-url"]` (array of length 1), not `"repo-url"`.

## Files

- `packages/generacy/src/cli/commands/launch/types.ts:28-29` — change `dev`/`clone` schema from `z.string().optional()` to `z.array(z.string()).optional()`.
- Any consumers of `launchConfig.repos.dev` / `.clone` in the launch flow — verify array-compatible usage.
- Test files that mock the launch-config response shape — update mocks to use arrays.

## Fix

```typescript
// LaunchConfigSchema repos field
repos: z.object({
  primary: z.string(),
  dev: z.array(z.string()).optional(),
  clone: z.array(z.string()).optional(),
}),
```

Verify that any consumer of `launchConfig.repos.dev` / `.clone` handles arrays correctly. These fields are informational for the user; actual cloning is handled cluster-side after activation.

## User Stories

### US1: Developer launches a multi-repo project

**As a** developer onboarding to Generacy,
**I want** `npx generacy launch --claim=<code>` to succeed regardless of how many dev/clone repos my project has,
**So that** I can complete first-run cluster setup without errors.

**Acceptance Criteria**:
- [ ] Launch succeeds for projects with multiple dev/clone repos
- [ ] Launch succeeds for projects with zero dev/clone repos (empty arrays)
- [ ] Launch succeeds for projects with exactly one dev/clone repo

### US2: Developer launches a project with no optional repos

**As a** developer with a simple project (primary repo only),
**I want** the launch command to handle missing or empty `dev`/`clone` arrays gracefully,
**So that** the onboarding flow doesn't break on optional fields.

**Acceptance Criteria**:
- [ ] Launch succeeds when `dev` and `clone` are absent from the response
- [ ] Launch succeeds when `dev` and `clone` are empty arrays (`[]`)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `LaunchConfigSchema.repos.dev` typed as `z.array(z.string()).optional()` | P0 | Blocker fix |
| FR-002 | `LaunchConfigSchema.repos.clone` typed as `z.array(z.string()).optional()` | P0 | Blocker fix |
| FR-003 | All consumers of `repos.dev`/`repos.clone` handle `string[] \| undefined` | P0 | Type safety |
| FR-004 | Test mocks updated to reflect array shape | P1 | Prevent regression |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zod validation pass rate | 100% for valid cloud responses | Unit test with array payloads |
| SC-002 | Type-check | Zero errors across launch flow | `pnpm tsc --noEmit` in `packages/generacy` |
| SC-003 | Backward compat | No regressions in existing launch tests | Full test suite pass |

## Acceptance Criteria (from issue)

- `LaunchConfigSchema.repos.dev` and `.clone` are typed as `string[]` (optional arrays).
- `npx generacy launch --claim=<code>` succeeds against a project with multiple dev/clone repos.
- `npx generacy launch --claim=<code>` succeeds against a project with empty `devRepos` / `cloneRepos` arrays (zero repos).
- Existing tests updated where they mocked the response shape.
- Type-check passes across the launch flow (any consumers of these fields adapted to array shape).

## Assumptions

- The cloud API consistently returns `dev` and `clone` as arrays (confirmed from generacy-cloud source).
- These fields are informational in the CLI — actual repo cloning is handled cluster-side post-activation.
- No other CLI commands consume `LaunchConfigSchema` beyond the launch flow.

## Out of Scope

- Cloud-side fix for activation poll response missing `cluster_api_key_id` (separate issue).
- Changes to the generacy-cloud API response format.
- Any scaffolder or compose template changes (repos fields are informational only).

---

*Generated by speckit*
