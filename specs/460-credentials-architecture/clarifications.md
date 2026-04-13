# Clarifications: Credhelper Plugin Loader with SHA256 Pin Verification

## Batch 1 — 2026-04-13

### Q1: PluginDiscovery Pattern Configuration
**Context**: Agency's `PluginDiscovery` class currently scans for `@generacy-ai/agency-plugin-*` and `agency-plugin-*` naming patterns. The spec requires scanning for `@generacy/credhelper-plugin-*` (core) and `generacy-credhelper-plugin-*` (community). The implementation approach depends on whether PluginDiscovery supports configurable patterns.
**Question**: Can Agency's `PluginDiscovery` be instantiated with custom naming patterns, or does it only support its built-in agency patterns? If not configurable, should we extend/fork it or implement discovery from scratch within credhelper?
**Options**:
- A: PluginDiscovery already supports configurable patterns via constructor options — just pass the credhelper patterns
- B: Extend PluginDiscovery with a subclass that overrides the pattern matching
- C: Implement a simpler standalone discovery (~50 LOC) within credhelper that scans the two known paths directly

**Answer**: *Pending*

### Q2: "Declared Credential Type" Source
**Context**: The error handling table states "Missing plugin for a declared credential type → boot failure." This implies the loader needs to check that all *required* credential types have a matching plugin, but the spec doesn't identify where credential types are declared. The `CredentialsConfigSchema` from #458 has a `type` field on each credential entry, which could serve as the source of required types.
**Question**: Where are the credential types declared that the loader should validate completeness against? Is the loader expected to read `credentials.yaml` and ensure every referenced `type` has a loaded plugin, or does it only register what it discovers without validating completeness?
**Options**:
- A: Loader reads `credentials.yaml` and validates that every `type` referenced has a matching plugin — fail if any type is missing
- B: Loader only registers discovered plugins; completeness validation is done by a separate component at session time
- C: A list of required types is passed to the loader as a configuration parameter

**Answer**: *Pending*

### Q3: Loader Public API Shape
**Context**: The spec describes the loader's behavior (~150 LOC) but doesn't specify its exported API surface. The implementation needs to know whether to export a class, a function, or follow Agency's pattern, and what configuration the caller passes in (paths, config file locations, etc.).
**Question**: What should the loader's public API look like?
**Options**:
- A: A class `CredhelperPluginLoader` with async `load(config): Promise<Map<string, CredentialTypePlugin>>` — config includes paths and trusted-plugins location
- B: A standalone async function `loadCredentialPlugins(config): Promise<Map<string, CredentialTypePlugin>>`
- C: Follow Agency's `PluginLoader` class pattern with lifecycle methods (initialize/shutdown)

**Answer**: *Pending*

### Q4: Plugin Manifest Format
**Context**: Agency's `PluginDiscovery` identifies plugins via their `package.json` fields (manifest schema). The spec says to reuse `PluginDiscovery` but doesn't specify whether credhelper plugins use the same manifest schema or a credhelper-specific one. This affects both the plugin author contract and how discovery works.
**Question**: Do credhelper plugins follow Agency's existing plugin manifest schema (with fields like `agencyPlugin` in package.json), or do they define a separate manifest format (e.g., `credhelperPlugin` field)? If using Agency's format, what fields are required?
**Options**:
- A: Reuse Agency's manifest schema as-is — credhelper plugins declare themselves as Agency plugins with a credhelper-specific `type` field
- B: Define a new `credhelperPlugin` manifest field in package.json with credhelper-specific metadata
- C: No manifest needed — discovery is purely by naming convention and path scanning

**Answer**: *Pending*

### Q5: DependencyResolver Usage in Phase 2
**Context**: The spec summary states "Reuse Agency's `PluginDiscovery` class, manifest schema, and `DependencyResolver`." However, the out-of-scope section explicitly says "Plugin dependency resolution between credential type plugins (handled by Agency's DependencyResolver if needed later)." This is contradictory — the summary includes DependencyResolver but out-of-scope defers it.
**Question**: Should Phase 2 integrate `DependencyResolver` from Agency for ordering plugin loading, or is dependency resolution deferred entirely to a future phase?
**Options**:
- A: Include DependencyResolver — plugins may declare dependencies on other credential types, and load order matters
- B: Defer entirely — load plugins in arbitrary order; dependency resolution is a future concern
- C: Import DependencyResolver but only use it if plugins declare dependencies (graceful no-op if none do)

**Answer**: *Pending*
