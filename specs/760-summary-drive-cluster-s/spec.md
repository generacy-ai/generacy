# Feature Specification: Drive Cluster GitHub Identity from Acting Account

**Branch**: `760-summary-drive-cluster-s` | **Date**: 2026-06-05 | **Status**: Draft
**Issue**: [generacy-ai/generacy#760](https://github.com/generacy-ai/generacy/issues/760)

## Summary

Drive the cluster's GitHub identity (`GH_USERNAME`/`GH_EMAIL`) from a user-selected **acting account** threaded through the github-app credential, instead of the GitHub App installation's `accountLogin`. This is the consumer half of a two-repo change; the producer half (an "Act as" account picker at activation that seals `gitIdentityLogin`) is the companion generacy-cloud issue.

## Why

`GH_USERNAME` serves two purposes in a cluster:

- **git commit attribution** — `setup/auth.ts` / `setup/workspace.ts` set `git config user.name` / `user.email` from it.
- **cluster assignee identity** — `orchestrator/src/services/identity.ts` resolves the label-monitor assignee filter from it.

Today, `packages/control-plane/src/services/wizard-env-writer.ts:50` sets `GH_USERNAME = accountLogin` (the account the GitHub App **installation** is on). For an **org-owned repo**, the only installation that can access it is the org's, so `accountLogin` is the **org name** (e.g. `Painworth`). That:

- mis-attributes commits to the org, and
- breaks label monitoring — `filterByAssignee` filters to the org, and issues (always assigned to a *person*) are silently dropped at **debug** level, so the cluster appears to do nothing.

Operators currently must hand-set the `CLUSTER_GITHUB_USERNAME` override on every org cluster. Users also want to act as a dedicated bot account (e.g. `pw-dev-bot`) independent of which installation grants repo access.

## User Stories

### US1: Cluster operator activating an org-owned repo

**As a** cluster operator activating Generacy against an org-owned GitHub repo,
**I want** the cluster's git identity and label-monitor assignee filter to use the acting account I selected at activation time,
**So that** commits are attributed to me (or a bot account I chose) and the cluster picks up issues assigned to that account — without manually setting `CLUSTER_GITHUB_USERNAME`.

**Acceptance Criteria**:
- [ ] When the github-app credential includes `gitIdentityLogin`, `GH_USERNAME` is derived from it (not from `accountLogin`).
- [ ] `GH_EMAIL` is derived from the same `gitIdentityLogin` value (`<login>@users.noreply.github.com`).
- [ ] An org-installation cluster whose acting account is a user (e.g. `pw-dev-bot`) resolves identity to that user with no `CLUSTER_GITHUB_USERNAME` override.

### US2: Existing cluster with sealed credential (pre-`gitIdentityLogin`)

**As an** operator of an existing cluster whose github-app credential was sealed before `gitIdentityLogin` existed,
**I want** the cluster to keep working with the old credential shape,
**So that** I'm not forced to re-seal credentials just to upgrade.

**Acceptance Criteria**:
- [ ] Credentials without `gitIdentityLogin` fall back to `accountLogin` (current behavior).
- [ ] No error or warning that breaks startup; behavior is identical to today for these credentials.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `wizard-env-writer.ts` MUST emit `GH_USERNAME` and `GH_EMAIL` from the github-app credential's `gitIdentityLogin` field when present. | P1 | Located at `packages/control-plane/src/services/wizard-env-writer.ts:50`. |
| FR-002 | When `gitIdentityLogin` is absent (older sealed credentials), `wizard-env-writer.ts` MUST fall back to `accountLogin` for backward compatibility. | P1 | No-regression guarantee for existing clusters. |
| FR-003 | `GH_EMAIL` MUST be derived as `<login>@users.noreply.github.com` from whichever login source wins (gitIdentityLogin or accountLogin fallback). | P1 | Matches existing email derivation pattern. |
| FR-004 | The misleading comment in `packages/orchestrator/src/services/identity.ts` that calls `GH_USERNAME` "the human account the installation belongs to" MUST be corrected to describe it as the operator-selected acting account. | P2 | Documentation correctness only — no runtime behavior change. |
| FR-005 | `wizard-env-writer.test.ts` MUST be updated to cover both code paths: credential with `gitIdentityLogin` (preferred path) and credential without it (fallback path). | P1 | Test coverage for the new branch. |
| FR-006 | (Optional, defense-in-depth) When the resolved identity matches a known-org pattern and no other identity sources are available, `identity.ts` SHOULD log an actionable warning rather than silently filtering everything out. | P3 | Optional — improves diagnosability of misconfigured clusters. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Org-installation clusters with a user acting account resolve identity correctly without `CLUSTER_GITHUB_USERNAME` override. | 100% | Manual verification: activate a cluster on an org-owned repo, pick a user acting account, confirm `GH_USERNAME` matches the picked user, confirm label monitor picks up issues assigned to that user. |
| SC-002 | Backward compatibility: clusters with pre-existing sealed github-app credentials (no `gitIdentityLogin`) start successfully. | 100% | Regression test in `wizard-env-writer.test.ts` covering the fallback path. |
| SC-003 | Code change is localized. | ≤ 3 production files modified (wizard-env-writer.ts, identity.ts, optional test) | File diff in PR. |

## Assumptions

- The companion generacy-cloud issue (producer half) will land before or with this change, sealing `gitIdentityLogin` into newly-issued github-app credentials.
- The github-app credential is already JSON-parsed in `wizard-env-writer.ts` (per #592, #628 already extract `token` and `accountLogin` from the JSON value), so adding a `gitIdentityLogin` extraction is a small addition to existing logic.
- `gitIdentityLogin`, when present, is a valid GitHub login string (no further validation required at the consumer).
- The existing `<login>@users.noreply.github.com` email derivation pattern is acceptable for the new login source.

## Out of Scope

- The producer half: adding the "Act as" account picker UI/flow at activation in generacy-cloud. (Companion issue, separate repo, separate PR.)
- Re-sealing existing github-app credentials to include `gitIdentityLogin` (handled by re-issuing/re-activating, not by this change).
- Removing the `CLUSTER_GITHUB_USERNAME` env-var override — it remains as an escape hatch.
- Changes to `setup/auth.ts` / `setup/workspace.ts` git-config logic (they already consume `GH_USERNAME`/`GH_EMAIL` correctly; only the upstream source is changing).
- Changes outside `packages/control-plane` and `packages/orchestrator` (e.g., the credhelper credential type definitions live in `@generacy-ai/credhelper` and will inherit the new optional field via the producer-side change).

## Dependencies

- **Companion (producer):** generacy-cloud issue — adds the "Act as" account picker at activation and seals `gitIdentityLogin` into the github-app credential. This issue consumes that field. (Per the one-issue-per-repo convention.)
- Resolves the root cause behind #756 (org login used as cluster identity).

## Files Likely Affected

- `packages/control-plane/src/services/wizard-env-writer.ts` (primary)
- `packages/control-plane/src/services/__tests__/wizard-env-writer.test.ts` (test coverage)
- `packages/orchestrator/src/services/identity.ts` (comment fix, optional warning)

---

*Generated by speckit*
