# Feature Specification: Knowledge store management

**Branch**: `024-knowledge-store-management` | **Date**: 2026-01-19 | **Status**: Draft

## Summary

## Summary

Implement knowledge store management - the service that persists and manages individual knowledge (philosophy, principles, patterns, context).

## Parent Epic

#2 - Generacy Core Package

## Dependencies

- generacy-ai/contracts - Knowledge store schemas

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
  
  // Versioning
  getVersion(key: string, version: number): Promise<any>;
  listVersions(key: string): Promise<VersionInfo[]>;
}

// Implementations
class LocalFileStorage implements StorageProvider { }
class CloudFirestoreStorage implements StorageProvider { }
class HybridStorage implements StorageProvider { }  // Local + Cloud sync
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
- Conflict detection and resolution
- Verification of imported data

### Sync
- Local-first storage
- Background sync to cloud
- Conflict resolution
- Offline support

### Integrity
- Validate knowledge consistency
- Detect circular principle conflicts
- Warn on unusual patterns

## Acceptance Criteria

- [ ] CRUD operations for philosophy, principles, patterns, context
- [ ] Versioning with full history
- [ ] Query principles by domain
- [ ] Export at full/redacted/abstracted levels
- [ ] Import with merge and conflict resolution
- [ ] Local file storage provider
- [ ] Cloud storage provider (for cloud version)
- [ ] Hybrid sync between local and cloud
- [ ] Audit trail for all changes

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
