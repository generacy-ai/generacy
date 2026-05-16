# Feature Specification: Scoped Private-Registry Credentials for `generacy launch`

**Branch**: `639-context-generacy-launch-cli` | **Date**: 2026-05-16 | **Status**: Draft
**Issue**: [#639](https://github.com/generacy-ai/generacy/issues/639) | **Milestone**: v1.6 Phase 2 Track B

## Summary

Extend the `generacy launch` CLI's `pullImage` function to authenticate against private container registries using credentials from the cloud-issued `LaunchConfig`, without modifying the user's machine-wide Docker config. A scoped, ephemeral `DOCKER_CONFIG` directory is written per-pull and cleaned up afterward.

## User Stories

### US1: Project admin with private cluster image

**As a** project admin who configured a private container image in Generacy cloud,
**I want** `generacy launch` to authenticate automatically using the credentials I configured,
**So that** I don't have to manually run `docker login` before launching.

**Acceptance Criteria**:
- [ ] `pullImage` uses cloud-provided credentials when present in LaunchConfig
- [ ] Pull succeeds without any prior `docker login` on the user's machine
- [ ] User's `~/.docker/config.json` is never read or modified

### US2: Technical user with ambient Docker auth

**As a** technical user who already has `docker login ghcr.io` configured,
**I want** `generacy launch` to fall through to my existing Docker config when no credentials are provided,
**So that** my existing workflow is unaffected.

**Acceptance Criteria**:
- [ ] No-creds path behaves identically to current implementation
- [ ] No scoped config directory is created when creds are absent

### US3: User encountering auth errors

**As a** user whose registry credentials are invalid or expired,
**I want** clear error messages telling me what went wrong and how to fix it,
**So that** I can resolve the issue without debugging Docker internals.

**Acceptance Criteria**:
- [ ] 401 errors produce a message referencing both cloud-configured and ambient auth paths
- [ ] 404 errors produce a message referencing the image URL

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `pullImage` accepts optional `registryCredentials: { url, username, password }` parameter | P1 | Signature change |
| FR-002 | When creds provided, write `<projectDir>/.docker/config.json` with base64-encoded auth for registry host | P1 | Standard Docker config format |
| FR-003 | Set `DOCKER_CONFIG=<projectDir>/.docker` env var for the `docker compose pull` subprocess only | P1 | Process-scoped, not global |
| FR-004 | Delete `<projectDir>/.docker/` directory after pull completes (success or failure) | P1 | `finally` block cleanup |
| FR-005 | When no creds provided, run `docker compose pull` without `DOCKER_CONFIG` override | P1 | Ambient fallback |
| FR-006 | Parse Docker pull stderr for 401/unauthorized → emit scoped auth failure message | P2 | Error UX |
| FR-007 | Parse Docker pull stderr for 404/not found → emit image-not-found message | P2 | Error UX |
| FR-008 | `LaunchConfigSchema` extended with optional `registryCredentials` field | P1 | Zod schema update |

## Technical Design

### Scoped Docker Config Format

```json
{
  "auths": {
    "ghcr.io": {
      "auth": "<base64(username:password)>"
    }
  }
}
```

### Flow

1. `pullImage(projectDir, registryCredentials?)` called from launch orchestration
2. If `registryCredentials` present:
   a. Create `<projectDir>/.docker/` directory
   b. Write `config.json` with auth entry (mode 0600)
   c. Run `docker compose pull` with `DOCKER_CONFIG` env override
   d. In `finally`: remove `<projectDir>/.docker/` recursively
3. If no credentials: run `docker compose pull` with inherited env (existing behavior)

### Files Modified

- `packages/generacy/src/cli/commands/launch/compose.ts` — `pullImage` signature + scoped config logic
- `packages/generacy/src/cli/commands/launch/types.ts` — `LaunchConfigSchema` gains `registryCredentials`
- `packages/generacy/src/cli/commands/launch/index.ts` — Thread `registryCredentials` from config to `pullImage`

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | No-creds path unchanged | Zero behavioral delta | Existing test suite passes unchanged |
| SC-002 | Scoped config cleanup | 100% cleanup rate | Test verifies dir removed on success and failure |
| SC-003 | User Docker config untouched | Never written | Test asserts `~/.docker/config.json` unchanged |
| SC-004 | Test coverage | 4 cases minimum | no-creds, with-creds happy, cleanup-on-failure, ambient-fallback |

## Assumptions

- Cloud-side `LaunchConfig` payload includes `registryCredentials` when configured (generacy-cloud#594)
- Docker CLI respects `DOCKER_CONFIG` env var for auth resolution
- Registry credential format is username+password (not token-only or OAuth)
- `<projectDir>/.docker/` does not conflict with user files (unlikely, `.docker` is not a standard project file)

## Out of Scope

- Forwarding creds to the cluster's credhelper after launch (sibling issue)
- `generacy update` re-pull path (sibling issue)
- `generacy registry-login` subcommand (sibling issue)
- Multi-registry auth (single registry per LaunchConfig for now)

## Dependencies

- **generacy-ai/generacy-cloud#594** — LaunchConfig payload includes `registryCredentials` field

---

*Generated by speckit*
