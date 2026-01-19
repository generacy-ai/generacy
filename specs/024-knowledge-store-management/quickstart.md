# Quickstart: Knowledge Store Management

## Installation

```bash
# From the monorepo root
npm install

# Or install the package directly (when published)
npm install @generacy-ai/knowledge-store
```

## Basic Usage

### Initialize the Store

```typescript
import { createKnowledgeStore } from '@generacy-ai/knowledge-store';

// Create with default settings (~/.generacy/knowledge)
const store = createKnowledgeStore();

// Or specify a custom directory
const store = createKnowledgeStore({
  baseDir: './my-knowledge',
  maxVersions: 100,
  enableAudit: true,
});
```

### Working with Philosophy

```typescript
const userId = 'user-123';

// Get philosophy (creates default if not exists)
const philosophy = await store.getPhilosophy(userId);

// Update philosophy
await store.updatePhilosophy(userId, {
  values: [
    { name: 'Quality', description: 'Code should be maintainable', priority: 1 },
    { name: 'Simplicity', description: 'Avoid over-engineering', priority: 2 },
  ],
  beliefs: [
    {
      statement: 'Tests are documentation',
      confidence: 0.9,
      domain: ['testing']
    },
  ],
});
```

### Working with Principles

```typescript
// Add a new principle
const principleId = await store.addPrinciple(userId, {
  content: 'Prefer composition over inheritance',
  domain: ['coding', 'oop'],
  weight: 0.85,
  evidence: [
    {
      decision: 'Used composition for user permissions',
      context: 'Auth system refactor',
      outcome: 'positive',
      timestamp: new Date().toISOString(),
    },
  ],
});

// Get principles by domain
const codingPrinciples = await store.getPrinciples(userId, ['coding']);

// Update a principle
await store.updatePrinciple(userId, principleId, {
  weight: 0.9,  // Increase weight based on positive outcomes
});

// Deprecate a principle
await store.deprecatePrinciple(
  userId,
  principleId,
  'Superseded by new architecture guidelines'
);
```

### Working with Patterns

```typescript
// Add an emerging pattern
const patternId = await store.addPattern(userId, {
  description: 'Preferring early returns over nested conditionals',
  domain: ['coding', 'readability'],
  occurrences: [
    {
      context: 'Refactoring validation logic',
      decision: 'Used guard clauses',
      timestamp: new Date().toISOString(),
    },
  ],
});

// Get patterns by status
const established = await store.getPatterns(userId, 'established');

// Promote pattern to principle
const newPrincipleId = await store.promoteToPattern(userId, patternId);
```

### Working with Context

```typescript
// Get current context
const context = await store.getContext(userId);

// Update context
await store.updateContext(userId, {
  currentProject: {
    name: 'generacy',
    type: 'library',
    technologies: ['typescript', 'node'],
  },
  activeGoals: ['Complete knowledge store', 'Write documentation'],
});
```

### Export/Import

```typescript
// Export for portability
const exported = await store.exportKnowledge(userId, 'abstracted');
// Save to file or transfer

// Import with merge
const importResult = await store.importKnowledge(userId, importedData);

if (importResult.conflicts.length > 0) {
  // Handle conflicts that need user review
  for (const conflict of importResult.conflicts) {
    console.log(`Conflict in ${conflict.type}:`, conflict.reason);
    // Present to user for resolution
  }
}
```

### Version History

```typescript
// Get version history
const history = await store.getHistory(userId, 'principles');
console.log(`${history.versions.length} versions available`);

// Revert to a previous version
await store.revertTo(userId, 5);
```

## Available Commands

After implementation, the following npm scripts will be available:

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Build the package
npm run build

# Lint the code
npm run lint
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseDir` | string | `~/.generacy/knowledge` | Base directory for storage |
| `maxVersions` | number | 50 | Max versions to keep per document |
| `enableAudit` | boolean | true | Enable audit trail logging |

## Troubleshooting

### "Permission denied" errors

Ensure the storage directory is writable:
```bash
chmod 755 ~/.generacy/knowledge
```

### Corrupted data

If a JSON file becomes corrupted, restore from version history:
```typescript
// List available versions
const versions = await store.getHistory(userId, 'principles');

// Revert to a known good version
await store.revertTo(userId, versions.versions[1].version);
```

### Import conflicts

When importing, conflicts are returned for user resolution:
```typescript
const result = await store.importKnowledge(userId, data);
// Auto-resolved conflicts are already applied
// Pending conflicts need manual resolution via updatePrinciple, etc.
```

## Next Steps

- Read the [Data Model](./data-model.md) for type definitions
- See [Research](./research.md) for design decisions
- Check the [Plan](./plan.md) for implementation details
