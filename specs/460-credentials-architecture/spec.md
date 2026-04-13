# Feature Specification: Credhelper Plugin Loader with SHA256 Pin Verification

**Branch**: `460-credentials-architecture` | **Date**: 2026-04-13 | **Status**: Draft

## Summary

Implement the credhelper plugin loader inside `packages/credhelper/`. This loader discovers, verifies via SHA256 pin checking, and instantiates credential type plugins. It reuses Agency's `PluginDiscovery` infrastructure while providing a thin, credhelper-specific loader that operates independently of Agency's `CoreAPI`-dependent `PluginLoader`.

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md). See decisions #2, #12, and #17.

**Depends on:** Phase 1 (#458 credhelper skeleton)
**Parallel with:** #461, #462

## Architecture (decision #17)

- **Reuse** Agency's `PluginDiscovery` class, manifest schema, and `DependencyResolver` as library imports from `@generacy-ai/agency`
- **Reimplement** a thin credhelper-specific loader (~150 LOC) that does NOT use Agency's `PluginLoader` (which hard-requires a `CoreAPI` factory that doesn't apply here)

## User Stories

### US1: Platform operator loads credential plugins at boot

**As a** platform operator,
**I want** the credhelper to automatically discover and load credential type plugins at boot,
**So that** new credential types (e.g., OAuth, API key, SSH) can be supported without modifying core code.

**Acceptance Criteria**:
- [ ] Core plugins are discovered from `/usr/local/lib/generacy-credhelper/`
- [ ] Community plugins are discovered from `.agency/secrets/plugins/node_modules/`
- [ ] Each discovered plugin is validated and registered by its `type` key
- [ ] Boot fails with a clear message if any required credential type has no matching plugin

### US2: Security-conscious operator trusts only pinned community plugins

**As a** platform operator concerned with supply chain security,
**I want** community plugins to be verified against SHA256 pins before loading,
**So that** tampered or unauthorized plugins cannot be loaded into the credential system.

**Acceptance Criteria**:
- [ ] Non-core plugins are rejected if not listed in `trusted-plugins.yaml`
- [ ] Non-core plugins are rejected if their SHA256 hash doesn't match the pin
- [ ] Core plugins (by path) are loaded without pin verification
- [ ] Rejection errors clearly name the plugin and expected pin location

### US3: Plugin author provides a valid credential type plugin

**As a** plugin author,
**I want** the loader to validate my plugin's interface and schemas at load time,
**So that** I get immediate feedback if my plugin doesn't conform to the `CredentialTypePlugin` contract.

**Acceptance Criteria**:
- [ ] Plugin must implement `CredentialTypePlugin` interface (from #458)
- [ ] Plugin's `credentialSchema` and `scopeSchema` must be valid Zod schemas
- [ ] Invalid plugins cause boot failure with a descriptive error

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Import `PluginDiscovery` from `@generacy-ai/agency/plugins` and configure for credhelper naming patterns | P1 | `@generacy/credhelper-plugin-*` (core), `generacy-credhelper-plugin-*` (community) |
| FR-002 | Scan core plugin path `/usr/local/lib/generacy-credhelper/` | P1 | Baked into container image |
| FR-003 | Scan community plugin path `.agency/secrets/plugins/node_modules/` | P1 | User-installed plugins |
| FR-004 | Read and parse `.agency/secrets/trusted-plugins.yaml` for SHA256 pins | P1 | Schema defined in #458 |
| FR-005 | Compute SHA256 of each non-core plugin entry point and verify against pin | P1 | Fail closed on mismatch or missing pin |
| FR-006 | Skip pin verification for core plugins (trusted by path) | P1 | |
| FR-007 | `require()` each verified plugin entry point | P1 | |
| FR-008 | Validate plugin implements `CredentialTypePlugin` interface | P1 | From #458 |
| FR-009 | Validate `credentialSchema` and `scopeSchema` are valid Zod schemas | P1 | |
| FR-010 | Register plugins in `Map<string, CredentialTypePlugin>` keyed by `type` | P1 | |
| FR-011 | Reject duplicate `type` keys across plugins | P1 | Boot failure |
| FR-012 | No hot reload — plugins load once at boot | P2 | Simplifies security model |

## Error Handling (Fail Closed)

| Condition | Behavior |
|-----------|----------|
| Missing plugin for a declared credential type | Boot failure |
| Unpinned non-core plugin | Boot failure |
| SHA256 mismatch | Boot failure with clear message showing expected vs actual hash |
| Plugin `credentialSchema` validation failure | Boot failure |
| Duplicate `type` across plugins | Boot failure |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Plugin discovery coverage | Both core and community paths scanned | Unit test with mock filesystem |
| SC-002 | SHA256 verification correctness | All non-core plugins verified; core plugins bypassed | Unit tests: happy path, missing pin, wrong pin |
| SC-003 | Fail-closed behavior | All 5 error conditions produce boot failure | Unit tests for each error condition |
| SC-004 | Interface validation | Invalid plugins rejected at boot | Unit test with mock plugin missing interface methods |
| SC-005 | Integration with Agency | `PluginDiscovery` imported and used successfully | Integration test with real `PluginDiscovery` |

## Assumptions

- Phase 1 (#458) has been completed, providing the `CredentialTypePlugin` interface and `trusted-plugins.yaml` schema
- `@generacy-ai/agency` exports `PluginDiscovery` from `@generacy-ai/agency/plugins`
- Core plugins are pre-installed in the container image at `/usr/local/lib/generacy-credhelper/`
- The `trusted-plugins.yaml` file is managed out-of-band by the platform operator

## Out of Scope

- Hot reload of plugins (explicitly deferred — load once at boot)
- Plugin dependency resolution between credential type plugins (handled by Agency's `DependencyResolver` if needed later)
- UI for managing `trusted-plugins.yaml` pins
- Automatic SHA256 pin generation tooling (separate concern)
- Plugin marketplace or distribution mechanism

---

*Generated by speckit*
