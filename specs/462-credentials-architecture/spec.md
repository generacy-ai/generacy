# Feature Specification: Config File Loading & Validation for Credentials Architecture

**Branch**: `462-credentials-architecture` | **Date**: 2026-04-13 | **Status**: Draft

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md). See decisions #10 and #11.

**Depends on:** Phase 1 (#458 credhelper skeleton — provides Zod schemas)

**Phase:** 2 — parallel with #460 and #461

## Summary

Implement the configuration file loading layer inside `packages/credhelper/`. This reads, validates, and merges the `.agency/secrets/` and `.agency/roles/` configuration files that define what credentials are available and how they're grouped into roles. The loader enforces fail-closed semantics — any validation error prevents the credhelper from starting.

### Directory structure to load

```
.agency/
├── secrets/
│   ├── backends.yaml           # committed — where secrets come from
│   ├── credentials.yaml        # committed — declarations only, no values
│   ├── credentials.local.yaml  # gitignored — personal overlay
│   └── trusted-plugins.yaml    # committed — SHA-pinned allowlist
└── roles/
    ├── reviewer.yaml
    ├── developer.yaml
    ├── devops.yaml
    └── ...
```

### File loading

1. **backends.yaml** — load and validate against `BackendsConfigSchema` (from #458). Required file.
2. **credentials.yaml** — load and validate against `CredentialsConfigSchema`. Required file.
3. **credentials.local.yaml** — load and validate against same schema. Optional file (gitignored overlay).
4. **trusted-plugins.yaml** — load and validate against `TrustedPluginsSchema`. Optional file (only needed if non-core plugins are used).
5. **roles/*.yaml** — glob `.agency/roles/*.yaml`, load each, validate against `RoleConfigSchema`.

### Credential overlay merge (decision #11)

- Merge `credentials.local.yaml` over `credentials.yaml` **by `id`**
- An overlay entry **fully replaces** the committed entry with the same id (no field-level merge)
- Overlay can add new ids
- Log at startup which credentials came from the overlay (never invisible)

### Role validation

1. For each role, validate that every `ref` in its `credentials[]` matches a declared credential id
2. Validate that the credential's plugin type supports the requested `expose` kinds (check plugin's `supportedExposures`)
3. If a role uses `extends`, resolve the inheritance chain:
   - Load the parent role
   - Merge credentials: child entries override parent entries by `ref` (same merge-by-key semantics)
   - Detect circular `extends` and fail with clear error
4. **Fail closed** on any validation error — the credhelper should not start with an invalid config

### Role validation with proxy/docker blocks

- `proxy` blocks in roles: validate upstream URL, method+path allowlist syntax
- `docker` blocks in roles: validate method+path allowlist syntax, `default: deny` is explicit

### Error reporting

- All errors should name the specific file, line (if available from YAML parser), and field that failed
- Overlay-related errors should clearly state whether the error is in the committed or local file

## User Stories

### US1: Developer configures project credentials

**As a** developer setting up a project,
**I want** to declare credentials in `.agency/secrets/credentials.yaml` and have them validated at startup,
**So that** misconfigured or missing credential declarations are caught before any agent runs.

**Acceptance Criteria**:
- [ ] `credentials.yaml` loads and validates against `CredentialsConfigSchema`
- [ ] `backends.yaml` loads and validates against `BackendsConfigSchema`
- [ ] Missing required files produce a clear error naming the expected path
- [ ] Invalid YAML or schema violations produce errors with file name, line, and field

### US2: Developer overrides credentials locally

**As a** developer with personal credentials (e.g., personal API keys),
**I want** to override committed credential entries via `credentials.local.yaml`,
**So that** I can use my own credentials without modifying shared config.

**Acceptance Criteria**:
- [ ] Overlay entries replace committed entries by matching `id` (full replacement, not field-level merge)
- [ ] Overlay can introduce new credential ids not present in the committed file
- [ ] Startup logging reports which credential ids came from the overlay
- [ ] Overlay file is optional — its absence is not an error

### US3: Team lead defines agent roles with scoped credentials

**As a** team lead defining agent roles,
**I want** roles to declare which credentials they need and how they're exposed,
**So that** agents only get access to the credentials their role requires.

**Acceptance Criteria**:
- [ ] Each role file in `.agency/roles/*.yaml` validates against `RoleConfigSchema`
- [ ] Every `ref` in a role's `credentials[]` must match a declared credential id
- [ ] Exposure kinds are validated against the credential's plugin `supportedExposures`
- [ ] Role `extends` inheritance resolves single-level and multi-level chains
- [ ] Circular `extends` chains are detected and rejected with a clear error

### US4: Security-conscious team restricts agent network/container access

**As a** security-conscious team,
**I want** proxy and docker blocks in roles to be validated for correct allowlist syntax,
**So that** misconfigurations don't silently grant broader access than intended.

**Acceptance Criteria**:
- [ ] `proxy` blocks validate upstream URL format and method+path allowlist syntax
- [ ] `docker` blocks validate method+path allowlist syntax
- [ ] `default: deny` is required to be explicit in docker blocks

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Load and validate `backends.yaml` against `BackendsConfigSchema` | P1 | Required file — fail if missing |
| FR-002 | Load and validate `credentials.yaml` against `CredentialsConfigSchema` | P1 | Required file — fail if missing |
| FR-003 | Load and validate optional `credentials.local.yaml` against same schema | P1 | Gitignored overlay |
| FR-004 | Load and validate optional `trusted-plugins.yaml` against `TrustedPluginsSchema` | P2 | Only needed for non-core plugins |
| FR-005 | Glob and load all `.agency/roles/*.yaml`, validate each against `RoleConfigSchema` | P1 | |
| FR-006 | Merge overlay over committed credentials by `id` with full-replacement semantics | P1 | Decision #11 |
| FR-007 | Log which credential ids came from the overlay at startup | P1 | Never invisible |
| FR-008 | Validate role credential `ref` entries against declared credential ids | P1 | |
| FR-009 | Validate exposure kinds against plugin `supportedExposures` | P1 | |
| FR-010 | Resolve role `extends` inheritance chains (merge by `ref`) | P1 | |
| FR-011 | Detect and reject circular `extends` chains | P1 | Fail closed with clear error |
| FR-012 | Validate `proxy` blocks (upstream URL, method+path allowlist syntax) | P1 | |
| FR-013 | Validate `docker` blocks (method+path allowlist, explicit `default: deny`) | P1 | |
| FR-014 | All errors include file name, line (if available), and field | P1 | Overlay errors state committed vs local |
| FR-015 | Fail closed on any validation error — credhelper must not start with invalid config | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Schema validation coverage | All 5 file types validated | Unit tests for valid and invalid configs per file type |
| SC-002 | Overlay merge correctness | 100% of overlay scenarios handled | Tests for: replacement by id, new id addition, missing overlay |
| SC-003 | Role inheritance correctness | Single and multi-level extends resolved | Tests for 1-level, 2-level chains and circular detection |
| SC-004 | Ref/exposure validation | All invalid refs and unsupported exposures caught | Negative test cases for missing refs and bad exposure kinds |
| SC-005 | Error quality | Every error includes file, field, and source (committed/local) | Manual review of error messages in test output |
| SC-006 | Fail-closed guarantee | Zero configs with validation errors proceed to runtime | Integration test attempting to start with invalid config |

## Assumptions

- Phase 1 (#458) Zod schemas (`BackendsConfigSchema`, `CredentialsConfigSchema`, `TrustedPluginsSchema`, `RoleConfigSchema`) are available in `packages/credhelper/`
- YAML parsing library (e.g., `yaml` npm package) is available or can be added as a dependency
- `.agency/` directory path is provided to the loader (not hardcoded)
- Plugin `supportedExposures` metadata is accessible from the schema or plugin registry established in Phase 1

## Out of Scope

- Actual secret value retrieval from backends (Phase 3 / #460)
- Runtime credential injection into agent processes
- UI for managing credentials or roles
- Encryption of local overlay files
- Remote/centralized credential storage

---

*Generated by speckit*
