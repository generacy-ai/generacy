# Feature Specification: Knowledge store management

**Branch**: `024-knowledge-store-management` | **Date**: 2026-01-19 | **Status**: Draft

## Summary

Implement knowledge store management - the service that persists and manages individual knowledge (philosophy, principles, patterns, context).

## Parent Epic

#2 - Generacy Core Package

## Dependencies

- None for MVP (types defined inline, to be extracted to `@generacy-ai/contracts` later)

## Purpose

Knowledge stores are the foundation of protégé training. This service:
- Stores individual knowledge persistently
- Provides CRUD operations for knowledge
- Handles versioning and history
- Supports import/export for portability
- Syncs between local and cloud storage

## The Four Stores

| Store | Persistence | Update Frequency | Portability |
|-------|-------------|------------------|-------------|
| **Philosophy** | Permanent | Rarely | Full |
| **Principles** | Permanent | Weekly/Monthly | Abstracted |
| **Patterns** | Semi-permanent | Daily | Depends |
| **Context** | Temporary | Hourly/Daily | Not portable |

## Implementation

### KnowledgeStoreManager
```typescript
interface KnowledgeStoreManager {
  // Get complete knowledge for a user
  getKnowledge(userId: string): Promise<IndividualKnowledge>;
  
  // Philosophy operations
  getPhilosophy(userId: string): Promise<Philosophy>;
  updatePhilosophy(userId: string, update: Partial<Philosophy>): Promise<void>;
  
  // Principle operations
  getPrinciples(userId: string, domain?: string[]): Promise<Principle[]>;
  addPrinciple(userId: string, principle: Omit<Principle, 'id'>): Promise<string>;
  updatePrinciple(userId: string, principleId: string, update: Partial<Principle>): Promise<void>;
  deprecatePrinciple(userId: string, principleId: string, reason: string): Promise<void>;
  
  // Pattern operations
  getPatterns(userId: string, status?: PatternStatus): Promise<Pattern[]>;
  addPattern(userId: string, pattern: Omit<Pattern, 'id'>): Promise<string>;
  promoteToPattern(userId: string, patternId: string): Promise<string>;  // Returns new principle ID
  
  // Context operations
  getContext(userId: string): Promise<UserContext>;
  updateContext(userId: string, update: Partial<UserContext>): Promise<void>;
  
  // Portability
  exportKnowledge(userId: string, level: 'full' | 'redacted' | 'abstracted'): Promise<ExportedKnowledge>;
  importKnowledge(userId: string, data: ExportedKnowledge): Promise<ImportResult>;
  
  // Versioning
  getHistory(userId: string, store: 'philosophy' | 'principles' | 'patterns'): Promise<VersionHistory>;
  revertTo(userId: string, version: number): Promise<void>;
}
```

### Storage Providers
```typescript
interface StorageProvider {
  // Generic storage operations
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;

  // List operations
  list(prefix: string): Promise<string[]>;

  // Versioning (full snapshots - simpler, small document sizes make storage efficient)
  getVersion(key: string, version: number): Promise<any>;
  listVersions(key: string): Promise<VersionInfo[]>;
}

// MVP Implementation - LocalFileStorage only
// CloudFirestoreStorage and HybridStorage deferred to future iterations
class LocalFileStorage implements StorageProvider { }
```

### Portability Levels
```typescript
type PortabilityLevel = 'full' | 'redacted' | 'abstracted';

interface ExportOptions {
  level: PortabilityLevel;
  includeEvidence: boolean;  // Include decision history
  anonymize: boolean;        // Remove identifying info
}

// Full: Everything, including evidence
// Redacted: Remove org-specific context, keep principles
// Abstracted: Principles without evidence, anonymized
```

## Features

### CRUD Operations
- Create, read, update, delete for all knowledge types
- Validation against schemas
- Automatic timestamps

### Versioning
- Track all changes with versions
- Revert to previous versions
- Compare versions
- Audit trail

### Query and Filter
- Get principles by domain
- Get patterns by status
- Search principles by text
- Filter by confidence/weight

### Import/Export
- Export at multiple portability levels
- Import with merge strategy
- Conflict resolution: auto-resolve simple conflicts (timestamps, context), user review for complex ones (philosophy, high-weight principles)
- Verification of imported data

### Sync (Deferred)
- Local-first storage (MVP: local only)
- Background sync to cloud (future)
- Conflict resolution (future)
- Offline support (future)

### Integrity
- Validate knowledge consistency
- Detect circular principle conflicts
- Warn on unusual patterns

## Acceptance Criteria (MVP Scope)

- [ ] CRUD operations for philosophy, principles, patterns, context
- [ ] Versioning with full history (full snapshots)
- [ ] Query principles by domain
- [ ] Export at full/redacted/abstracted levels
- [ ] Import with merge and conflict resolution (auto-resolve simple, user review complex)
- [ ] Local file storage provider
- [ ] Audit trail for all changes
- [ ] Types defined inline (ready for future extraction to contracts package)

### Deferred to Future Iterations
- Cloud storage provider (Firestore)
- Hybrid sync between local and cloud
- HTTP API endpoints (consumed via library by orchestrator)

## User Stories

### US1: Store and Retrieve Knowledge

**As a** Generacy user,
**I want** to store my philosophy, principles, patterns, and context,
**So that** my AI assistant can learn from my decisions over time.

**Acceptance Criteria**:
- [ ] Can create/update/read/delete each knowledge type
- [ ] Changes are versioned and can be reverted

### US2: Export Knowledge for Portability

**As a** user changing jobs or contexts,
**I want** to export my knowledge at different privacy levels,
**So that** I can take my principles with me without exposing sensitive details.

**Acceptance Criteria**:
- [ ] Export at full/redacted/abstracted levels
- [ ] Abstracted export removes identifying information

## Assumptions

- Knowledge documents are relatively small (JSON files < 1MB each)
- Single-user access per knowledge store (no concurrent writes)
- File system available for local storage

## Out of Scope (MVP)

- HTTP/REST API endpoints
- Cloud storage providers
- Real-time sync between devices
- Multi-user collaboration on knowledge stores

---

*Generated by speckit*
