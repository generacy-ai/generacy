# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-19 16:29

### Q1: Schema Source
**Context**: The spec references 'generacy-ai/contracts - Knowledge store schemas' as a dependency but this repo doesn't exist yet. We need to know where type definitions come from.
**Question**: Should we define the types (Philosophy, Principle, Pattern, UserContext, etc.) inline in this package, or wait for the contracts package? If inline, should we later extract them?
**Options**:
- A: Define types inline now, extract to contracts later
- B: Create contracts package first as a blocking dependency
- C: Define types inline and keep them in this package (no extraction)

**Answer**: **A - Define types inline now, extract to contracts later**

The docs clearly envision `@generacy-ai/contracts` as the shared schemas package with structure for `common/`, `agency-generacy/`, etc. However, blocking on contracts would slow down parallel development. Defining inline with extraction planned keeps momentum while aligning with the intended architecture.

### Q2: Storage Scope
**Context**: The spec lists three storage providers (LocalFile, CloudFirestore, HybridStorage) but this may be more than needed for MVP.
**Question**: Which storage providers should be implemented in this feature? Should we start with local-only and add cloud/hybrid in a future iteration?
**Options**:
- A: LocalFileStorage only (MVP approach)
- B: LocalFileStorage + CloudFirestoreStorage (no hybrid sync)
- C: All three including HybridStorage with sync

**Answer**: **A - LocalFileStorage only (MVP approach)**

The adoption ladder shows a progressive path from local → cloud. The architecture emphasizes "local-first storage" with cloud as an advanced feature. Starting with LocalFileStorage allows validating the core API before adding sync complexity. Cloud/hybrid can be a separate issue.

### Q3: Version Storage
**Context**: Versioning requires storing historical data. The approach (git-like, database snapshots, or delta-based) affects storage size and implementation complexity.
**Question**: How should version history be stored? Full snapshots per version, or delta-based changes from a baseline?
**Options**:
- A: Full snapshots (simpler, larger storage)
- B: Delta-based (complex, efficient storage)
- C: Git-like (store as git commits in a data repo)

**Answer**: **A - Full snapshots (simpler, larger storage)**

The knowledge architecture describes a bi-temporal model with `validFrom`, `validTo`, `ingestedAt`, `supersededAt`, `supersededBy` fields - this aligns with full snapshot versioning. The knowledge stores (Philosophy, Principles, Patterns) are relatively small documents, not large datasets, so storage size isn't a major concern. Delta-based adds complexity without clear benefit for this use case.

### Q4: Conflict Resolution
**Context**: Import with 'merge and conflict resolution' is listed but the strategy isn't defined. This affects whether imports can be automated or require user interaction.
**Question**: For import conflicts, should the system auto-resolve (e.g., 'most recent wins') or require user review of each conflict?
**Options**:
- A: Auto-resolve with configurable strategy (most recent wins, etc.)
- B: Always require user review for conflicts
- C: Auto-resolve simple conflicts, user review for complex ones

**Answer**: **C - Auto-resolve simple conflicts, user review for complex ones**

The Humancy philosophy emphasizes human ownership and control of their wisdom. Philosophy and high-weight principles deserve human attention on conflicts. But simple conflicts (e.g., timestamp-only differences, context updates) can be auto-resolved. This balances user experience with the principle that humans control their knowledge.

### Q5: API Boundary
**Context**: The KnowledgeStoreManager interface is defined, but it's unclear if this is an internal service or should expose REST/GraphQL endpoints.
**Question**: Should this feature include HTTP API endpoints, or is it a library-only package consumed by other services?
**Options**:
- A: Library-only (TypeScript package, no HTTP)
- B: Include REST API endpoints
- C: Include GraphQL API

**Answer**: **A - Library-only (TypeScript package, no HTTP)**

The generacy repo separates `packages/` (libraries) from `services/` (orchestrator/worker). The knowledge store is a core capability consumed by the orchestration services, not a standalone API. HTTP endpoints would be exposed by the orchestrator service layer, not the knowledge store library.

