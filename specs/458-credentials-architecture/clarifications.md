# Clarifications — #458 Create @generacy-ai/credhelper Package

## Batch 1 — 2026-04-13

### Q1: Secret Type Shape
**Context**: The `Secret` type is used in `CredentialTypePlugin.mint()` return value, `resolve()` return value, and as a parameter to `renderExposure()`. Its shape determines the core plugin contract.
**Question**: What should the `Secret` type look like? Is it an opaque branded string, a plain string, or a structured object (e.g., `{ value: string; format?: string; metadata?: Record<string, unknown> }`)?
**Options**:
- A: Opaque branded string (`string & { __brand: 'Secret' }`) — prevents accidental logging
- B: Plain `string` — simplest, defer wrapping to Phase 2
- C: Structured object (`{ value: string; format?: string }`) — carries format metadata for exposure rendering

**Answer**: *Pending*

### Q2: MintContext/ResolveContext Field Definitions
**Context**: `MintContext` and `ResolveContext` are passed to plugins during credential resolution. The architecture plan describes them conceptually ("credential ID, role scope, TTL, access to the backend") but doesn't specify exact TypeScript fields. The "access to the backend" part is particularly vague — it could be a function, a client interface, or just a backend ID.
**Question**: Should `MintContext`/`ResolveContext` include a backend accessor (e.g., `backend: BackendClient` with a `fetchSecret(key: string)` method), or just reference data (e.g., `backendId: string`, `backendKey: string`) that the credhelper runtime resolves externally?
**Options**:
- A: Include a `BackendClient` interface with `fetchSecret(key: string): Promise<string>` — plugins call it to get base secrets
- B: Reference data only (`backendId`, `backendKey`, `credentialConfig`) — runtime resolves secrets and passes them in
- C: Both — include `backendKey` for reference and an optional `fetchSecret` for plugins that need to call backends directly

**Answer**: *Pending*

### Q3: ExposureConfig and ExposureOutput Type Structure
**Context**: `renderExposure(kind, secret, cfg)` is on the core plugin interface. Different exposure kinds need different configs (env needs `name`, localhost-proxy needs `port`, git-credential-helper needs nothing extra). The output also varies: env produces key-value pairs, git-credential-helper produces a script, gcloud produces a JSON file.
**Question**: Should `ExposureConfig` and `ExposureOutput` be discriminated unions keyed by `ExposureKind`, or generic record types that plugins interpret freely?
**Options**:
- A: Discriminated unions — `ExposureConfig = EnvExposureConfig | GitCredHelperConfig | ...` with type-safe per-kind shapes
- B: Generic base with kind-specific optional fields — `{ kind: ExposureKind; name?: string; port?: number; [key: string]: unknown }`
- C: Generic `Record<string, unknown>` — fully plugin-interpreted, maximum flexibility, validated by plugin's own schema

**Answer**: *Pending*

### Q4: @generacy-ai/agency Dependency
**Context**: The spec says to "Add `@generacy-ai/agency` as a dependency (for importing `PluginDiscovery` types in Phase 2)". However, no `@generacy-ai/agency` package exists in the monorepo. Adding a non-existent dependency would break the build.
**Question**: How should we handle the `@generacy-ai/agency` dependency for Phase 1?
**Options**:
- A: Skip it entirely — Phase 1 is types-only, add the dependency in Phase 2 when it exists
- B: Create a minimal `@generacy-ai/agency` stub package with just a `PluginDiscovery` interface placeholder
- C: Define `PluginDiscovery` types directly in `@generacy-ai/credhelper` for now, move them later

**Answer**: *Pending*

### Q5: Backend Auth Schema Structure
**Context**: The `BackendsConfigSchema` includes an `auth?` field. The architecture plan shows only one example (`mode: oidc-device` for generacy-cloud) and the `env` backend has no auth. For the Zod schema, we need to know whether `auth` is freeform or has specific allowed modes.
**Question**: Should the `auth` field in `BackendsConfigSchema` be a discriminated union of known auth modes, or a passthrough record validated per-backend-type?
**Options**:
- A: Discriminated union of known modes — `{ mode: 'oidc-device' } | { mode: 'static-token'; token: string } | ...`
- B: Passthrough `z.record(z.unknown())` — each backend type plugin validates its own auth shape
- C: Minimal base schema (`{ mode: z.string() }` + `z.passthrough()`) — validates structure but allows extension

**Answer**: *Pending*
