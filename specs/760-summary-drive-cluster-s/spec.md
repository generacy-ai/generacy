# Feature Specification: ## Summary

Drive the cluster's GitHub identity (`GH_USERNAME`/`GH_EMAIL`) from a user-selected **acting account** threaded through the github-app credential, instead of the installation's `accountLogin`

**Branch**: `760-summary-drive-cluster-s` | **Date**: 2026-06-05 | **Status**: Draft

## Summary

## Summary

Drive the cluster's GitHub identity (`GH_USERNAME`/`GH_EMAIL`) from a user-selected **acting account** threaded through the github-app credential, instead of the installation's `accountLogin`. This is the consumer half of a two-repo change; the producer half (an "Act as" account picker at activation that seals `gitIdentityLogin`) is the companion generacy-cloud issue.

## Why

`GH_USERNAME` serves two purposes:
- **git commit attribution** — `setup/auth.ts` / `setup/workspace.ts` set `git config user.name`/`user.email` from it.
- **cluster assignee identity** — `orchestrator/src/services/identity.ts` resolves the label-monitor assignee filter from it.

Today `wizard-env-writer.ts:50` sets `GH_USERNAME = accountLogin` (the account the GitHub App **installation** is on). For an **org-owned repo**, the only installation that can access it is the org's, so `accountLogin` is the **org name** (e.g. `Painworth`). That:
- mis-attributes commits to the org, and
- breaks label monitoring — `filterByAssignee` filters to the org, and issues (always assigned to a *person*) are silently dropped at **debug** level, so the cluster appears to do nothing.

Operators currently must hand-set the `CLUSTER_GITHUB_USERNAME` override on every org cluster. Users also want to act as a dedicated bot account (e.g. `pw-dev-bot`) independent of which installation grants repo access.

## Scope (this repo)

- **`packages/control-plane/src/services/wizard-env-writer.ts`** — extract `gitIdentityLogin` from the **top level** of the github-app credential JSON (alongside existing `token` / `accountLogin`, per Q2/A). Use it to drive `GH_USERNAME` and the local-part of `GH_EMAIL` when present and non-empty after trimming; **fall back to `accountLogin`** otherwise. Empty-string and whitespace-only `gitIdentityLogin` are treated as missing (trim before length check, per Q3/C), matching existing `accountLogin` handling.
- **`packages/orchestrator/src/services/identity.ts`** — fix the misleading comment (it claims `GH_USERNAME` is "the human account the installation belongs to" — false for org installs); now it's the operator-selected acting account. **No change to resolution order** (per Q4/A): `CLUSTER_GITHUB_USERNAME` (`configUsername`) still wins over `GH_USERNAME` as the manual escape hatch.
- Update `wizard-env-writer.test.ts` accordingly: cover the new top-level field, trim/empty-string fallback, and missing-field fallback.

## Acceptance criteria

- [ ] When the github-app credential includes `gitIdentityLogin`, `GH_USERNAME` and `GH_EMAIL` are derived from it.
- [ ] Credentials without `gitIdentityLogin` still fall back to `accountLogin` (no regression for existing clusters).
- [ ] `identity.ts` comment accurately describes `GH_USERNAME` as the selected acting account.
- [ ] An org-installation cluster whose acting account is a user (e.g. `pw-dev-bot`) resolves identity to that user with **no `CLUSTER_GITHUB_USERNAME` override**.

## Dependencies

- **Companion (producer):** generacy-cloud issue — adds the "Act as" account picker at activation and seals `gitIdentityLogin` into the github-app credential. This issue consumes that field. (Per our one-issue-per-repo convention.)
- Resolves the root cause behind #756 (org login used as cluster identity).

## User Stories

### US1: Org-installation operator gets correct cluster identity

**As an** operator running a cluster against an org-owned repo via an org-level GitHub App installation,
**I want** the cluster's `GH_USERNAME` / `GH_EMAIL` to come from the acting account I selected at activation (e.g. `pw-dev-bot`),
**So that** commits are attributed correctly and the label-monitor's assignee filter actually matches my open issues — without me having to hand-set `CLUSTER_GITHUB_USERNAME`.

**Acceptance Criteria**:
- [ ] On a fresh org-cluster activation where the producer (#812) seals `gitIdentityLogin: "pw-dev-bot"` into the github-app credential, `wizard-env-writer.ts` emits `GH_USERNAME=pw-dev-bot` and `GH_EMAIL=pw-dev-bot@users.noreply.github.com` to `wizard-credentials.env`.
- [ ] The cluster's label monitor matches issues assigned to `pw-dev-bot` (no zero-results silent-drop).
- [ ] Operators do not need to set `CLUSTER_GITHUB_USERNAME` for this case.

### US2: Legacy clusters continue working unchanged

**As an** operator with an existing cluster whose github-app credential was sealed **before** `gitIdentityLogin` existed,
**I want** my cluster to keep deriving identity from `accountLogin` exactly as it does today,
**So that** the rollout of the producer-side change does not break clusters whose credentials haven't yet been re-sealed.

**Acceptance Criteria**:
- [ ] When `gitIdentityLogin` is absent, empty, or whitespace-only, `GH_USERNAME` / `GH_EMAIL` derive from `accountLogin` (current behavior).
- [ ] An operator who has set `CLUSTER_GITHUB_USERNAME` continues to see that value win — resolution order in `resolveClusterIdentity` is unchanged.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `wizard-env-writer.ts` MUST read `gitIdentityLogin` from the top level of the parsed github-app credential JSON (same nesting level as `token` and `accountLogin`). | P1 | Q2/A |
| FR-002 | When `gitIdentityLogin` is a non-empty string after `.trim()`, the writer MUST use its trimmed value as `GH_USERNAME` and as the local-part of `GH_EMAIL` (`<login>@users.noreply.github.com`). | P1 | Q3/C |
| FR-003 | When `gitIdentityLogin` is missing, not a string, empty, or whitespace-only after `.trim()`, the writer MUST fall back to `accountLogin` using the existing trim-and-length-check logic. | P1 | Q3/C; back-compat for pre-#812 credentials |
| FR-004 | `identity.ts`'s comment describing `GH_USERNAME` MUST be updated to state it is the operator-selected acting account, not "the human account the installation belongs to". | P2 | Documentation-only fix; no logic change |
| FR-005 | `identity.ts`'s resolution order MUST remain unchanged: `CLUSTER_GITHUB_USERNAME` (`configUsername`) wins over `GH_USERNAME`. | P1 | Q4/A — env var stays an explicit escape hatch |
| FR-006 | ~~When the only resolvable identity matches a known-org pattern with no other identity source, log an actionable warning.~~ | — | **Deferred** per Q1/A. Out of scope for this PR; the useful variant ("warn when resolved identity matches no open-issue assignee") will be folded into the cluster-side backstop in #762. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Org-cluster activations with a sealed `gitIdentityLogin` produce the correct user-account `GH_USERNAME` with no `CLUSTER_GITHUB_USERNAME` override. | 100% of post-#812 activations | Inspect `wizard-credentials.env` on a freshly-activated org cluster after #812 ships; expect `GH_USERNAME=<picked acting account>`. |
| SC-002 | Pre-#812 credentials (no `gitIdentityLogin` field) continue to produce the legacy `accountLogin`-based identity. | No regression on existing clusters | `wizard-env-writer.test.ts` covers absent-field, empty-string, whitespace-only, and non-string cases; all assert fallback to `accountLogin`. |
| SC-003 | `CLUSTER_GITHUB_USERNAME` escape hatch still overrides every other source. | Order unchanged | `identity.test.ts` (or equivalent) asserts `configUsername` wins over `GH_USERNAME` even when `GH_USERNAME` came from `gitIdentityLogin`. |

## Assumptions

- The producer (generacy-cloud#812) seals `gitIdentityLogin` at the **top level** of the github-app credential JSON, in the shape `{ ...installationData, token, expiresAt, gitIdentityLogin }`. This consumer reads it via `parsed.gitIdentityLogin` and does not require any nested-object support.
- `accountLogin` continues to be emitted by the producer's credential-refresh path (it is still needed for non-identity uses), so the fallback branch remains live indefinitely — not just for legacy credentials.
- `GH_EMAIL` continues to use the `@users.noreply.github.com` pattern; only the local-part changes from `accountLogin` to the chosen identity. Custom-domain commit emails are not in scope.

## Out of Scope

- **FR-006 (org-pattern warning in `identity.ts`).** Deferred per Q1/A. Detecting User vs Organization from a login string is non-trivial (`gh api /users/<login>` or heuristic) and the new field reduces the failure mode this warning was meant to surface. A reframed version ("no open-issue assignee matches resolved identity") is being folded into #762's cluster-side backstop.
- **Producer-side changes.** The "Act as" account picker at activation, the credential-sealing logic, and any cloud UI lives in generacy-cloud#812 and is consumed-only here.
- **`CLUSTER_GITHUB_USERNAME` deprecation.** The env-var override remains a supported escape hatch with unchanged precedence (Q4/A); removing or warning on it is a separate decision.
- **Cache invalidation on credential refresh.** Re-reading credentials after a cloud-pushed refresh is already handled by `handlePutCredential` (#614) and is not modified by this change.

---

*Generated by speckit*
