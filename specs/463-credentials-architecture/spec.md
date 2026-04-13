# Feature Specification: Core Credential Type Plugins (7 plugins)

**Branch**: `463-credentials-architecture` | **Date**: 2026-04-13 | **Status**: Draft

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md). See decision #2 and the "Core plugin initial set" section.

**Depends on:** Phase 2 (#460 plugin loader, #461 daemon, #462 config loading)

## Summary

Implement the 7 core credential type plugins inside `packages/credhelper/src/plugins/`. Each plugin implements the `CredentialTypePlugin` interface from `packages/credhelper/src/types/plugin.ts`, providing Zod schemas for validation, either a `mint()` or `resolve()` method for credential acquisition, and `renderExposure()` for each supported exposure kind. These plugins cover the initial set of credential types: GitHub (App + PAT), cloud providers (GCP, AWS), payment (Stripe), generic API keys, and legacy env-var passthrough.

## Plugins to Implement

### 1. `github-app` — Short-lived GitHub App installation tokens
- **Method**: `mint()` — calls GitHub API to create installation access token scoped to role's repositories + permissions
- **Exposures**: `['env', 'git-credential-helper']`
- **Scope schema**: validates `repositories[]` and `permissions{}` (contents, pull_requests, issues, workflows, etc.)

### 2. `github-pat` — Static GitHub Personal Access Token
- **Method**: `resolve()` — reads token from backend
- **Exposures**: `['env', 'git-credential-helper']`
- **Scope schema**: none (PATs are pre-scoped by user)

### 3. `gcp-service-account` — Impersonation-based access tokens
- **Method**: `mint()` — uses GCP IAM API for short-lived access token via service account impersonation
- **Exposures**: `['env', 'gcloud-external-account']`
- **Scope schema**: validates `scopes[]` (e.g. `cloud-platform`, `cloud-platform.read-only`)

### 4. `aws-sts` — AssumeRole with session policy
- **Method**: `mint()` — calls AWS STS AssumeRole with role's session policy
- **Exposures**: `['env']` (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
- **Scope schema**: validates `roleArn`, `sessionPolicy?`

### 5. `stripe-restricted-key` — Static Stripe restricted API key
- **Method**: `resolve()` — reads key from backend
- **Exposures**: `['env']`
- **Scope schema**: none (Stripe restricted keys are pre-scoped)

### 6. `api-key` — Generic static API key
- **Method**: `resolve()` — reads key from backend
- **Exposures**: `['env', 'localhost-proxy']`
- **Scope schema**: none

### 7. `env-passthrough` — Legacy env var passthrough
- **Method**: `resolve()` — reads `process.env[backendKey]`
- **Exposures**: `['env']`
- **Scope schema**: none — zero abuse-prevention path for existing env var setups

### Plugin Interface Contract

Each plugin must provide (per `CredentialTypePlugin` in `types/plugin.ts`):
- `type: string` — unique identifier matching naming convention
- `credentialSchema: ZodSchema` — validates credential declaration from `credentials.yaml`
- `scopeSchema?: ZodSchema` — validates role's `scope:` block (optional)
- `supportedExposures: ExposureKind[]` — declared exposure kinds
- Either `mint(ctx: MintContext)` or `resolve(ctx: ResolveContext)` (not both)
- `renderExposure(kind, secret, cfg): ExposureOutput` — for each supported exposure kind

### Exposure Rendering

- **`env`**: return `{ key: string, value: string }` pairs for session env file
- **`git-credential-helper`**: return shell script calling the data socket
- **`gcloud-external-account`**: return external account JSON with `credential_source.url` pointing at data socket
- **`localhost-proxy`**: return proxy config `{ port, upstream, headers }`

## User Stories

### US1: Platform Operator Configures GitHub App Credentials

**As a** platform operator,
**I want** to declare a `github-app` credential in `credentials.yaml` and have the daemon mint scoped installation tokens automatically,
**So that** CI agents and development environments receive least-privilege GitHub tokens without manual PAT management.

**Acceptance Criteria**:
- [ ] `github-app` plugin validates `appId`, `installationId`, `privateKey` via `credentialSchema`
- [ ] `mint()` requests installation token scoped to the role's repositories and permissions
- [ ] Token is exposed via `env` and `git-credential-helper` exposure kinds
- [ ] Minted tokens have correct TTL and expire as configured

### US2: Developer Uses Existing Env Vars Without Migration

**As a** developer with existing `.env`-based credential workflows,
**I want** to use `env-passthrough` credentials as a drop-in replacement,
**So that** I can adopt the credentials architecture incrementally without changing my existing setup.

**Acceptance Criteria**:
- [ ] `env-passthrough` reads the correct environment variable via `process.env[backendKey]`
- [ ] Works without any backend client calls
- [ ] Exposed via `env` exposure kind with the original variable name

### US3: Cloud Engineer Configures Cross-Account AWS Access

**As a** cloud engineer,
**I want** to declare `aws-sts` credentials with per-role session policies,
**So that** each role gets time-limited AWS credentials scoped to only the permissions it needs.

**Acceptance Criteria**:
- [ ] `aws-sts` plugin validates `roleArn` and optional `sessionPolicy` via scope schema
- [ ] `mint()` calls STS AssumeRole and returns temporary credentials
- [ ] Credentials are exposed as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`

### US4: Platform Operator Proxies Sensitive API Keys

**As a** platform operator,
**I want** to expose generic API keys via `localhost-proxy` instead of raw environment variables,
**So that** sensitive keys are never written to disk or visible in the process environment.

**Acceptance Criteria**:
- [ ] `api-key` plugin supports both `env` and `localhost-proxy` exposure kinds
- [ ] `renderExposure('localhost-proxy', ...)` returns valid proxy config with upstream and auth headers

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Each plugin exports a valid `CredentialTypePlugin` object | P1 | Must pass runtime validation in `loader/validate.ts` |
| FR-002 | `credentialSchema` for each plugin validates against example YAML from architecture plan | P1 | Zod `.parse()` must succeed for valid configs, throw for invalid |
| FR-003 | `scopeSchema` for plugins with scoping validates role scope blocks | P1 | `github-app`, `gcp-service-account`, `aws-sts` |
| FR-004 | `mint()` plugins call correct external API with proper scoping | P1 | Mock APIs in tests |
| FR-005 | `resolve()` plugins fetch secrets via `BackendClient.fetchSecret()` | P1 | Except `env-passthrough` which reads `process.env` |
| FR-006 | `renderExposure()` produces correct output for each declared exposure kind | P1 | Output must match `ExposureOutput` discriminated union |
| FR-007 | All plugins register with the plugin loader from #460 | P1 | Discovered via core plugin path scanning |
| FR-008 | `env-passthrough` works as drop-in for existing `.env` workflows | P1 | No backend client dependency |
| FR-009 | `github-app` mint scopes installation tokens to role's repo + permission set | P1 | Matches GitHub Apps API |
| FR-010 | `gcp-service-account` mint uses IAM impersonation API | P1 | Short-lived access tokens |
| FR-011 | `aws-sts` mint calls AssumeRole with session policy | P1 | Returns triple: access key, secret, session token |
| FR-012 | `git-credential-helper` exposure produces valid shell script | P2 | Script calls data socket |
| FR-013 | `gcloud-external-account` exposure produces valid external account JSON | P2 | `credential_source.url` points at data socket |
| FR-014 | `localhost-proxy` exposure produces valid proxy config | P2 | `{ port, upstream, headers }` |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Plugin count | 7/7 implemented | All plugins load and register correctly |
| SC-002 | Schema validation coverage | 100% | Unit tests for valid + invalid configs for each plugin |
| SC-003 | Mint/resolve test coverage | 100% of plugins | Each plugin tested with mocked backends/APIs |
| SC-004 | Exposure rendering coverage | All declared kinds per plugin | Unit test for each (plugin, exposure) pair |
| SC-005 | Loader integration | All 7 discovered | Plugins found via core path discovery and registered in plugin map |

## Assumptions

- Phase 2 artifacts are complete: plugin loader (#460), daemon (#461), config loading (#462)
- `CredentialTypePlugin` interface, `ExposureKind`, `MintContext`, `ResolveContext`, `Secret`, and `ExposureOutput` types are stable as defined in `packages/credhelper/src/types/`
- External API calls (GitHub, GCP IAM, AWS STS) will be mocked in tests; no real credentials needed
- Core plugins are trusted by path and skip verification (per `loader/verify.ts`)

## Out of Scope

- Community/third-party plugin development and distribution
- Credential rotation policies (handled by daemon session manager)
- UI for credential configuration
- Backend implementations (env, cloud secret managers) — already handled by #462
- Docker socket proxy exposure kind (listed in `ExposureKind` type but not assigned to any core plugin)

## Open Questions

See `clarifications.md` for 5 pending clarification questions (Q1–Q5) that affect implementation details around config access, exposure rendering responsibility, file structure, AWS roleArn placement, and env-passthrough backendKey mapping.

---

*Generated by speckit*
