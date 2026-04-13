# Feature Specification: Create @generacy-ai/credhelper Package

**Branch**: `458-credentials-architecture` | **Date**: 2026-04-13 | **Status**: Draft

## Summary

Create a new `@generacy-ai/credhelper` package under `packages/credhelper/` that defines all TypeScript interfaces and Zod schemas for the credentials architecture. This is the **contract-definition phase** (Phase 1) — no runtime implementation, just the type contracts that Phase 2 and Phase 3 will implement against.

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md).
**Depends on:** Phase 0 (#457)
**Parallel with:** #459 and the tetrad-development Dockerfile issue

## What Needs to Be Done

### TypeScript Interfaces

1. **`CredentialTypePlugin`** — the plugin contract:
   - `type: string` (e.g. "github-app", "gcp-service-account")
   - `credentialSchema: ZodSchema` — validates entries in credentials.yaml
   - `scopeSchema?: ZodSchema` — validates role `scope:` blocks
   - `supportedExposures: ExposureKind[]` — which exposure mechanisms this type may use
   - `mint?(ctx: MintContext): Promise<{ value: Secret; expiresAt: Date }>` — for short-lived derived tokens
   - `resolve?(ctx: ResolveContext): Promise<Secret>` — for static values
   - `renderExposure(kind, secret, cfg): ExposureOutput` — render a resolved secret into an exposure form

2. **Session API types** — `BeginSessionRequest`, `BeginSessionResponse`, `EndSessionRequest`

3. **`LaunchRequest` credentials field type** — `{ role: string; uid: number; gid: number }`

4. **Exposure types** — `ExposureKind` enum (`env`, `git-credential-helper`, `gcloud-external-account`, `localhost-proxy`, `docker-socket-proxy`), `ExposureConfig`, `ExposureOutput`

5. **`MintContext` / `ResolveContext`** — what's passed to plugins during credential resolution

### Zod Schemas

1. **`backends.yaml`** — `BackendsConfigSchema` with `schemaVersion`, `backends[]` (each: `id`, `type`, `endpoint?`, `auth?`)
2. **`credentials.yaml`** — `CredentialsConfigSchema` with `schemaVersion`, `credentials[]` (each: `id`, `type`, `backend`, `backendKey`, `mint?` with `ttl` and `scopeTemplate`)
3. **`roles/*.yaml`** — `RoleConfigSchema` with `schemaVersion`, `id`, `description`, `extends?`, `credentials[]` (each: `ref`, `scope?`, `expose[]`), `proxy?`, `docker?`
4. **`trusted-plugins.yaml`** — `TrustedPluginsSchema` with plugin name → SHA256 pin mapping

### Package Setup

- Add to pnpm workspace
- Configure tsconfig extending the monorepo root
- Add `@generacy-ai/agency` as a dependency (for importing `PluginDiscovery` types in Phase 2)
- Export all types and schemas from package index

## User Stories

### US1: Platform Developer Defines Credential Contracts

**As a** platform developer building the credentials system,
**I want** well-defined TypeScript interfaces and Zod schemas for all credential-related config files,
**So that** I can implement Phase 2 (runtime resolution) and Phase 3 (agent launcher integration) against stable, validated contracts.

**Acceptance Criteria**:
- [ ] All interfaces compile cleanly with no `any` types leaking
- [ ] Zod schemas validate against example YAML fixtures from the architecture plan
- [ ] Package exports are consumable from other monorepo packages

### US2: Plugin Author Understands the Contract

**As a** credential plugin author (Phase 2+),
**I want** a clear `CredentialTypePlugin` interface with typed context objects,
**So that** I can implement plugins (e.g. `github-app`, `gcp-service-account`) that conform to the contract without ambiguity.

**Acceptance Criteria**:
- [ ] `CredentialTypePlugin` interface fully specifies `mint`, `resolve`, and `renderExposure` signatures
- [ ] `MintContext` and `ResolveContext` types include all fields a plugin needs
- [ ] `ExposureKind` enum covers all supported exposure mechanisms

### US3: Ops Engineer Validates Configuration

**As an** ops engineer writing `backends.yaml`, `credentials.yaml`, and `roles/*.yaml`,
**I want** Zod schemas that catch configuration errors at parse time,
**So that** misconfigurations are caught before runtime rather than causing silent failures.

**Acceptance Criteria**:
- [ ] Each config schema rejects invalid YAML with descriptive error messages
- [ ] Schemas match the structure documented in the credentials architecture plan
- [ ] `trusted-plugins.yaml` schema validates SHA256 pin format

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Create `packages/credhelper/` with monorepo integration (pnpm workspace, tsconfig) | P1 | Foundation for all other work |
| FR-002 | Define `CredentialTypePlugin` interface with all specified methods and properties | P1 | Core plugin contract |
| FR-003 | Define `ExposureKind` enum and `ExposureConfig`/`ExposureOutput` types | P1 | Used by plugin `renderExposure` |
| FR-004 | Define `MintContext`, `ResolveContext`, and `Secret` types | P1 | Plugin resolution context |
| FR-005 | Define Session API types (`BeginSessionRequest`, `BeginSessionResponse`, `EndSessionRequest`) | P1 | Session lifecycle |
| FR-006 | Define `LaunchRequest` credentials field type | P1 | AgentLauncher integration shape |
| FR-007 | Implement `BackendsConfigSchema` Zod schema | P1 | Validates backends.yaml |
| FR-008 | Implement `CredentialsConfigSchema` Zod schema | P1 | Validates credentials.yaml |
| FR-009 | Implement `RoleConfigSchema` Zod schema | P1 | Validates roles/*.yaml |
| FR-010 | Implement `TrustedPluginsSchema` Zod schema | P2 | Validates trusted-plugins.yaml |
| FR-011 | Export all types and schemas from package index | P1 | Public API surface |
| FR-012 | Unit tests for all Zod schemas against YAML fixtures | P1 | Validates schemas match architecture plan examples |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | TypeScript compilation | Zero errors | `tsc --noEmit` passes |
| SC-002 | Schema test coverage | All 4 config schemas tested | Unit tests with valid and invalid fixture YAML |
| SC-003 | Package integration | Importable from other packages | `import { ... } from '@generacy-ai/credhelper'` works |
| SC-004 | No runtime code | Types and schemas only | No implementation logic beyond Zod schema definitions |

## Assumptions

- Phase 0 (#457) has been completed and the foundational types it introduced are available
- The credentials architecture plan document is the source of truth for config file structures
- `@generacy-ai/agency` package exists and can be referenced as a dependency
- Zod is already available in the monorepo dependency tree

## Out of Scope

- Runtime credential resolution logic (Phase 2)
- Agent launcher integration (Phase 3)
- Actual credential plugin implementations (e.g. `github-app`, `gcp-service-account`)
- Backend connector implementations
- Session management runtime
- Proxy or Docker socket proxy runtime

---

*Generated by speckit*
