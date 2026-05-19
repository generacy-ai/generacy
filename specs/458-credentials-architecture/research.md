# Research: @generacy-ai/credhelper Package

## Technology Decisions

### 1. Zod for Schema Validation

**Decision**: Use Zod `^3.23.0` for all configuration schemas.

**Rationale**:
- Already used throughout the monorepo (`@generacy-ai/config`, `@generacy-ai/orchestrator`, `@generacy-ai/knowledge-store`)
- Provides `z.infer<typeof Schema>` for automatic type derivation — no manual type/schema sync
- Discriminated unions (`z.discriminatedUnion`) map directly to the ExposureConfig/ExposureOutput pattern
- `.passthrough()` supports extensible schemas (backend auth, plugin-specific fields)
- `.refine()` available for cross-field validation if needed in Phase 2

**Alternatives considered**:
- **io-ts**: Stronger FP foundation but unfamiliar to the team; Zod is the established pattern
- **JSON Schema + ajv**: Would require separate type definitions; Zod co-locates types and validation
- **TypeBox**: Good TypeScript inference but no existing usage in the monorepo

### 2. Discriminated Unions for Exposure Types

**Decision**: `ExposureConfig` and `ExposureOutput` are TypeScript discriminated unions keyed by `kind`, with corresponding Zod `z.discriminatedUnion()` schemas.

**Rationale** (from clarification Q3):
- Each exposure kind has distinct required fields (env needs `name`, localhost-proxy needs `port`, git-credential-helper needs nothing)
- Each exposure kind has distinct output shapes (env produces key-value entries, git-credential-helper produces a script, gcloud produces JSON)
- Discriminated unions catch mismatches at compile time — a plugin can't return an env output for a git-credential-helper config
- The `kind` discriminant maps directly to `supportedExposures` validation (decision #12)

**Alternatives considered**:
- **Generic record with optional fields**: Collapses too many optional fields; loses per-kind type safety
- **Fully generic `Record<string, unknown>`**: Maximum flexibility but defers all validation to runtime

### 3. Structured Secret Type

**Decision**: `Secret` is `{ value: string; format?: 'token' | 'json' | 'key' | 'opaque' }`.

**Rationale** (from clarification Q1):
- The `format` field helps exposure rendering (gcloud external-account JSON vs. bearer token are rendered differently)
- Phase 2 adds a runtime class with `toString()`/`toJSON()`/`[Symbol.for('nodejs.util.inspect.custom')]` overrides returning `[REDACTED]`
- Phase 1 only needs the type shape — no runtime behavior

**Alternatives considered**:
- **Branded string** (`string & { __brand: 'Secret' }`): Compile-time only protection, doesn't carry metadata
- **Plain string**: Loses both compile-time safety and format metadata

### 4. BackendClient in Context Objects

**Decision**: `MintContext` and `ResolveContext` include a `BackendClient` interface with `fetchSecret(key: string): Promise<string>`.

**Rationale** (from clarification Q2):
- Plugins like `github-app` need to call external APIs with the base secret (e.g., GitHub App private key) — that logic belongs in the plugin
- `BackendClient` decouples plugins from backend types — a `github-app` plugin works the same whether the backend is `generacy-cloud` or `env`
- The credhelper runtime manages backend connections and provides the client

**Alternatives considered**:
- **Reference data only** (`backendId`, `backendKey`): Would require runtime to pre-resolve everything; breaks plugins that need direct API calls
- **Both**: Unnecessary complexity; `BackendClient` alone covers all use cases

### 5. Passthrough Backend Auth Schema

**Decision**: `BackendAuthSchema = z.object({ mode: z.string() }).passthrough()`.

**Rationale** (from clarification Q5):
- Only one known auth mode so far (`oidc-device` for generacy-cloud); `env` backend has no auth
- Future backends (Vault, GCP SM, Infisical) will have their own auth shapes
- `.passthrough()` validates structure (`mode` string exists) while allowing extension
- Strict per-mode validation is the backend handler's responsibility at runtime

**Alternatives considered**:
- **Closed discriminated union**: Would require schema changes for every new backend type
- **Fully open `z.record(z.unknown())`**: No structural validation at all

### 6. YAML Dependency Placement

**Decision**: `yaml ^2.4.0` as a devDependency (for test fixture parsing only).

**Rationale**:
- Phase 1 package is types-only — no runtime YAML parsing
- Tests need to parse YAML fixtures to validate schemas
- Runtime YAML parsing will be in the credhelper daemon (Phase 2), which can add its own dependency

### 7. No Agency Dependency in Phase 1

**Decision**: Skip `@generacy-ai/agency` dependency entirely.

**Rationale** (from clarification Q4):
- Phase 1 is types-only with zero cross-repo dependencies
- `@generacy-ai/agency` lives in a separate repo (`/workspaces/agency`) and would need to be published to npm first
- `PluginDiscovery` import is only needed in Phase 2 (#460 plugin loader) for runtime code

## Implementation Patterns

### Barrel Export Pattern

Following `@generacy-ai/config`, all types and schemas are re-exported from `src/index.ts`:
```typescript
export { type Secret } from './types/secret.js';
export { BackendsConfigSchema, type BackendsConfig } from './schemas/backends.js';
```

### Schema + Inferred Type Pattern

Following existing Zod patterns in the monorepo:
```typescript
export const BackendsConfigSchema = z.object({ ... });
export type BackendsConfig = z.infer<typeof BackendsConfigSchema>;
```

### Test Pattern

Following `@generacy-ai/config` test patterns:
```typescript
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { BackendsConfigSchema } from '../schemas/backends.js';

const fixture = parse(readFileSync('...fixtures/backends.yaml', 'utf-8'));
expect(BackendsConfigSchema.parse(fixture)).toEqual(expect.objectContaining({ ... }));
```

## Key Sources

- [Credentials Architecture Plan](/workspaces/tetrad-development/docs/credentials-architecture-plan.md) — canonical design document for the entire credentials system
- [Clarifications](/workspaces/generacy/specs/458-credentials-architecture/clarifications.md) — resolved design ambiguities for Phase 1
- [Phase 0 Spec](/workspaces/generacy/specs/457-credentials-architecture/spec.md) — predecessor that cleared CI
- [`@generacy-ai/config` package](/workspaces/generacy/packages/config/) — reference for monorepo package patterns, Zod schema conventions, and test structure
