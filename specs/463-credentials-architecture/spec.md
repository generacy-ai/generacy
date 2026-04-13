# Feature Specification: Core Credential Type Plugins

**Branch**: `463-credentials-architecture` | **Date**: 2026-04-13 | **Status**: Draft

**Context:** Credentials Architecture — Phase 3, part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md). See decision #2 and the "Core plugin initial set" section.

**Depends on:** Phase 2 (#460 plugin loader, #461 daemon, #462 config loading)

**Parallel with:** #464 and #465

## Summary

Implement 7 core credential type plugins in `packages/credhelper/src/plugins/`. Each plugin implements the `CredentialTypePlugin` interface (defined in #458 at `packages/credhelper/src/types/plugin.ts`) and registers with the plugin loader from #460. These plugins cover the essential credential types needed by the platform: GitHub tokens (app and PAT), cloud provider credentials (GCP, AWS), payment API keys (Stripe), generic API keys, and legacy env-var passthrough.

## Plugins to Implement

### 1. `github-app` — Short-lived GitHub App installation tokens

- **Method**: `mint()` — calls GitHub API to create installation access token scoped to role's repositories + permissions
- **Supported exposures**: `['env', 'git-credential-helper']`
- **Scope schema**: validates `repositories: string[]` and `permissions: Record<string, string>` (contents, pull_requests, issues, workflows, etc.)
- **Credential schema**: validates `appId`, `installationId`, `privateKey` (backend ref)

### 2. `github-pat` — Static GitHub Personal Access Token

- **Method**: `resolve()` — reads token from backend (env var or cloud secret store)
- **Supported exposures**: `['env', 'git-credential-helper']`
- **Scope schema**: none (PATs are pre-scoped by the user)
- **Credential schema**: validates `backendKey`

### 3. `gcp-service-account` — Impersonation-based service account tokens

- **Method**: `mint()` — uses GCP IAM API to generate short-lived access token via service account impersonation
- **Supported exposures**: `['env', 'gcloud-external-account']`
- **Scope schema**: validates `scopes: string[]` (e.g. `cloud-platform`, `cloud-platform.read-only`)
- **Credential schema**: validates `serviceAccountEmail`, `lifetime?`

### 4. `aws-sts` — AssumeRole with session policy

- **Method**: `mint()` — calls AWS STS AssumeRole with the role's session policy
- **Supported exposures**: `['env']` (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
- **Scope schema**: validates `roleArn: string`, `sessionPolicy?: object`
- **Credential schema**: validates `roleArn`, `externalId?`, `region?`

### 5. `stripe-restricted-key` — Static Stripe restricted API key

- **Method**: `resolve()` — reads key from backend
- **Supported exposures**: `['env']`
- **Scope schema**: none (Stripe restricted keys are pre-scoped)
- **Credential schema**: validates `backendKey`

### 6. `api-key` — Generic static API key

- **Method**: `resolve()` — reads key from backend
- **Supported exposures**: `['env', 'localhost-proxy']`
- **Credential schema**: validates `backendKey`, `envName?`

### 7. `env-passthrough` — Process env passthrough (legacy compatibility)

- **Method**: `resolve()` — reads `process.env[backendKey]`
- **Supported exposures**: `['env']`
- **Scope schema**: none — zero abuse-prevention path for existing env var setups
- **Credential schema**: validates `envVar: string`

## Plugin Interface Contract

Each plugin must provide (per `CredentialTypePlugin` in `types/plugin.ts`):

- `type: string` — unique identifier matching the credential type name
- `credentialSchema: ZodSchema` — validates the credential declaration from `credentials.yaml`
- `scopeSchema?: ZodSchema` — validates the role's `scope:` block (optional)
- `supportedExposures: ExposureKind[]` — which exposure kinds this plugin supports
- Either `mint(ctx: MintContext)` or `resolve(ctx: ResolveContext)` (not both)
- `renderExposure(kind, secret, cfg): ExposureOutput` — for each supported exposure kind

## Exposure Rendering

Each plugin's `renderExposure()` must handle its declared exposure kinds:

| Exposure Kind | Return Type | Description |
|---|---|---|
| `env` | `{ kind: 'env', entries: Array<{ key, value }> }` | Key-value pairs for session env file |
| `git-credential-helper` | `{ kind: 'git-credential-helper', script: string }` | Shell script that calls the data socket |
| `gcloud-external-account` | `{ kind: 'gcloud-external-account', json: object }` | External account JSON with `credential_source.url` pointing at data socket |
| `localhost-proxy` | `{ kind: 'localhost-proxy', proxyConfig: { port, upstream, headers } }` | Proxy configuration for localhost forwarding |

## User Stories

### US1: Platform operator provisions cloud credentials for AI agents

**As a** platform operator,
**I want** to configure credential plugins for GitHub, GCP, and AWS so that AI agent sessions receive scoped, short-lived tokens,
**So that** agents have least-privilege access and tokens auto-expire, reducing blast radius if compromised.

**Acceptance Criteria**:
- [ ] `github-app` plugin mints installation tokens with only the repositories and permissions specified in the role
- [ ] `gcp-service-account` plugin mints impersonation tokens with the specified OAuth scopes
- [ ] `aws-sts` plugin assumes a role with the specified session policy
- [ ] All minted tokens include an expiry time

### US2: Developer uses existing env vars without migration

**As a** developer with an existing `.env`-based workflow,
**I want** the `env-passthrough` plugin to read my environment variables unchanged,
**So that** I can adopt the credential helper without rewriting my local setup.

**Acceptance Criteria**:
- [ ] `env-passthrough` reads from `process.env` using the configured key
- [ ] Existing `.env` files continue to work with no changes
- [ ] The `env` exposure renders the same key-value pairs the developer expects

### US3: Application uses third-party API keys securely

**As a** platform operator configuring third-party integrations,
**I want** static API keys (Stripe, generic) resolved from a secret backend and exposed via env or localhost proxy,
**So that** raw secrets are fetched on-demand rather than stored in plaintext config.

**Acceptance Criteria**:
- [ ] `stripe-restricted-key` resolves keys from the configured backend
- [ ] `api-key` supports both `env` and `localhost-proxy` exposure kinds
- [ ] `localhost-proxy` exposure returns proper proxy config with upstream and auth headers

### US4: Git operations use credential helper for seamless auth

**As a** developer or AI agent performing git operations,
**I want** GitHub credentials exposed via `git-credential-helper`,
**So that** `git clone`, `git push`, and `git fetch` authenticate transparently without manual token management.

**Acceptance Criteria**:
- [ ] `github-app` and `github-pat` plugins support `git-credential-helper` exposure
- [ ] `renderExposure` for `git-credential-helper` produces a valid shell script
- [ ] The shell script calls the daemon's data socket to fetch the token

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Each plugin exports a default object implementing `CredentialTypePlugin` | P1 | Must pass loader validation in `validate.ts` |
| FR-002 | Each plugin declares a `credentialSchema` (Zod) matching expected YAML structure | P1 | Validated against credential entries in `credentials.yaml` |
| FR-003 | Minting plugins (`github-app`, `gcp-service-account`, `aws-sts`) return `{ value: Secret, expiresAt: Date }` | P1 | TTL-aware; daemon uses `expiresAt` for refresh scheduling |
| FR-004 | Resolving plugins (`github-pat`, `stripe-restricted-key`, `api-key`, `env-passthrough`) return `Secret` | P1 | Stateless fetch from backend |
| FR-005 | `renderExposure()` produces correct `ExposureOutput` discriminated union for each supported kind | P1 | Must match types in `types/exposure.ts` |
| FR-006 | `scopeSchema` (where present) validates role-level scope blocks from `roles.yaml` | P1 | `github-app`, `gcp-service-account`, `aws-sts` |
| FR-007 | All plugins register with the plugin loader from #460 | P1 | Discovered via package naming convention or core plugin paths |
| FR-008 | `env-passthrough` reads directly from `process.env` without a backend client call | P2 | Special case — no `BackendClient` needed |
| FR-009 | `github-app` constructs the correct GitHub API request for installation token creation | P1 | Must include JWT auth from app private key |
| FR-010 | `aws-sts` passes session policy document when provided in scope | P1 | Policy restricts the assumed role's permissions |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Plugin count | 7/7 plugins implemented | All plugins pass loader validation |
| SC-002 | Schema validation coverage | 100% of credential + scope schemas | Unit tests with valid and invalid inputs |
| SC-003 | Exposure rendering coverage | All declared exposure kinds per plugin | Unit tests for each plugin × exposure combination |
| SC-004 | Mint/resolve correctness | All plugins return correct Secret format | Unit tests with mocked backends and APIs |
| SC-005 | Loader registration | All 7 plugins discovered and loaded | Integration test with plugin loader from #460 |

## Assumptions

- Phase 2 deliverables are complete: plugin loader (#460), daemon (#461), and config loading (#462)
- The `CredentialTypePlugin` interface in `types/plugin.ts` is stable and will not change during this phase
- `BackendClient.fetchSecret()` is implemented and available for resolve-type plugins
- GitHub API, GCP IAM API, and AWS STS API calls will be mocked in tests (no live API calls in CI)
- Core plugins are discovered by path (not by npm package naming convention) — they live inside `packages/credhelper/src/plugins/`

## Out of Scope

- Community/third-party plugin distribution and verification (handled by plugin loader #460)
- Credential rotation scheduling (handled by daemon #461)
- `docker-socket-proxy` exposure kind (not required by any of the 7 core plugins)
- Live API integration tests against GitHub, GCP, or AWS (mocks only in this phase)
- UI for credential management
- Plugin hot-reloading

---

*Generated by speckit*
