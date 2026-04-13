# Implementation Plan: @generacy-ai/credhelper Package (Phase 1 — Contracts)

**Feature**: Create the `@generacy-ai/credhelper` package with all TypeScript interfaces and Zod schemas for the credentials architecture
**Branch**: `458-credentials-architecture`
**Status**: Complete

## Summary

Phase 1 delivers a types-only package at `packages/credhelper/` that defines every contract the credentials architecture needs — plugin interfaces, session API types, configuration schemas, and exposure types. No runtime implementation. The package follows existing monorepo conventions (`@generacy-ai/config` as the closest analog) and exports all types and schemas from a barrel `index.ts`.

Phase 0 (#457) cleared the CI path. This phase runs in parallel with #459 (spawn refactor) and the tetrad-development Dockerfile issue.

## Technical Context

- **Language**: TypeScript (ES2022, NodeNext modules, strict mode)
- **Framework**: None — pure types and Zod schemas
- **Build**: `tsc` (same as all other packages)
- **Test**: Vitest (Zod schema validation against YAML fixture files)
- **Dependencies**: `zod ^3.23.0`, `yaml ^2.4.0` (for test fixtures only — or devDep)
- **Monorepo**: pnpm workspaces, `packages/*` glob
- **No cross-repo deps**: `@generacy-ai/agency` dependency deferred to Phase 2 (clarification Q4)

## Project Structure

```
packages/credhelper/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    # barrel exports
│   ├── types/
│   │   ├── plugin.ts               # CredentialTypePlugin, BackendClient
│   │   ├── secret.ts               # Secret interface
│   │   ├── context.ts              # MintContext, ResolveContext
│   │   ├── exposure.ts             # ExposureKind, ExposureConfig, ExposureOutput
│   │   ├── session.ts              # BeginSessionRequest/Response, EndSessionRequest
│   │   └── launch.ts               # LaunchRequest credentials field type
│   ├── schemas/
│   │   ├── backends.ts             # BackendsConfigSchema
│   │   ├── credentials.ts          # CredentialsConfigSchema
│   │   ├── roles.ts                # RoleConfigSchema
│   │   ├── trusted-plugins.ts      # TrustedPluginsSchema
│   │   └── exposure.ts             # Zod schemas for ExposureConfig/ExposureOutput
│   └── __tests__/
│       ├── fixtures/
│       │   ├── backends.yaml
│       │   ├── credentials.yaml
│       │   ├── credentials-local.yaml
│       │   ├── roles/
│       │   │   ├── reviewer.yaml
│       │   │   ├── developer.yaml
│       │   │   └── devops.yaml
│       │   └── trusted-plugins.yaml
│       ├── backends-schema.test.ts
│       ├── credentials-schema.test.ts
│       ├── roles-schema.test.ts
│       └── trusted-plugins-schema.test.ts
└── dist/                           # compiled output (gitignored)
```

## Implementation Phases

### Phase A: Package Scaffold (Task 1)

Set up the package with monorepo integration:

1. Create `packages/credhelper/package.json` following `@generacy-ai/config` pattern
2. Create `packages/credhelper/tsconfig.json` (identical compiler options as other packages)
3. Create empty `src/index.ts` barrel file
4. Verify `pnpm install` resolves the new workspace package
5. Verify `tsc` compiles the empty package

### Phase B: Core Type Definitions (Tasks 2–5)

Define all TypeScript interfaces in `src/types/`:

**Task 2 — Secret type** (`src/types/secret.ts`):
```typescript
export interface Secret {
  value: string;
  format?: 'token' | 'json' | 'key' | 'opaque';
}
```

**Task 3 — Exposure types** (`src/types/exposure.ts`):
- `ExposureKind` enum: `env`, `git-credential-helper`, `gcloud-external-account`, `localhost-proxy`, `docker-socket-proxy`
- `ExposureConfig` discriminated union (5 variants keyed by `kind`)
- `ExposureOutput` discriminated union (5 variants keyed by `kind`)

**Task 4 — Context and plugin types** (`src/types/context.ts`, `src/types/plugin.ts`):
- `BackendClient` interface with `fetchSecret(key: string): Promise<string>`
- `MintContext` with `credentialId`, `backendKey`, `backend`, `scope`, `ttl`
- `ResolveContext` with `credentialId`, `backendKey`, `backend`
- `CredentialTypePlugin` interface with all methods from the architecture plan

**Task 5 — Session and launch types** (`src/types/session.ts`, `src/types/launch.ts`):
- `BeginSessionRequest` with `role` and `sessionId`
- `BeginSessionResponse` with `sessionDir` and `expiresAt`
- `EndSessionRequest` with `sessionId`
- `LaunchRequestCredentials` with `role`, `uid`, `gid`

### Phase C: Zod Schemas (Tasks 6–9)

Define all configuration schemas in `src/schemas/`:

**Task 6 — Backends schema** (`src/schemas/backends.ts`):
- `BackendAuthSchema` — `z.object({ mode: z.string() }).passthrough()` (clarification Q5)
- `BackendEntrySchema` — `id`, `type`, optional `endpoint`, optional `auth`
- `BackendsConfigSchema` — `schemaVersion: "1"`, `backends[]` array

**Task 7 — Credentials schema** (`src/schemas/credentials.ts`):
- `MintConfigSchema` — `ttl` (string, e.g. "1h"), `scopeTemplate` (record)
- `CredentialEntrySchema` — `id`, `type`, `backend`, `backendKey`, optional `mint`
- `CredentialsConfigSchema` — `schemaVersion: "1"`, `credentials[]` array

**Task 8 — Roles schema** (`src/schemas/roles.ts`):
- `RoleExposeSchema` — `as` (ExposureKind), kind-specific optional fields (`name`, `port`)
- `RoleCredentialRefSchema` — `ref`, optional `scope`, `expose[]`
- `ProxyRuleSchema` — `method`, `path`
- `ProxyConfigSchema` — named proxy blocks with `upstream`, `default`, `allow[]`
- `DockerRuleSchema` — `method`, `path`, optional `name`
- `DockerConfigSchema` — `default`, `allow[]`
- `RoleConfigSchema` — `schemaVersion`, `id`, `description`, optional `extends`, `credentials[]`, optional `proxy`, optional `docker`

**Task 9 — Trusted plugins schema** (`src/schemas/trusted-plugins.ts`):
- `TrustedPluginsSchema` — `schemaVersion: "1"`, `plugins` record mapping plugin name to `{ sha256: string }`

### Phase D: Barrel Exports (Task 10)

Wire all types and schemas through `src/index.ts`:
- Re-export all interfaces, types, and enums from `src/types/*.ts`
- Re-export all schemas and inferred types from `src/schemas/*.ts`

### Phase E: Test Fixtures and Schema Tests (Tasks 11–14)

**Task 11 — YAML fixtures**: Create fixture files matching the examples in the credentials architecture plan (backends.yaml, credentials.yaml, credentials-local.yaml, reviewer/developer/devops roles, trusted-plugins.yaml)

**Task 12 — Backends schema tests**: Parse fixture, validate against `BackendsConfigSchema`, test rejection of invalid entries

**Task 13 — Credentials schema tests**: Parse fixture, validate against `CredentialsConfigSchema`, test overlay parsing, test rejection of missing required fields

**Task 14 — Roles schema tests**: Parse each role fixture, validate against `RoleConfigSchema`, test `extends` field, test exposure validation, test proxy/docker blocks

### Phase F: Build Verification (Task 15)

1. Run `pnpm run build` in `packages/credhelper/` — must compile cleanly
2. Run `pnpm run test` — all schema tests pass
3. Verify all types and schemas are accessible from barrel export
4. Run full monorepo build to ensure no regressions

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Secret type shape | Structured object `{ value, format? }` | Carries format metadata for exposure rendering; Phase 2 adds redaction wrapper (clarification Q1) |
| Context includes BackendClient | `BackendClient` with `fetchSecret()` | Plugins need to call backends directly for derived credentials like GitHub App tokens (clarification Q2) |
| Exposure types | Discriminated unions keyed by `ExposureKind` | Type-safe per-kind shapes; catches mismatches at compile time (clarification Q3) |
| Agency dependency | Skipped in Phase 1 | Types-only phase has no cross-repo dependencies; added in Phase 2 (clarification Q4) |
| Backend auth schema | `z.object({ mode }).passthrough()` | Extensible for future backend types without touching core schema (clarification Q5) |
| YAML dep | devDependency only | Only needed for test fixture parsing; runtime code is types-only |

## Dependencies and Ordering

```
Phase A (scaffold) → Phase B (types) → Phase C (schemas) → Phase D (exports) → Phase E (tests) → Phase F (verify)
```

Within Phase B, tasks 2–5 are independent and can be parallelized.
Within Phase C, tasks 6–9 are independent and can be parallelized.
Within Phase E, tasks 12–14 depend on task 11 (fixtures) but are independent of each other.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Schema design doesn't match Phase 2 runtime needs | Schemas mirror the architecture plan examples exactly; clarifications locked down ambiguities |
| Zod schema too strict for future extensibility | Use `.passthrough()` on backend auth and scope blocks; credential `type` is `z.string()` not an enum |
| Exposure type additions in future versions | Discriminated unions are extensible — add a new variant to the union |

## Constitution Check

No `.specify/memory/constitution.md` found. No governance constraints to verify against.
