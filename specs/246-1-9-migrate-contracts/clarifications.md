# Clarification Questions

## Status: Resolved

**Key finding:** `@generacy-ai/contracts` has only ONE consumer: `humancy/extension` (via `file:../../contracts`), and even there many imports are commented out. The active repos (generacy, agency, latency, generacy-cloud) have zero dependency. Since humancy is "Deferred for release" per the buildout plan, this is effectively unused for repos in scope. The package itself is substantial (~1,152 exports, 209 TS files) so there IS meaningful content worth migrating.

## Questions

### Q1: Contracts Package Dependency Status
**Context**: The spec assumes contracts is actively used across latency, agency, and generacy repos, but initial checks show no `@generacy-ai/contracts` dependencies in the main package.json files. This affects the scope and approach of the migration.

**Question**: What is the current dependency status of `@generacy-ai/contracts` across the repositories?

**Options**:
- A) **Currently Used**: The package is actively imported and used in multiple repos (proceed with full migration)
- B) **Legacy/Unused**: The package exists but is not currently consumed by any repos (skip migration, go straight to archival)
- C) **Partially Used**: Only some repos use it, or it's used in nested packages (audit required to identify actual consumers)
- D) **Future Dependency**: The package was created in preparation for future use (clarify roadmap before deciding)

**Answer**: C) Partially Used — but barely. Only `humancy/extension` has a `file:../../contracts` dependency, and many of its imports are commented out. The active repos (generacy, agency, latency, generacy-cloud) have no dependency whatsoever. Since humancy is deferred for release, this is effectively B (Legacy/Unused) for the repos in scope. The package itself is substantial though (~1,152 exports, 209 TS files) so there IS meaningful content worth migrating to its proper homes.

---

### Q2: Type Categorization Criteria
**Context**: The spec mentions categorizing types as "abstract interfaces," "tool schemas," "single-consumer," and "shared utilities" but doesn't define clear criteria for each category. This is critical for Phase 1 audit work.

**Question**: What are the specific criteria for categorizing types from the contracts package?

**Options**:
- A) **By Directory Structure**: Use the existing folder structure in contracts (e.g., `/schemas/tool-naming` → agency, `/common` → latency)
- B) **By Import Analysis**: Analyze actual usage patterns across repos to determine category
- C) **By Type Nature**: Abstract interfaces → latency, Zod schemas → agency, everything else case-by-case
- D) **Predefined Mapping**: A specific mapping document or list exists that defines where each type should go

**Answer**: A) By Directory Structure — The contracts repo is already organized by cross-component domain (`agency-generacy/`, `agency-humancy/`, `generacy-humancy/`, `common/`, `orchestration/`, `schemas/`, `telemetry/`). This existing structure maps directly to destinations. Combine with C as a secondary heuristic: Zod schemas for tool invocation go to agency, abstract orchestration types to latency, cross-component communication types to latency as the shared foundation.

---

### Q3: Versioning and Breaking Changes Strategy
**Context**: The spec emphasizes "no breaking changes" but cross-repo type migration inherently creates a window where imports change. The coordination strategy for publishing and consuming new versions needs clarification.

**Question**: What is the versioning and deployment strategy for the migration?

**Options**:
- A) **Coordinated Release**: All repos updated simultaneously in a single coordinated merge/deploy
- B) **Backward Compatible Bridge**: New packages export types first, contracts re-exports them temporarily for compatibility, then contracts removed in phase 2
- C) **Feature Branches**: Long-lived feature branches across all repos, merged together when complete
- D) **Monorepo Migration First**: Move all repos to a monorepo structure, then migrate types internally

**Answer**: A) Coordinated Release — Since no active repo depends on contracts today, there is no breaking change window to manage. This is a "move types to their future home" migration, not a "swap live dependencies" migration. Humancy is deferred and can be updated when it comes back into scope. No backward-compatible bridge needed.

---

### Q4: Module Structure in Destination Repos
**Context**: FR-002 mentions "consistent module structure" but doesn't specify what structure should be created in latency and agency for the migrated types.

**Question**: What module/directory structure should be used in the destination repositories?

**Options**:
- A) **Mirror Contracts Structure**: Recreate the same directory hierarchy from contracts (e.g., latency/src/contracts/common/)
- B) **Flat Structure**: All types in a single `/types` or `/schemas` directory in each repo
- C) **Domain-Organized**: Organize by domain/feature (e.g., agency/src/tools/schemas/, latency/src/orchestration/types/)
- D) **Separate Package**: Create new internal packages (e.g., @generacy-ai/latency-types, @generacy-ai/agency-schemas)

**Answer**: C) Domain-Organized — Latency already uses a facet/plugin architecture. Migrated types should follow the existing conventions of each destination repo, organized by domain (e.g., `latency/src/orchestration/`, `agency/src/tools/schemas/`). Don't mirror the contracts structure since it was organized for a standalone package.

---

### Q5: Zod Schema and Runtime Dependencies
**Context**: The contracts package depends on `zod` and `zod-to-json-schema` for runtime validation. The spec doesn't address whether validation logic migrates with schemas or how dependencies are handled.

**Question**: How should Zod schemas and validation logic be handled during migration?

**Options**:
- A) **Migrate Everything**: Move both type definitions and Zod schemas/validation to destination repos
- B) **Types Only**: Extract TypeScript types only, leave Zod validation logic behind or refactor
- C) **Shared Validation Package**: Create a new shared validation package that both repos depend on
- D) **Per-Repo Validation**: Each consuming repo implements its own validation for migrated types

**Answer**: A) Migrate Everything — The Zod schemas provide runtime validation, not just types. They are integral to the contracts they define. Each destination repo should get the full type + schema + validation for its domain.

---

### Q6: Generated Schema Files
**Context**: The contracts package has `/src/generated/` directory with JSON schema files and generation scripts (e.g., `generate-tool-result-schema.ts`). The spec doesn't address whether these should migrate.

**Question**: What should happen to the schema generation scripts and generated JSON schema files?

**Options**:
- A) **Migrate Scripts**: Move generation scripts to the repo that will own the schemas (likely agency)
- B) **Remove Generation**: Switch to manual schema maintenance in destination repos
- C) **Keep Centralized**: Keep generation in contracts temporarily, output to multiple repos
- D) **Build-time Generation**: Set up build scripts in each repo to generate their own schemas

**Answer**: A) Migrate Scripts — Move the generation scripts (e.g., `generate-tool-result-schema.ts`) to the repo that owns the source schemas (likely agency for tool schemas). Generated JSON schema files should be regenerated from the new location rather than copied.

---

### Q7: Test Migration Strategy
**Context**: The contracts repo contains extensive test files (e.g., `__tests__` directories throughout). The spec doesn't clarify whether tests should migrate with their types or be rewritten.

**Question**: How should existing tests in the contracts package be handled?

**Options**:
- A) **Migrate Tests**: Move tests alongside their types to destination repos
- B) **Rewrite Tests**: Write new tests in destination repos following their conventions
- C) **Archive Tests**: Keep tests in contracts as historical reference, don't migrate
- D) **Integration Tests Only**: Keep unit tests archived, create new integration tests in consuming repos

**Answer**: A) Migrate Tests — Tests validate the correctness of the types and schemas. They should travel with their types. Adapt them to the test conventions of the destination repo (all repos already use vitest).

---

### Q8: Cross-Component Communication Types
**Context**: Many types in contracts are explicitly for cross-component communication (e.g., `agency-humancy/`, `generacy-humancy/`, `agency-generacy/`). These don't fit cleanly into "owned by one repo."

**Question**: Where should types that facilitate communication between multiple components live?

**Options**:
- A) **Latency as Common**: All cross-component types go to latency as the shared foundation
- B) **Producer Owns**: The component that produces/sends the message owns the schema
- C) **Consumer Owns**: The component that receives/validates the message owns the schema
- D) **Keep Contracts for These**: Only migrate single-repo types, keep cross-repo types in a renamed contracts-lite package

**Answer**: A) Latency as Common — Latency is explicitly defined as "shared facet interfaces, plugin abstractions" in the buildout plan. Cross-component types (`agency-generacy/`, `agency-humancy/`, `generacy-humancy/`) are the textbook definition of shared contracts. They belong in the shared foundation layer. The latency README already notes that abstract plugin interfaces were migrated there from contracts.

---

### Q9: Documentation and Migration Guide Audience
**Context**: FR-011 mentions creating a migration guide, but the target audience affects content and detail level.

**Question**: Who is the primary audience for the migration guide documentation?

**Options**:
- A) **Internal Team Only**: Current developers who worked on these systems
- B) **Future Developers**: New team members who may need to understand historical decisions
- C) **External Developers**: Third-party developers using Generacy platform APIs
- D) **All Stakeholders**: Comprehensive documentation for all current and future audiences

**Answer**: A) Internal Team Only — Humancy is deferred, no external developers interact with contracts, and this is plumbing work. A brief internal migration note is sufficient. External-facing documentation (Epic 6) will reference the final package locations.

---

### Q10: CI/CD Pipeline Updates
**Context**: FR-012 and SC-002 mention updating CI/CD pipelines but don't specify what changes are needed beyond "type locations."

**Question**: What specific CI/CD pipeline changes are required for this migration?

**Options**:
- A) **Dependency Updates Only**: Update package.json references in build configs
- B) **Build Order Changes**: Modify build orchestration to ensure types are built before consumers
- C) **New Type Checking**: Add type compatibility checks between repos to prevent drift
- D) **Workspace Configuration**: Update monorepo tools (if applicable) or cross-repo references

**Answer**: A) Dependency Updates Only — Since no active repo currently depends on contracts, the CI/CD impact is minimal. The main change is adding the new types/schemas to the build of latency and agency, which is just updating their source tree. No cross-repo build order changes needed.

---

### Q11: Timeline and Phasing Coordination
**Context**: The technical approach defines 5 phases but doesn't specify timing, whether phases can overlap, or how long the transition period should be.

**Question**: What is the timeline expectation and phasing strategy?

**Options**:
- A) **Fast Migration (1-2 weeks)**: Complete all phases rapidly in a sprint-style migration
- B) **Gradual Migration (1-2 months)**: Phase-by-phase over several sprints with validation between phases
- C) **Opportunistic Migration (3+ months)**: Migrate types as they're needed or touched by other work
- D) **Parallel Phases**: Multiple phases run concurrently with different types to accelerate completion

**Answer**: A) Fast Migration (1-2 weeks) — The low active-dependency count makes this straightforward. The main work is auditing 1,152 exports, categorizing them, moving them to latency/agency, and running tests. No complex coordination needed since nothing actively consumes contracts.

---

### Q12: Rollback Testing and Validation
**Context**: The rollback plan mentions several strategies but doesn't specify testing requirements to validate that rollback would work if needed.

**Question**: What level of rollback testing is required before marking the migration complete?

**Options**:
- A) **Full Rollback Test**: Actually perform a rollback in a test environment to validate the process
- B) **Documentation Only**: Document rollback steps but don't test execution
- C) **Partial Test**: Test individual repo rollback but not coordinated cross-repo rollback
- D) **No Formal Test**: Rely on git revert capability and proceed without explicit rollback testing

**Answer**: D) No Formal Test — Given that no active repo depends on contracts, the rollback risk is extremely low. Standard git revert capability is sufficient. The only consumer (humancy) is deferred and wouldn't be affected.

---

### Q13: Single-Consumer Type Identification
**Context**: FR-004 focuses on inlining "single-consumer types" but actual usage may not be clear without runtime analysis or comprehensive code search.

**Question**: How should single-consumer types be identified with confidence?

**Options**:
- A) **Static Analysis**: Use TypeScript compiler API or grep to find all imports
- B) **Runtime Telemetry**: Check production telemetry/logs to see what's actually used
- C) **Developer Knowledge**: Ask team members which types are single-consumer based on experience
- D) **Conservative Approach**: Only inline types with obvious single use; treat ambiguous cases as shared

**Answer**: A) Static Analysis — Use grep/ripgrep across all repos for import paths. Given the `file:` dependency model, static analysis will catch everything. The TypeScript compiler API is overkill when grep gives full coverage.

---

### Q14: Package Publishing and npm Registry
**Context**: The contracts package is `@generacy-ai/contracts` suggesting npm publication. The spec doesn't address unpublishing or deprecation in npm registry.

**Question**: What should happen to the published npm package for `@generacy-ai/contracts`?

**Options**:
- A) **Unpublish**: Remove from npm registry entirely (may break external consumers)
- B) **Deprecate Only**: Mark as deprecated in npm with notice pointing to new packages
- C) **Archive Version**: Publish final version with deprecation notice, leave published indefinitely
- D) **Not Published**: Package is private/internal only, no npm concerns

**Answer**: D) Not Published — The only reference is a `file:../../contracts` path in humancy/extension. There's no evidence of npm publication. No npm deprecation/unpublishing needed.

---

### Q15: Type Definition Maintenance During Migration
**Context**: The assumption states "No new features or types are being added to contracts during migration" but doesn't address how to handle necessary type updates during the migration period.

**Question**: What happens if a type in contracts needs to be updated during the migration process?

**Options**:
- A) **Freeze Contracts**: Hard freeze on all contracts changes, queue updates until after migration
- B) **Dual Maintenance**: Update in both contracts and destination repos during transition
- C) **Emergency Only**: Only critical bug fixes allowed, documented as exceptions
- D) **Cancel Migration**: Pause or cancel migration if active type changes are needed

**Answer**: A) Freeze Contracts — Since there are no active consumers and humancy is deferred, a freeze has zero cost. Any needed type evolution happens in the destination repos after migration.

---

### Q16: Abstract Interface Definition
**Context**: US1 and FR-002 refer to "abstract interfaces" being moved to latency, but the term isn't defined. This could mean TypeScript interfaces, abstract classes, or conceptual contracts.

**Question**: What specifically qualifies as an "abstract interface" in this context?

**Options**:
- A) **TypeScript Interfaces**: Only `interface` declarations (not types, classes, or enums)
- B) **Base Types**: Any foundational type that others extend/implement (interfaces + base types)
- C) **Non-Implementation**: Any type definition without runtime logic (interfaces, types, schemas)
- D) **Core Domain Models**: The essential domain entities and contracts regardless of TypeScript construct

**Answer**: D) Core Domain Models — The contracts repo contains interfaces, type aliases, Zod schemas, ID generators, and utility functions. All of these define the "contract" between components. The migration should be inclusive — anything that defines a cross-component agreement, regardless of TypeScript construct (interface, type, schema, or helper function).

---
