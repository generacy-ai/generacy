# Implementation Plan: Credhelper Plugin Loader with SHA256 Pin Verification

**Feature**: Plugin discovery, verification, and instantiation for credential type plugins
**Branch**: `460-credentials-architecture`
**Status**: Complete

## Summary

Implement a standalone async plugin loader (~150 LOC) in `packages/credhelper/` that discovers credhelper plugins from core and community paths, verifies SHA256 pins for non-core plugins against `trusted-plugins.yaml`, validates each plugin implements the `CredentialTypePlugin` interface with valid Zod schemas, and returns a `Map<string, CredentialTypePlugin>`.

This is Phase 2 of the credentials architecture, parallel with #461 (daemon) and #462 (config loader). It depends on Phase 1 (#458 credhelper skeleton) which is complete — all types, interfaces, and schemas are already defined.

## Technical Context

- **Language**: TypeScript (ES2022, ESM via NodeNext)
- **Runtime**: Node.js 20+
- **Build**: TypeScript compiler (`tsc`)
- **Test**: Vitest (globals, Node environment)
- **Package**: `@generacy-ai/credhelper` (pnpm workspace)
- **Dependencies**: `zod` (existing), `crypto` (Node built-in for SHA256)

### Key Decisions (from clarifications)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| PluginDiscovery reuse | Conditional — use Agency's if manifest field is configurable, else standalone ~50 LOC | Avoid coupling to Agency internals if they don't fit |
| Completeness validation | Deferred to daemon (#461) | Loader registers what it finds; cross-referencing credentials.yaml is #462's concern |
| Public API | Standalone async function `loadCredentialPlugins()` | No lifecycle, no state — runs once at boot |
| Plugin manifest | New `credhelperPlugin` field in package.json | Distinct from `agencyPlugin` to prevent Agency loader conflicts |
| DependencyResolver | Deferred | No inter-plugin dependencies in v1.5 |

## Project Structure

```
packages/credhelper/src/
├── index.ts                          # Add new exports
├── loader/
│   ├── index.ts                      # Re-export public API
│   ├── load-credential-plugins.ts    # Main loader function (~100 LOC)
│   ├── discover.ts                   # Plugin discovery (standalone or Agency adapter)
│   ├── verify.ts                     # SHA256 pin verification
│   └── validate.ts                   # Interface & schema validation
├── types/
│   ├── plugin.ts                     # CredentialTypePlugin (exists)
│   ├── context.ts                    # MintContext, ResolveContext (exists)
│   ├── exposure.ts                   # ExposureKind (exists)
│   └── loader.ts                     # NEW: LoaderConfig, DiscoveredPlugin types
├── schemas/
│   └── trusted-plugins.ts            # TrustedPluginsSchema (exists)
└── __tests__/
    ├── loader/
    │   ├── load-credential-plugins.test.ts  # Integration test
    │   ├── discover.test.ts                 # Discovery unit tests
    │   ├── verify.test.ts                   # SHA256 verification tests
    │   └── validate.test.ts                 # Validation unit tests
    └── fixtures/
        ├── plugins/                         # Mock plugin packages
        │   ├── generacy-credhelper-plugin-mock/
        │   │   ├── package.json
        │   │   └── index.js
        │   ├── generacy-credhelper-plugin-bad-schema/
        │   │   ├── package.json
        │   │   └── index.js
        │   └── generacy-credhelper-plugin-duplicate/
        │       ├── package.json
        │       └── index.js
        └── trusted-plugins.yaml             # (exists)
```

## Implementation Phases

### Phase A: Types & Discovery (~40 LOC)

1. **Define loader types** (`types/loader.ts`):
   - `LoaderConfig` — `{ corePaths: string[], communityPaths: string[], trustedPins: Map<string, string> }`
   - `DiscoveredPlugin` — `{ name: string, path: string, entryPoint: string, type: string, isCore: boolean }`
   - `PluginManifest` — `{ type: string, version: string, main: string }`

2. **Implement discovery** (`loader/discover.ts`):
   - Check if `@generacy-ai/agency`'s `PluginDiscovery` has a configurable manifest field
   - If yes: wrap it with credhelper pattern regex and `credhelperPlugin` field extraction
   - If no: implement standalone discovery (~50 LOC):
     - Scan `corePaths` and `communityPaths` for directories matching naming pattern
     - Read `package.json`, extract `credhelperPlugin` field
     - Return `DiscoveredPlugin[]` with `isCore` flag based on source path

### Phase B: Verification (~30 LOC)

3. **Implement SHA256 verification** (`loader/verify.ts`):
   - `verifyPluginPins(plugins: DiscoveredPlugin[], trustedPins: Map<string, string>): DiscoveredPlugin[]`
   - Skip verification for core plugins (`isCore === true`)
   - For community plugins: compute SHA256 of entry point file using `crypto.createHash('sha256')`
   - Compare against `trustedPins` map
   - Throw descriptive errors for: unpinned plugin, pin mismatch

### Phase C: Validation & Instantiation (~40 LOC)

4. **Implement validation** (`loader/validate.ts`):
   - `validatePlugin(mod: unknown): CredentialTypePlugin` — runtime type check
   - Verify `type` is a non-empty string
   - Verify `credentialSchema` is a Zod schema (check for `.parse` method)
   - Verify `scopeSchema` if present is a Zod schema
   - Verify `supportedExposures` is a non-empty array of valid `ExposureKind` values
   - Verify `renderExposure` is a function

5. **Implement main loader** (`loader/load-credential-plugins.ts`):
   - `loadCredentialPlugins(config: LoaderConfig): Promise<Map<string, CredentialTypePlugin>>`
   - Call `discoverPlugins()` for both core and community paths
   - Call `verifyPluginPins()` on discovered plugins
   - For each verified plugin: `require()` entry point, validate, register in map
   - Detect duplicate `type` values → throw
   - Return populated map

### Phase D: Tests

6. **Create mock plugin fixtures** — valid plugin, bad schema plugin, duplicate type plugin
7. **Unit tests**:
   - `discover.test.ts` — discovery from fixture paths, naming pattern filtering
   - `verify.test.ts` — happy path, missing pin, wrong pin, core plugin bypass
   - `validate.test.ts` — valid plugin, missing type, invalid schema, missing renderExposure
8. **Integration test**:
   - `load-credential-plugins.test.ts` — full flow with mock plugins on disk
   - Cover: happy path, mixed core+community, all error modes

### Phase E: Exports & Cleanup

9. **Update `index.ts`** — export `loadCredentialPlugins`, `LoaderConfig`, `DiscoveredPlugin`
10. **Verify build** — `pnpm build` succeeds, `pnpm test` passes

## Error Handling Strategy

All errors fail closed (throw, preventing boot). Error messages include:

| Condition | Message Pattern |
|-----------|----------------|
| Unpinned non-core plugin | `Plugin '{name}' from community path is not pinned in trusted-plugins.yaml. Compute SHA256 of {entryPoint} and add it.` |
| SHA256 mismatch | `Plugin '{name}' SHA256 mismatch: expected {expected}, got {actual}` |
| Invalid credentialSchema | `Plugin '{name}' has invalid credentialSchema: {zodError}` |
| Missing required field | `Plugin '{name}' does not implement CredentialTypePlugin: missing {field}` |
| Duplicate type | `Duplicate credential type '{type}' from plugins: {plugin1}, {plugin2}` |

## Dependencies

- **Upstream (complete)**: #458 credhelper skeleton — provides `CredentialTypePlugin`, `TrustedPluginsSchema`, all type definitions
- **Downstream**: #461 (daemon boot) consumes `loadCredentialPlugins()` output
- **External (conditional)**: `@generacy-ai/agency` — only if `PluginDiscovery` manifest field is configurable; otherwise zero external dependencies beyond `zod`

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Agency's `PluginDiscovery` hardcodes `agencyPlugin` manifest field | Fallback to standalone discovery (~50 LOC) — already planned |
| `require()` of ESM plugins in ESM context | Use `await import()` (dynamic import) instead of `require()` for ESM compatibility |
| Test isolation for filesystem-dependent discovery | Use temp directories with mock plugin fixtures; cleanup in afterEach |
