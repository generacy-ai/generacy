# Feature Specification: ## Credentials Architecture — Critical Integration Gap (Phase 7a)

**Context:** Part of the [credentials architecture plan](https://github

**Branch**: `481-credentials-architecture` | **Date**: 2026-04-15 | **Status**: Draft

## Summary

## Credentials Architecture — Critical Integration Gap (Phase 7a)

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md). Discovered during end-to-end verification after Phase 6 landed.

**Blocks:** ALL credential resolution. Currently every `BackendClient.fetchSecret()` call returns an empty string, so no credential works end-to-end — not even env-backed ones.

**Related:** #462 (config loading — the stub comment blames this issue but #462 shipped only YAML parsing, not the factory)

## Problem

[packages/credhelper-daemon/src/session-manager.ts](packages/credhelper-daemon/src/session-manager.ts) has **four stubbed `BackendClient` instantiations**:

- Line 91: `backend: { fetchSecret: async () => '' }, // Stub — real backend client from #462`
- Line 115: `backend: { fetchSecret: async () => '' },`
- Line 131: `backend: { fetchSecret: async () => '' },`
- Line 145: `backend: { fetchSecret: async () => '' },`

Every plugin that calls `ctx.backend.fetchSecret(ctx.backendKey)` during mint or resolve gets an empty string back. This means:

- `env-passthrough` plugin reads empty string instead of `process.env[backendKey]` → every env-based credential resolves to empty
- `github-app` plugin gets empty private key → installation token minting fails
- `gcp-service-account` plugin gets empty SA email → impersonation fails
- `stripe-restricted-key`, `api-key`, `github-pat` all return empty strings
- `aws-sts` gets empty AWS credentials → AssumeRole fails

**Net effect: the entire credhelper daemon is non-functional for credential resolution regardless of which backend is configured.**

The daemon can start, sessions can begin, session directories are rendered — but the rendered `env` file contains empty values, git-credential-helper scripts return empty tokens, and every workflow that depends on credentials fails with authentication errors.

## What needs to be done

### 1. Define a `BackendClientFactory`

Design a minimal factory that takes a backend config entry and returns a working `BackendClient`:

```typescript
// packages/credhelper-daemon/src/backends/types.ts
export interface BackendClientFactory {
  create(backend: BackendConfig): BackendClient;
}
```

Backend type dispatch can be a simple switch for v1.5 (two types: `env` and `generacy-cloud`). A full plugin system for backend types is overkill until there's demand for community backend plugins.

### 2. Implement the `env` backend

```typescript
// packages/credhelper-daemon/src/backends/env-backend.ts
export class EnvBackend implements BackendClient {
  async fetchSecret(key: string): Promise<string> {
    const value = process.env[key];
    if (value === undefined) {
      throw new BackendSecretNotFoundError(`env var '${key}' is not set`);
    }
    return value;
  }
}
```

Fail closed: throw a clear error if the env var isn't set, don't return an empty string. The error should name the key (helpful for debugging) but not log the value anywhere.

### 3. Stub the `generacy-cloud` backend

Create a placeholder that throws `NotImplementedError` when `fetchSecret` is called. This unblocks env-based testing without committing to the cloud backend implementation (which depends on the session-token work — see the follow-up issue).

```typescript
// packages/credhelper-daemon/src/backends/generacy-cloud-backend.ts
export class GeneracyCloudBackend implements BackendClient {
  async fetchSecret(_key: string): Promise<string> {
    throw new Error(
      'generacy-cloud backend not yet implemented — see follow-up issue. ' +
      'Use backend: env for now, or wait for cloud backend implementation.',
    );
  }
}
```

This gives users a clear error when they try to use generacy-cloud-backed credentials before the backend is implemented, rather than silently returning empty strings.

### 4. Wire the factory into session-manager

Replace all four stubs at [packages/credhelper-daemon/src/session-manager.ts:91,115,131,145](packages/credhelper-daemon/src/session-manager.ts) with real factory calls:

```typescript
const backendConfig = await this.configLoader.loadBackend(credEntry.backend);
const backend = this.backendFactory.create(backendConfig);
// ... pass `backend` to the plugin's MintContext/ResolveContext
```

The `BackendClientFactory` is injected into `SessionManager` via constructor DI. `credhelper-daemon.ts` wires up the concrete factory at startup.

### 5. Error handling and logging

- `BackendSecretNotFoundError` thrown from the backend should surface as a session begin failure with clear error (role references credential `X`, credential `X` uses backend `env` with key `FOO`, but `FOO` is not set)
- Never log secret values
- Do log which keys are being fetched (for debugging) without values

### 6. Tests

- Unit test `EnvBackend`: key exists returns value, key missing throws, empty-string key value returns empty string (that's valid — user may intentionally set an empty var)
- Unit test `GeneracyCloudBackend` stub: throws NotImplementedError with clear message
- Unit test `BackendClientFactory`: correct dispatch by type, unknown type throws
- Integration test: end-to-end session lifecycle with env-backend credentials (replace the stub mocks in existing tests with the real factory + real process.env setup)

### 7. Update plugin tests

Plugin tests currently mock `BackendClient` inline with `vi.fn().mockResolvedValue('...')`. Those can stay (they test plugin behavior in isolation), but add at least one integration test per plugin that exercises the real `EnvBackend` to catch regressions.

## Acceptance criteria

- All four `{ fetchSecret: async () => '' }` stubs in session-manager.ts replaced with real factory calls
- `env` backend works end-to-end: a credential with `backend: env, backendKey: FOO` returns `process.env.FOO`
- `generacy-cloud` backend throws a clear NotImplementedError (placeholder until follow-up)
- Unknown backend type in `backends.yaml` fails at config load with a clear error
- Existing plugin tests pass
- New integration test exercises a full session with env-backed credentials and a mock plugin

## Phase grouping

- **Phase 7a** — blocker for all credential resolution. Must land before any end-to-end testing is meaningful.
- The companion Phase 7b issue (session-token endpoints + generacy-cloud backend implementation) depends on this one — that issue replaces the `GeneracyCloudBackend` stub with a real implementation.

## Why this slipped through

The stub comment at line 91 blames #462, but #462's spec was limited to YAML file loading and Zod validation — not the runtime factory. The session manager was implemented in #461 with stubs that were expected to be replaced, but no issue explicitly owned the replacement. Testing the daemon end-to-end (rather than with mocked `BackendClient`) would have caught this; the existing test suite uses inline mocks everywhere.

**Recommend** adding an end-to-end integration test to the Phase 7a acceptance criteria that specifically runs the daemon against a real filesystem config with `backend: env` and verifies a non-empty token is resolved. That would have caught this and will prevent future regressions.

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
