# Implementation Plan: Knowledge Store Management

**Feature**: Knowledge store management service for persisting and managing individual knowledge
**Branch**: `024-knowledge-store-management`
**Status**: Complete

## Summary

Build a TypeScript service that manages the four knowledge stores (philosophy, principles, patterns, context) with CRUD operations, versioning, and import/export capabilities. MVP focuses on local file storage with full snapshot versioning.

## Technical Context

| Aspect | Choice | Rationale |
|--------|--------|-----------|
| Language | TypeScript 5.x | Type safety, aligns with Generacy ecosystem |
| Runtime | Node.js 20+ | LTS, native ESM support |
| Module System | ESM | Modern standard, tree-shakeable |
| Storage | Local JSON files | MVP simplicity, human-readable |
| Versioning | Full snapshots | Simple implementation, small document sizes |
| Testing | Vitest | Fast, ESM-native, TypeScript-first |

## Project Structure

```
packages/knowledge-store/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                    # Public API exports
│   ├── types/
│   │   ├── index.ts               # Type exports
│   │   ├── knowledge.ts           # Core knowledge types
│   │   ├── storage.ts             # Storage provider types
│   │   └── portability.ts         # Export/import types
│   ├── manager/
│   │   ├── KnowledgeStoreManager.ts    # Main manager implementation
│   │   ├── PhilosophyManager.ts        # Philosophy-specific operations
│   │   ├── PrincipleManager.ts         # Principles-specific operations
│   │   ├── PatternManager.ts           # Patterns-specific operations
│   │   └── ContextManager.ts           # Context-specific operations
│   ├── storage/
│   │   ├── StorageProvider.ts          # Interface definition
│   │   ├── LocalFileStorage.ts         # File-based implementation
│   │   └── VersionedStorage.ts         # Versioning wrapper
│   ├── portability/
│   │   ├── Exporter.ts                 # Export functionality
│   │   ├── Importer.ts                 # Import with merge
│   │   └── redaction.ts                # Privacy level transforms
│   ├── validation/
│   │   ├── schemas.ts                  # JSON Schema definitions
│   │   └── validator.ts                # Validation logic
│   └── utils/
│       ├── id.ts                       # ID generation
│       └── timestamps.ts               # Timestamp utilities
└── tests/
    ├── manager/
    │   └── KnowledgeStoreManager.test.ts
    ├── storage/
    │   └── LocalFileStorage.test.ts
    └── portability/
        ├── Exporter.test.ts
        └── Importer.test.ts
```

## Implementation Phases

### Phase 1: Foundation (Types + Storage)
1. Initialize package with TypeScript/ESM configuration
2. Define core knowledge types (philosophy, principles, patterns, context)
3. Implement StorageProvider interface
4. Implement LocalFileStorage with atomic writes
5. Implement VersionedStorage wrapper for full snapshot versioning

### Phase 2: Core Manager
1. Implement KnowledgeStoreManager facade
2. Implement PhilosophyManager (simple CRUD, rare updates)
3. Implement PrincipleManager (CRUD + domain filtering + deprecation)
4. Implement PatternManager (CRUD + status filtering + promotion to principle)
5. Implement ContextManager (CRUD, no versioning needed)

### Phase 3: Advanced Features
1. Implement validation layer with JSON Schema
2. Implement Exporter with three portability levels
3. Implement Importer with merge strategy and conflict detection
4. Add integrity checks (circular conflict detection)

### Phase 4: Quality Assurance
1. Unit tests for all managers
2. Integration tests for storage providers
3. Edge case handling (concurrent access prevention, corruption recovery)

## Key Design Decisions

### Versioning Strategy: Full Snapshots
- Each save creates a complete copy of the document
- Version files stored as `{key}.v{n}.json`
- Simple to implement and reason about
- Storage efficient given small document sizes (<1MB)

### File Organization
```
~/.generacy/knowledge/{userId}/
├── philosophy.json           # Current philosophy
├── philosophy.v1.json        # Version history
├── philosophy.v2.json
├── principles.json           # Current principles array
├── principles.v1.json
├── patterns.json             # Current patterns array
├── context.json              # Current context (not versioned)
└── audit.json                # Audit trail
```

### Conflict Resolution Strategy
- **Auto-resolve** (simple): timestamps, context updates, low-weight principles
- **User review** (complex): philosophy changes, high-weight principles (>0.8)
- Import returns `ImportResult` with resolved and pending conflicts

### Single-User Assumption
- No concurrent write handling needed
- File locks not implemented (future enhancement if needed)
- Operations are atomic via temp file + rename pattern

## Dependencies

```json
{
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0"
  }
}
```

## Configuration

Default configuration via environment or constructor options:
```typescript
interface KnowledgeStoreConfig {
  baseDir?: string;         // Default: ~/.generacy/knowledge
  maxVersions?: number;     // Default: 50 (per document)
  enableAudit?: boolean;    // Default: true
}
```

## API Preview

```typescript
import { createKnowledgeStore } from '@generacy-ai/knowledge-store';

// Create manager instance
const store = createKnowledgeStore({ baseDir: './data' });

// Philosophy operations
const philosophy = await store.getPhilosophy('user-123');
await store.updatePhilosophy('user-123', { values: [...] });

// Principles with filtering
const principles = await store.getPrinciples('user-123', ['coding', 'design']);
await store.addPrinciple('user-123', { content: '...', domain: ['coding'] });

// Export for portability
const exported = await store.exportKnowledge('user-123', 'abstracted');

// Import with merge
const result = await store.importKnowledge('user-123', importedData);
if (result.conflicts.length > 0) {
  // Handle conflicts requiring user review
}
```

## Next Steps

Run `/speckit:tasks` to generate the detailed task breakdown from this plan.
