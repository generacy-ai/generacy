# Clarifications: Credhelper Plugin Loader with SHA256 Pin Verification

## Batch 1 — 2026-04-13

### Q1: PluginDiscovery Pattern Configuration
**Context**: Agency's `PluginDiscovery` class currently scans for `@generacy-ai/agency-plugin-*` and `agency-plugin-*` naming patterns. The spec requires scanning for `@generacy/credhelper-plugin-*` (core) and `generacy-credhelper-plugin-*` (community). The implementation approach depends on whether PluginDiscovery supports configurable patterns.
**Question**: Can Agency's `PluginDiscovery` be instantiated with custom naming patterns, or does it only support its built-in agency patterns? If not configurable, should we extend/fork it or implement discovery from scratch within credhelper?
**Options**:
- A: PluginDiscovery already supports configurable patterns via constructor options — just pass the credhelper patterns
- B: Extend PluginDiscovery with a subclass that overrides the pattern matching
- C: Implement a simpler standalone discovery (~50 LOC) within credhelper that scans the two known paths directly

**Answer**: A — PluginDiscovery already supports configurable patterns.**

Confirmed by reading the source at `agency/packages/agency/src/plugins/discovery.ts:30`:
```typescript
constructor(pattern: RegExp = DEFAULT_PLUGIN_PATTERN) {
  this.pattern = pattern;
}
```

Pass a credhelper-specific pattern:
```typescript
const discovery = new PluginDiscovery(
  /^(@generacy\/credhelper-plugin-|generacy-credhelper-plugin-)[\w-]+$/
);
```

No subclass, no fork needed. The discovery class is standalone (no Agency runtime coupling) — confirmed in earlier investigation.

---

### Q2: "Declared Credential Type" Source
**Context**: The error handling table states "Missing plugin for a declared credential type → boot failure." This implies the loader needs to check that all *required* credential types have a matching plugin, but the spec doesn't identify where credential types are declared. The `CredentialsConfigSchema` from #458 has a `type` field on each credential entry, which could serve as the source of required types.
**Question**: Where are the credential types declared that the loader should validate completeness against? Is the loader expected to read `credentials.yaml` and ensure every referenced `type` has a loaded plugin, or does it only register what it discovers without validating completeness?
**Options**:
- A: Loader reads `credentials.yaml` and validates that every `type` referenced has a matching plugin — fail if any type is missing
- B: Loader only registers discovered plugins; completeness validation is done by a separate component at session time
- C: A list of required types is passed to the loader as a configuration parameter

**Answer**: B — Loader only registers discovered plugins; completeness validated elsewhere.**

The loader's job is: discover → verify pins → instantiate → return `Map<type, plugin>`. It doesn't read `credentials.yaml` — that's #462's responsibility.

Completeness validation ("does every credential type have a plugin?") happens at **daemon boot** (#461), after both the config loader (#462) and the plugin loader (#460) have run. The daemon has both the config and the plugin map and can cross-reference them. This keeps the loader focused on one concern.

---

### Q3: Loader Public API Shape
**Context**: The spec describes the loader's behavior (~150 LOC) but doesn't specify its exported API surface. The implementation needs to know whether to export a class, a function, or follow Agency's pattern, and what configuration the caller passes in (paths, config file locations, etc.).
**Question**: What should the loader's public API look like?
**Options**:
- A: A class `CredhelperPluginLoader` with async `load(config): Promise<Map<string, CredentialTypePlugin>>` — config includes paths and trusted-plugins location
- B: A standalone async function `loadCredentialPlugins(config): Promise<Map<string, CredentialTypePlugin>>`
- C: Follow Agency's `PluginLoader` class pattern with lifecycle methods (initialize/shutdown)

**Answer**: B — standalone async function.**

```typescript
export async function loadCredentialPlugins(config: {
  corePaths: string[];        // e.g. ['/usr/local/lib/generacy-credhelper/']
  communityPaths: string[];   // e.g. ['.agency/secrets/plugins/node_modules/']
  trustedPins: Map<string, string>;  // from trusted-plugins.yaml
}): Promise<Map<string, CredentialTypePlugin>>
```

The loader has no lifecycle — no hot reload (per the plan), no shutdown, no state between calls. It runs once at boot and returns a map. A class would add ceremony with no benefit. Agency's `PluginLoader` class (option C) has lifecycle methods because it manages active plugin state; ours doesn't.

---

### Q4: Plugin Manifest Format
**Context**: Agency's `PluginDiscovery` identifies plugins via their `package.json` fields (manifest schema). The spec says to reuse `PluginDiscovery` but doesn't specify whether credhelper plugins use the same manifest schema or a credhelper-specific one. This affects both the plugin author contract and how discovery works.
**Question**: Do credhelper plugins follow Agency's existing plugin manifest schema (with fields like `agencyPlugin` in package.json), or do they define a separate manifest format (e.g., `credhelperPlugin` field)? If using Agency's format, what fields are required?
**Options**:
- A: Reuse Agency's manifest schema as-is — credhelper plugins declare themselves as Agency plugins with a credhelper-specific `type` field
- B: Define a new `credhelperPlugin` manifest field in package.json with credhelper-specific metadata
- C: No manifest needed — discovery is purely by naming convention and path scanning

**Answer**: B — new `credhelperPlugin` field in package.json.**

Credhelper plugins are NOT Agency plugins — they implement `CredentialTypePlugin`, not `AgencyPlugin`. Using Agency's `agencyPlugin` manifest field would be misleading and could cause Agency's own loader to try to load them as Agency plugins.

Define a `credhelperPlugin` field:
```json
{
  "name": "generacy-credhelper-plugin-vault",
  "credhelperPlugin": {
    "type": "vault",
    "version": "1.0.0",
    "main": "./dist/index.js"
  }
}
```

Agency's `PluginDiscovery` scans by naming pattern (regex on package name) and then reads the manifest. Since we're passing a custom regex pattern (Q1), it will match credhelper packages. We just need to ensure the discovery reads the `credhelperPlugin` field instead of `agencyPlugin` — may need a small adapter or a manifest key override if `PluginDiscovery` hardcodes the field name.

Actually, check whether `PluginDiscovery` hardcodes the manifest field. If it does, option C (standalone discovery ~50 LOC) may end up being simpler than adapting Agency's discovery to read a different field. The discovery logic itself is trivial: scan paths, match naming pattern, read package.json, extract manifest. The value of reusing Agency's code was to avoid reinventing this, but if the manifest field is hardcoded, the adaptation cost may exceed the rewrite cost. Make a judgment call during implementation — if `PluginDiscovery` is flexible enough, use it; if not, write standalone discovery and skip the Agency import entirely.

---

### Q5: DependencyResolver Usage in Phase 2
**Context**: The spec summary states "Reuse Agency's `PluginDiscovery` class, manifest schema, and `DependencyResolver`." However, the out-of-scope section explicitly says "Plugin dependency resolution between credential type plugins (handled by Agency's DependencyResolver if needed later)." This is contradictory — the summary includes DependencyResolver but out-of-scope defers it.
**Question**: Should Phase 2 integrate `DependencyResolver` from Agency for ordering plugin loading, or is dependency resolution deferred entirely to a future phase?
**Options**:
- A: Include DependencyResolver — plugins may declare dependencies on other credential types, and load order matters
- B: Defer entirely — load plugins in arbitrary order; dependency resolution is a future concern
- C: Import DependencyResolver but only use it if plugins declare dependencies (graceful no-op if none do)

**Answer**: B — defer entirely, load in arbitrary order.**

Credential type plugins are independent of each other. A `github-app` plugin doesn't depend on a `gcp-service-account` plugin. There's no inter-plugin dependency use case in v1.5. Loading in discovery order is fine. If a future plugin type genuinely needs ordering, add `DependencyResolver` then — but don't add the complexity now.
