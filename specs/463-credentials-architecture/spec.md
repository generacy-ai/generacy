# Feature Specification: ## Credentials Architecture — Phase 3 (parallel with #464 and #465)

**Context:** Part of the [credentials architecture plan](https://github

**Branch**: `463-credentials-architecture` | **Date**: 2026-04-14 | **Status**: Draft

## Summary

## Credentials Architecture — Phase 3 (parallel with #464 and #465)

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md). See decision #2 and the "Core plugin initial set" section.

**Depends on:** Phase 2 (#460 plugin loader, #461 daemon, #462 config loading)

## What needs to be done

Implement the 7 core credential type plugins inside `packages/credhelper/src/plugins/` (or as separate files within the credhelper package). Each plugin implements the `CredentialTypePlugin` interface defined in #458.

### Plugins to implement

1. **`github-app`** — Mints short-lived GitHub App installation tokens, scoped per role
   - `mint()`: calls GitHub API to create installation access token with the role's repository + permission scope
   - `supportedExposures`: `['env', 'git-credential-helper']`
   - `scopeSchema`: validates `repositories[]` and `permissions{}` (contents, pull_requests, issues, workflows, etc.)

2. **`github-pat`** — Static GitHub Personal Access Token (for legacy/personal-dev use)
   - `resolve()`: reads token from backend (env var or cloud)
   - `supportedExposures`: `['env', 'git-credential-helper']`
   - No scope validation (PATs are pre-scoped by the user)

3. **`gcp-service-account`** — Impersonation-based service account access tokens
   - `mint()`: uses GCP IAM API to generate short-lived access token via service account impersonation
   - `supportedExposures`: `['env', 'gcloud-external-account']`
   - `scopeSchema`: validates `scopes[]` (e.g. `cloud-platform`, `cloud-platform.read-only`)

4. **`aws-sts`** — AssumeRole with session policy
   - `mint()`: calls AWS STS AssumeRole with the role's session policy
   - `supportedExposures`: `['env']` (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
   - `scopeSchema`: validates `roleArn`, `sessionPolicy?`

5. **`stripe-restricted-key`** — Static Stripe restricted API key (native scoping)
   - `resolve()`: reads key from backend
   - `supportedExposures`: `['env']`
   - No scope validation (Stripe restricted keys are pre-scoped)

6. **`api-key`** — Generic static API key
   - `resolve()`: reads key from backend
   - `supportedExposures`: depends on plugin declaration — for keys that shouldn't be raw-exposed, restrict to `['localhost-proxy']` only
   - For the generic `api-key` type: `supportedExposures: ['env', 'localhost-proxy']`

7. **`env-passthrough`** — Reads `process.env` via the `env` backend (legacy compatibility)
   - `resolve()`: reads `process.env[backendKey]`
   - `supportedExposures`: `['env']`
   - No scope validation — this is the honest "zero abuse-prevention" path for existing env var setups

### Each plugin must provide

- `type` string matching the naming convention
- `credentialSchema` (Zod) validating the credential declaration from `credentials.yaml`
- `scopeSchema` (Zod, optional) validating the role's `scope:` block for this credential type
- `supportedExposures` array
- Either `mint()` or `resolve()` (not both)
- `renderExposure()` for each supported exposure kind

### Exposure rendering

Each plugin's `renderExposure()` must handle its supported exposure kinds:
- `env`: return `{ key: string, value: string }` pairs for the session env file
- `git-credential-helper`: return a shell script that calls the data socket
- `gcloud-external-account`: return an external account JSON with `credential_source.url` pointing at the data socket
- `localhost-proxy`: return proxy config `{ port, upstream, headers }`

## Acceptance criteria

- All 7 plugins implement `CredentialTypePlugin` correctly
- Each plugin's `credentialSchema` validates correctly against the example YAML from the plan
- Each plugin's `scopeSchema` validates role scope blocks correctly
- `env-passthrough` works as a drop-in for existing `.env` workflows
- `github-app` mint correctly scopes installation tokens (can be tested with mock GitHub API)
- `gcp-service-account` mint correctly requests impersonation tokens (can be tested with mock GCP API)
- Unit tests for each plugin: schema validation, mint/resolve with mocked backends, exposure rendering
- All plugins register correctly with the plugin loader from #460

## Phase grouping

- **Phase 3** — parallel with #464 and #465
- **Rebuild cluster after Phase 3 completes**

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
