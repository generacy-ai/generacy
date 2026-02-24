# Feature Specification: Migrate Contracts Types to Latency

**Branch**: `246-1-9-migrate-contracts` | **Date**: 2026-02-24 | **Status**: Draft

## Summary

This feature involves retiring the `@generacy-ai/contracts` package by migrating its types to appropriate repositories within the Generacy ecosystem. Abstract interfaces will be moved to the latency repo, tool schemas to the agency repo, and single-consumer types will be inlined directly into their consuming codebases. This consolidation eliminates cross-repo type dependencies and simplifies the architecture by removing an unnecessary abstraction layer.

## User Stories

### US1: Type Migration to Latency

**As a** backend developer,
**I want** abstract interfaces from contracts to live in the latency repository,
**So that** type definitions are colocated with their primary implementations and the codebase has a clear single source of truth.

**Acceptance Criteria**:
- [ ] All abstract interfaces identified and catalogued from `@generacy-ai/contracts`
- [ ] Abstract interfaces migrated to latency with proper module structure
- [ ] All consuming repos updated to import from latency instead of contracts
- [ ] Type exports properly documented and versioned
- [ ] No breaking changes introduced during migration

### US2: Tool Schema Migration to Agency

**As a** agency service developer,
**I want** tool schemas to live in the agency repository,
**So that** schema definitions are maintained alongside the tools that use them.

**Acceptance Criteria**:
- [ ] All tool schemas identified and extracted from contracts
- [ ] Tool schemas migrated to agency with proper organization
- [ ] Schema validation logic updated to reference new locations
- [ ] All imports updated across consuming repositories
- [ ] Backward compatibility maintained during transition

### US3: Single-Consumer Type Inlining

**As a** developer,
**I want** types used by only one service to be inlined into that service,
**So that** we eliminate unnecessary indirection and improve code locality.

**Acceptance Criteria**:
- [ ] Single-consumer types identified through usage audit
- [ ] Types inlined directly into consuming repositories
- [ ] No external dependencies remain for these types
- [ ] Type definitions remain consistent with original contracts
- [ ] Documentation updated to reflect new locations

### US4: Contracts Package Removal

**As a** platform engineer,
**I want** all references to `@generacy-ai/contracts` removed from the codebase,
**So that** we can safely archive the contracts repository.

**Acceptance Criteria**:
- [ ] All imports from `@generacy-ai/contracts` removed across all repos
- [ ] Package removed from package.json dependencies in all projects
- [ ] CI/CD pipelines updated to reflect new type locations
- [ ] Contracts repository archived on GitHub
- [ ] Migration documentation published for future reference

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Audit all exported types in `@generacy-ai/contracts` and categorize by usage pattern | P0 | Foundation for all migration work |
| FR-002 | Migrate abstract interfaces to latency repository with consistent module structure | P0 | Core shared types |
| FR-003 | Migrate tool schemas to agency repository | P0 | Schema definitions belong with tooling |
| FR-004 | Inline single-consumer types directly into consuming repositories | P1 | Eliminates unnecessary abstraction |
| FR-005 | Update all import statements across latency, agency, and generacy repos | P0 | Critical for functionality |
| FR-006 | Remove `@generacy-ai/contracts` from package.json in all repositories | P0 | Dependency cleanup |
| FR-007 | Update TypeScript path mappings and module resolution configurations | P1 | Proper IDE and build support |
| FR-008 | Verify type compatibility and exports in all affected repositories | P0 | Prevent runtime errors |
| FR-009 | Update documentation to reflect new type locations and import patterns | P1 | Developer experience |
| FR-010 | Archive contracts repository on GitHub with clear deprecation notice | P0 | Official decommissioning |
| FR-011 | Create migration guide documenting type relocations | P2 | Historical reference |
| FR-012 | Verify all CI/CD pipelines pass with new type structure | P0 | Continuous integration integrity |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Contracts package imports | 0 across all repos | `grep -r "@generacy-ai/contracts"` in latency, agency, generacy |
| SC-002 | TypeScript compilation | 100% success rate | CI/CD pipeline status |
| SC-003 | Test suite pass rate | 100% (no regressions) | Automated test results |
| SC-004 | Build time | No increase >5% | CI/CD build duration metrics |
| SC-005 | Contracts repo status | Archived | GitHub repository status |
| SC-006 | Type migration completeness | 100% of types migrated | Audit checklist completion |
| SC-007 | Documentation updates | All affected docs updated | Documentation review checklist |
| SC-008 | Package.json cleanup | Contracts removed from all repos | Dependency audit |

## Technical Approach

### Phase 1: Audit & Planning
1. Generate complete inventory of types in `@generacy-ai/contracts`
2. Map each type to its consumers across all repositories
3. Categorize types: abstract interfaces, tool schemas, single-consumer, shared utilities
4. Create migration matrix documenting destination repo for each type

### Phase 2: Latency Migration
1. Create appropriate module structure in latency for abstract interfaces
2. Migrate types with full JSDoc and type annotations
3. Set up proper exports in latency package.json
4. Update consuming repos to import from latency

### Phase 3: Agency Migration
1. Create schema directory structure in agency
2. Migrate tool schemas with validation logic
3. Update agency exports
4. Update schema references across consuming repos

### Phase 4: Inlining
1. Identify and inline single-consumer types
2. Update imports to reference local type definitions
3. Remove external type dependencies

### Phase 5: Cleanup & Verification
1. Remove all `@generacy-ai/contracts` imports
2. Remove package from all dependency lists
3. Run full test suites across all repos
4. Verify CI/CD pipelines
5. Archive contracts repository

## Assumptions

- All repositories (latency, agency, generacy, contracts) are accessible and have proper development environments set up
- TypeScript is the primary language for type definitions across all repos
- Existing test coverage is sufficient to catch type-related regressions
- No new features or types are being added to contracts during the migration period
- All repositories use compatible TypeScript versions for type exports/imports
- Git branching strategy allows for coordinated cross-repo changes
- CI/CD pipelines can be updated to reflect new package structure
- Development team has capacity to review and test changes across multiple repositories

## Out of Scope

- Refactoring or improving existing type definitions (migration maintains current structure)
- Adding new types or interfaces during migration
- Changing TypeScript compiler configurations beyond path mappings
- Migrating non-type code or utilities from contracts
- Performance optimization of type checking or compilation
- Changing API contracts or interfaces (migration only changes import locations)
- Converting JavaScript files to TypeScript
- Updating third-party packages or dependencies unrelated to contracts
- Modifying build tools or bundler configurations (except for path resolution)
- Creating new abstraction layers or type libraries

## Dependencies

### Upstream Dependencies
None — this issue can start immediately and runs parallel to CI/CD setup work.

### Downstream Dependencies
This migration should be completed before:
- Major version releases that would need to document breaking changes
- New feature work that might depend on contracts types

### Cross-Repository Coordination
This feature requires coordinated changes across:
- **contracts**: Source repository for types (read-only during migration)
- **latency**: Destination for abstract interfaces
- **agency**: Destination for tool schemas
- **generacy**: Consumer requiring import updates

## Risks & Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Type incompatibilities during migration | High | Low | Comprehensive audit and testing phase before removal |
| Breaking changes in consuming code | High | Medium | Maintain exact type definitions, thorough test coverage |
| Merge conflicts across repos | Medium | Medium | Coordinate migration timing, use feature branches |
| Incomplete type discovery | High | Low | Automated tooling for type usage analysis |
| CI/CD pipeline failures | High | Low | Update pipelines incrementally, test thoroughly |

## Rollback Plan

If critical issues are discovered after migration:
1. Each repository has independent feature branch that can be reverted
2. Contracts repository can be temporarily un-archived if needed
3. Package can be restored to package.json temporarily
4. Types can be re-exported from original locations as compatibility layer
5. Coordinated rollback across repos using git revert on merge commits

---

*Generated by speckit*
