# Research: Knowledge Store Management

## Technology Decisions

### Storage Format: JSON Files

**Decision**: Use JSON files for local storage

**Rationale**:
- Human-readable for debugging and manual inspection
- Native Node.js support via `fs.promises`
- Small document sizes (<1MB) make efficiency concerns minimal
- Easy to version control if desired

**Alternatives Considered**:
- **SQLite**: More complex setup, overkill for single-user document storage
- **LevelDB**: Good performance but binary format, harder to debug
- **YAML**: More readable but slower parsing, unnecessary complexity

### Versioning: Full Snapshots

**Decision**: Store complete document copies for each version

**Rationale**:
- Simple to implement and understand
- Document sizes are small (< 1MB each)
- No complex diff/patch logic needed
- Easy to restore any version without reconstruction
- Audit trail is straightforward

**Alternatives Considered**:
- **Delta/Diff Storage**: Space efficient but complex reconstruction
- **Git-style Object Store**: Overkill for this use case
- **Event Sourcing**: Powerful but significantly more complex

### Validation: Zod

**Decision**: Use Zod for runtime type validation

**Rationale**:
- TypeScript-first with excellent inference
- Single source of truth for types and validation
- Clear error messages
- Zero dependencies
- Can generate JSON Schema if needed later

**Alternatives Considered**:
- **JSON Schema + Ajv**: More verbose, type inference less natural
- **io-ts**: Functional style may be unfamiliar to contributors
- **No validation**: Too risky for data integrity

### Testing: Vitest

**Decision**: Use Vitest for testing

**Rationale**:
- ESM-native (no configuration struggles)
- TypeScript support out of the box
- API compatible with Jest
- Fast execution with intelligent file watching
- Built-in mocking and assertion libraries

## Implementation Patterns

### Atomic File Writes

Pattern for safe file updates:
```typescript
async function atomicWrite(path: string, data: string): Promise<void> {
  const tempPath = `${path}.tmp.${Date.now()}`;
  await fs.writeFile(tempPath, data, 'utf-8');
  await fs.rename(tempPath, path);
}
```

This prevents corruption if the process crashes mid-write.

### Factory Function Pattern

Expose a factory function rather than direct class instantiation:
```typescript
export function createKnowledgeStore(config?: KnowledgeStoreConfig): KnowledgeStoreManager {
  return new KnowledgeStoreManagerImpl(config);
}
```

Benefits:
- Hides implementation details
- Easier to change internal structure
- Simpler testing with mock implementations

### Result Types for Operations

Use discriminated unions for operation results:
```typescript
type ImportResult =
  | { success: true; imported: number; merged: number }
  | { success: false; error: string; conflicts: Conflict[] };
```

Clear handling of success/failure cases without exceptions for expected scenarios.

## Key Implementation Notes

### ID Generation

Use `crypto.randomUUID()` for generating principle/pattern IDs:
- Built into Node.js (no dependencies)
- Universally unique
- URL-safe

### Directory Structure

Knowledge stored per-user to support future multi-user scenarios:
```
{baseDir}/{userId}/
  philosophy.json
  principles.json
  patterns.json
  context.json
  versions/
    philosophy/
      v1.json
      v2.json
    principles/
      v1.json
```

### Export Portability Transforms

| Level | Philosophy | Principles | Patterns | Context |
|-------|------------|------------|----------|---------|
| Full | Complete | Complete with evidence | Complete | Complete |
| Redacted | Complete | Remove org-specific domains | Remove org-specific | Exclude |
| Abstracted | Anonymized | Principles only, no evidence | Exclude | Exclude |

### Conflict Detection Heuristics

When importing, detect conflicts by:
1. **ID Collision**: Same principle ID exists with different content
2. **Semantic Conflict**: Principles that contradict (future: NLP analysis)
3. **Philosophy Divergence**: Different core values

## References

- [Node.js fs.promises API](https://nodejs.org/api/fs.html#promises-api)
- [Zod Documentation](https://zod.dev)
- [Vitest Documentation](https://vitest.dev)
- [RFC 4122 - UUID](https://www.rfc-editor.org/rfc/rfc4122)
