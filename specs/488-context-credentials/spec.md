# Feature Specification: Remove cloud-side credential storage and OIDC code from credhelper-daemon

**Branch**: `488-context-credentials` | **Date**: 2026-04-28 | **Status**: Draft
**Issue**: [#488](https://github.com/generacy-ai/generacy/issues/488) | **Release**: v1.5 / phase-0

## Summary

Remove the now-obsolete cloud-credential-storage (`generacy-cloud` backend) and OIDC-device-flow (session-token auth endpoints) code from `packages/credhelper-daemon`. The credentials architecture was retargeted on 2026-04-25 to use cluster-local storage instead. This is a pure deletion task with no new public APIs.

## Context

The credentials architecture plan was retargeted on 2026-04-25 to drop cloud-side credential storage and OIDC device flow in favor of cluster-local storage. See:
- [docs/credentials-architecture-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md) — "Status update — 2026-04-25 retarget"
- [docs/dev-cluster-architecture.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/dev-cluster-architecture.md)

This issue undoes the work shipped in #482 ("Add session-token endpoints to daemon control server and implement generacy-cloud backend"), which is now obsolete under the retarget. No users depend on this code yet; deletion is safe.

## Scope

Delete the cloud-credential-storage and OIDC-device-flow code paths from `packages/credhelper-daemon`. Update the backend factory error message to point at the cluster-local backend (which lands in v1.5 phase 2).

### Specific deletions

**Source files:**
- `packages/credhelper-daemon/src/backends/generacy-cloud-backend.ts`
- The `'generacy-cloud'` case in `packages/credhelper-daemon/src/backends/factory.ts`
- `packages/credhelper-daemon/src/auth/session-token-store.ts`
- `packages/credhelper-daemon/src/auth/jwt-parser.ts` (if only consumed by `SessionTokenStore` — verify with grep)

**Control server routes:**
- `PUT /auth/session-token`
- `DELETE /auth/session-token`
- `GET /auth/session-token/status`
  in `packages/credhelper-daemon/src/control-server.ts`

**Test files:**
- `__tests__/backends/generacy-cloud-backend.test.ts`
- `__tests__/auth/session-token-store.test.ts`
- `__tests__/auth/jwt-parser.test.ts` (if no other consumers)
- `__tests__/integration/session-token-flow.test.ts`

### Modification

- Update `packages/credhelper-daemon/src/backends/factory.ts` — unknown-backend error message should reference `cluster-local` (forthcoming) and `env` as the valid backend types.

## User Stories

### US1: Maintainer removes obsolete code

**As a** platform maintainer,
**I want** the obsolete cloud-credential and OIDC code removed from the codebase,
**So that** the codebase stays clean and doesn't mislead contributors into using deprecated paths.

**Acceptance Criteria**:
- [ ] All files listed in scope are deleted
- [ ] No dangling imports reference deleted modules
- [ ] Backend factory error message references valid backends (`cluster-local`, `env`)

### US2: Developer sees correct error for unsupported backend types

**As a** developer configuring a credential backend,
**I want** the error message for unknown backend types to list the valid options (`cluster-local`, `env`),
**So that** I can quickly identify and fix misconfiguration.

**Acceptance Criteria**:
- [ ] Unknown backend type error names `cluster-local` and `env`
- [ ] No mention of `generacy-cloud` remains in error messages

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Delete `generacy-cloud-backend.ts` and its factory case | P1 | Pure deletion |
| FR-002 | Delete `session-token-store.ts` and auth endpoints | P1 | 3 routes in control-server |
| FR-003 | Delete `jwt-parser.ts` if no remaining consumers | P1 | Verify with grep first |
| FR-004 | Update backend factory unknown-type error message | P1 | Reference `cluster-local` and `env` |
| FR-005 | Delete all associated test files | P1 | 4 test files |
| FR-006 | Ensure no dangling imports of deleted modules | P1 | Repo-wide grep verification |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Deleted files | All listed files removed | `git diff --stat` shows only deletions + factory edit |
| SC-002 | No dangling references | 0 imports of deleted modules | `grep -r` across repo |
| SC-003 | Test suite passes | All tests green | `pnpm test` at repo root |
| SC-004 | Build succeeds | Clean build | `pnpm build` at repo root |
| SC-005 | No new public APIs | Net-zero or negative API surface | Code review |

## Assumptions

- No users or downstream code depends on the `generacy-cloud` backend or session-token auth endpoints
- The `cluster-local` backend will land in a subsequent v1.5 phase 2 issue
- The `jose` dependency can remain if other code uses it; only remove if `jwt-parser.ts` was its sole consumer

## Out of Scope

- Implementing the `cluster-local` backend (separate phase 2 work)
- Removing the `jose` npm dependency (evaluate separately)
- Changes to `packages/credhelper` shared types package
- Changes to orchestrator launcher credentials integration

---

*Generated by speckit*
