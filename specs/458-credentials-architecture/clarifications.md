# Clarifications — #458 Create @generacy-ai/credhelper Package

## Batch 1 — 2026-04-13

### Q1: Secret Type Shape
**Context**: The `Secret` type is used in `CredentialTypePlugin.mint()` return value, `resolve()` return value, and as a parameter to `renderExposure()`. Its shape determines the core plugin contract.
**Question**: What should the `Secret` type look like? Is it an opaque branded string, a plain string, or a structured object (e.g., `{ value: string; format?: string; metadata?: Record<string, unknown> }`)?
**Options**:
- A: Opaque branded string (`string & { __brand: 'Secret' }`) — prevents accidental logging
- B: Plain `string` — simplest, defer wrapping to Phase 2
- C: Structured object (`{ value: string; format?: string }`) — carries format metadata for exposure rendering

**Answer**: C (structured object) — with a Phase 2 runtime wrapper for redaction.**

Define the type in Phase 1 as:
```typescript
interface Secret {
  value: string;
  format?: 'token' | 'json' | 'key' | 'opaque';
}
```

Phase 2 (#461 daemon) will implement this as a class with `toString()` / `toJSON()` / `[Symbol.for('nodejs.util.inspect.custom')]` overrides that return `[REDACTED]` — so accidental logging is safe at runtime. Phase 1 only needs the type shape.

The `format` field helps exposure rendering in edge cases (e.g. a gcloud external-account JSON vs. a bearer token are rendered differently), and it's optional so most plugins can ignore it. A branded string (option A) only protects at compile time and doesn't carry metadata; plain string (option B) loses both protections.

---

### Q2: MintContext/ResolveContext Field Definitions
**Context**: `MintContext` and `ResolveContext` are passed to plugins during credential resolution. The architecture plan describes them conceptually ("credential ID, role scope, TTL, access to the backend") but doesn't specify exact TypeScript fields. The "access to the backend" part is particularly vague — it could be a function, a client interface, or just a backend ID.
**Question**: Should `MintContext`/`ResolveContext` include a backend accessor (e.g., `backend: BackendClient` with a `fetchSecret(key: string)` method), or just reference data (e.g., `backendId: string`, `backendKey: string`) that the credhelper runtime resolves externally?
**Options**:
- A: Include a `BackendClient` interface with `fetchSecret(key: string): Promise<string>` — plugins call it to get base secrets
- B: Reference data only (`backendId`, `backendKey`, `credentialConfig`) — runtime resolves secrets and passes them in
- C: Both — include `backendKey` for reference and an optional `fetchSecret` for plugins that need to call backends directly

**Answer**: A — include a `BackendClient` interface with `fetchSecret`.**

```typescript
interface BackendClient {
  fetchSecret(key: string): Promise<string>;
}

interface MintContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;
  scope: Record<string, unknown>;  // validated by plugin's scopeSchema
  ttl: number;                     // seconds, from mint.ttl in credentials.yaml
}

interface ResolveContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;
}
```

The credhelper runtime manages backend connections and provides the `BackendClient` to plugins. Plugins call `ctx.backend.fetchSecret(ctx.backendKey)` to get their base secret (e.g. GitHub App private key, GCP SA email), then use it to mint a derived credential. This keeps plugins decoupled from backend types — a `github-app` plugin works the same whether the backend is `generacy-cloud` or `env`.

Option B (reference data only) would require the runtime to pre-resolve everything, but plugins like `github-app` need to call external APIs with the base secret — that logic belongs in the plugin, not the runtime.

---

### Q3: ExposureConfig and ExposureOutput Type Structure
**Context**: `renderExposure(kind, secret, cfg)` is on the core plugin interface. Different exposure kinds need different configs (env needs `name`, localhost-proxy needs `port`, git-credential-helper needs nothing extra). The output also varies: env produces key-value pairs, git-credential-helper produces a script, gcloud produces a JSON file.
**Question**: Should `ExposureConfig` and `ExposureOutput` be discriminated unions keyed by `ExposureKind`, or generic record types that plugins interpret freely?
**Options**:
- A: Discriminated unions — `ExposureConfig = EnvExposureConfig | GitCredHelperConfig | ...` with type-safe per-kind shapes
- B: Generic base with kind-specific optional fields — `{ kind: ExposureKind; name?: string; port?: number; [key: string]: unknown }`
- C: Generic `Record<string, unknown>` — fully plugin-interpreted, maximum flexibility, validated by plugin's own schema

**Answer**: A — discriminated unions keyed by `ExposureKind`.**

Each exposure kind has distinct required fields and distinct output shapes. Discriminated unions make this type-safe:

```typescript
type ExposureConfig =
  | { kind: 'env'; name: string }
  | { kind: 'git-credential-helper' }
  | { kind: 'gcloud-external-account' }
  | { kind: 'localhost-proxy'; port: number }
  | { kind: 'docker-socket-proxy' };

type ExposureOutput =
  | { kind: 'env'; entries: Array<{ key: string; value: string }> }
  | { kind: 'git-credential-helper'; script: string }
  | { kind: 'gcloud-external-account'; json: object }
  | { kind: 'localhost-proxy'; proxyConfig: { port: number; upstream: string; headers: Record<string, string> } }
  | { kind: 'docker-socket-proxy'; socketPath: string };
```

This catches mismatches at compile time (a plugin can't return an env output for a git-credential-helper config), and role validation (decision #12 — `supportedExposures` checked against role requests) maps directly to the `kind` discriminant. Option B collapses too many optional fields together; option C defers all validation to runtime.

---

### Q4: @generacy-ai/agency Dependency
**Context**: The spec says to "Add `@generacy-ai/agency` as a dependency (for importing `PluginDiscovery` types in Phase 2)". However, no `@generacy-ai/agency` package exists in the monorepo. Adding a non-existent dependency would break the build.
**Question**: How should we handle the `@generacy-ai/agency` dependency for Phase 1?
**Options**:
- A: Skip it entirely — Phase 1 is types-only, add the dependency in Phase 2 when it exists
- B: Create a minimal `@generacy-ai/agency` stub package with just a `PluginDiscovery` interface placeholder
- C: Define `PluginDiscovery` types directly in `@generacy-ai/credhelper` for now, move them later

**Answer**: A — skip it entirely.**

Phase 1 is types-only. The `@generacy-ai/agency` package lives in a separate repo (`/workspaces/agency`), and importing it cross-repo would require it to be published to npm first. The `PluginDiscovery` import is only needed in Phase 2 (#460 plugin loader) when actual runtime code is written. Phase 1 should have zero cross-repo dependencies.

---

### Q5: Backend Auth Schema Structure
**Context**: The `BackendsConfigSchema` includes an `auth?` field. The architecture plan shows only one example (`mode: oidc-device` for generacy-cloud) and the `env` backend has no auth. For the Zod schema, we need to know whether `auth` is freeform or has specific allowed modes.
**Question**: Should the `auth` field in `BackendsConfigSchema` be a discriminated union of known auth modes, or a passthrough record validated per-backend-type?
**Options**:
- A: Discriminated union of known modes — `{ mode: 'oidc-device' } | { mode: 'static-token'; token: string } | ...`
- B: Passthrough `z.record(z.unknown())` — each backend type plugin validates its own auth shape
- C: Minimal base schema (`{ mode: z.string() }` + `z.passthrough()`) — validates structure but allows extension

**Answer**: C — minimal base schema with `z.passthrough()`.**

```typescript
const BackendAuthSchema = z.object({
  mode: z.string(),
}).passthrough();
```

This validates that `auth` has a `mode` string (so the runtime can route to the right handler at boot) but allows backend-type-specific fields to pass through. The `env` backend has no auth (field is optional on the backend entry). The `generacy-cloud` backend has `mode: oidc-device`. Future backends (Vault, GCP Secret Manager, Infisical) will have their own auth shapes.

Strict per-mode validation is the backend handler's responsibility, not the YAML schema's — consistent with the plan's plugin model where credential types are extensible, and backend types should be too. A closed discriminated union (option A) would require touching the schema every time a new backend type is added.
