# Research: Credhelper Plugin Loader

## Technology Decisions

### 1. Standalone Discovery vs. Agency PluginDiscovery

**Decision**: Implement standalone discovery (~50 LOC), with Agency's `PluginDiscovery` as a stretch goal.

**Rationale**:
- Agency's `PluginDiscovery` accepts a configurable regex pattern (confirmed in Q1 clarification) but likely hardcodes the `agencyPlugin` manifest field name
- Credhelper plugins use a `credhelperPlugin` manifest field (Q4 decision) — different from Agency's format
- The discovery logic is straightforward: scan directories, match naming pattern, read `package.json`
- Avoiding the Agency dependency keeps the credhelper package self-contained and reduces coupling
- If Agency later exposes a fully configurable discovery, migration is trivial

**Alternative considered**: Wrap `PluginDiscovery` with an adapter that remaps manifest fields. Rejected because the adaptation complexity exceeds the rewrite cost for ~50 LOC.

### 2. SHA256 Computation

**Decision**: Use Node.js built-in `crypto.createHash('sha256')` on the entry point file contents.

**Rationale**:
- Zero additional dependencies
- The spec explicitly says "compute SHA256 of the package entry point file"
- Entry point path comes from the `credhelperPlugin.main` field in package.json
- Reading and hashing a single file is fast and deterministic

**Alternative considered**: Hash the entire package directory (tar + hash). Rejected — the spec scopes verification to the entry point file, and whole-package hashing adds complexity (file ordering, exclusions) without clear benefit in v1.

### 3. Dynamic Import vs. require()

**Decision**: Use `await import()` (dynamic import) for loading plugin entry points.

**Rationale**:
- The credhelper package is ESM (`"type": "module"` in package.json, NodeNext module resolution)
- `require()` is not available in ESM modules without `createRequire()`
- `await import()` works for both ESM and CJS modules in Node.js 20+
- Aligns with the existing codebase patterns

### 4. Plugin Interface Validation (Runtime)

**Decision**: Manual runtime type checking (duck typing) rather than Zod schema for the plugin interface.

**Rationale**:
- `CredentialTypePlugin` is a TypeScript interface — it doesn't exist at runtime
- We need to verify: `type` (string), `credentialSchema` (has `.parse` method), `supportedExposures` (array of ExposureKind), `renderExposure` (function)
- A Zod schema for "is a Zod schema" would be circular
- Simple property/type checks are sufficient and produce clear error messages
- This is a boot-time check, not a hot path — clarity over elegance

### 5. Error Aggregation Strategy

**Decision**: Fail on first error, not aggregate all errors.

**Rationale**:
- The spec says "fail closed" — any single verification failure should prevent boot
- First-error-wins produces the clearest debugging experience (one problem to fix at a time)
- Aggregating errors adds complexity and can mask root causes (e.g., a missing pin error alongside a "file not found" error from the same missing plugin)

## Implementation Patterns

### Plugin Discovery Pattern

```
For each search path:
  List directories matching /^(@generacy\/credhelper-plugin-|generacy-credhelper-plugin-)[\w-]+$/
  For each matching directory:
    Read package.json
    Extract credhelperPlugin field → { type, version, main }
    Resolve entry point: path.resolve(pluginDir, manifest.main)
    Tag as core (from corePath) or community (from communityPath)
```

### Pin Verification Pattern

```
For each discovered plugin:
  If core → skip (trusted by path)
  If community:
    Read entry point file contents
    SHA256 hash → hex string
    Lookup plugin name in trustedPins map
    If not found → throw (unpinned)
    If mismatch → throw (tampered)
    If match → pass
```

### Instantiation Pattern

```
For each verified plugin:
  await import(entryPoint)
  Extract default export (or named export)
  Validate implements CredentialTypePlugin
  Check for duplicate type in registry
  Register in Map<string, CredentialTypePlugin>
```

## Key References

- Phase 1 skeleton (#458): `packages/credhelper/src/types/plugin.ts` — `CredentialTypePlugin` interface
- Trusted plugins schema (#458): `packages/credhelper/src/schemas/trusted-plugins.ts` — `TrustedPluginsSchema`
- Test fixtures: `packages/credhelper/src/__tests__/fixtures/trusted-plugins.yaml`
- Credentials architecture plan: `tetrad-development/docs/credentials-architecture-plan.md` (decisions #2, #12, #17)
- Agency PluginDiscovery: `agency/packages/agency/src/plugins/discovery.ts` (external package, not in this repo)
