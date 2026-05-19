# Research: Config File Loading & Validation

## Technology Decisions

### 1. YAML Parsing with `yaml` Package

**Decision**: Use `yaml ^2.4.0` (already a devDependency) promoted to a regular dependency for runtime YAML parsing.

**Rationale**:
- Already used in test fixtures across the monorepo (`@generacy-ai/config`, `@generacy-ai/credhelper` tests)
- Provides source-map line/column info for parse errors via `yaml.parseDocument()` + `doc.errors`
- Handles YAML 1.2 spec correctly (no "Norway problem" — `NO` is a string, not boolean)
- Good TypeScript types

**Alternatives considered**:
- **js-yaml**: Older, YAML 1.1 by default (boolean coercion issues), less maintained
- **JSON**: Config files are YAML per the architecture plan; adding a JSON fallback adds complexity for no benefit
- **TOML**: Not established in the project; YAML is the declared format

### 2. Error Accumulation Pattern

**Decision**: Accumulate errors in a `ConfigError[]` array passed through all validation stages, then throw a single `ConfigValidationError` at the end.

**Rationale** (from clarification C3):
- Config files are small and loaded once at boot — no performance concern with continuing after errors
- Failing on first error forces fix-one-rerun cycles; batch reporting lets developers fix everything in one pass
- Implementation is straightforward: replace `throw` with `errors.push()`, check array at the end

**Pattern**:
```typescript
const errors: ConfigError[] = [];

// Each function accumulates into errors
readRequiredYaml(backendsPath, BackendsConfigSchema, errors);
readOptionalYaml(localPath, CredentialsConfigSchema, errors);
validateCrossRefs(config, errors);

if (errors.length > 0) {
  throw new ConfigValidationError(errors);
}
```

**Alternatives considered**:
- **Fail-fast (throw on first)**: Simpler but painful DX per clarification C3
- **Result/Either monad**: Over-engineered for a boot-time loader; simple array is sufficient
- **Per-file error collection**: Partial — would stop loading subsequent files on first file failure, missing cross-file errors

### 3. Overlay Merge by ID (Full Replacement)

**Decision**: `credentials.local.yaml` entries replace `credentials.yaml` entries matched by `id`, with no field-level merge.

**Rationale** (decision #11 from architecture plan):
- Full replacement is simpler to reason about — if you override a credential, you own the entire definition
- Avoids ambiguity about which fields merged from which source
- Overlay can add entirely new credential ids
- Logging reports exactly which ids came from overlay (never invisible)

**Pattern**:
```typescript
function mergeCredentialOverlay(
  committed: CredentialEntry[],
  overlay: CredentialEntry[],
): { merged: CredentialEntry[]; overlayIds: string[] } {
  const map = new Map(committed.map(c => [c.id, c]));
  const overlayIds: string[] = [];
  for (const entry of overlay) {
    map.set(entry.id, entry);  // full replacement
    overlayIds.push(entry.id);
  }
  return { merged: [...map.values()], overlayIds };
}
```

**Alternatives considered**:
- **Deep merge**: Complex, ambiguous ("does replacing `mint` clear `scopeTemplate`?"), explicitly rejected by spec
- **Array concatenation**: Would create duplicate ids; merge-by-key is required

### 4. Role Extends Resolution Strategy

**Decision**: Iterative resolution with visited-set cycle detection, resolving the full chain before merging.

**Rationale**:
- Architecture plan specifies multi-level extends (grandparent → parent → child)
- Credential merge uses same by-key (`ref`) semantics as overlay merge — consistent and predictable
- Circular detection with a visited set is O(n) and catches cycles immediately

**Pattern**:
```typescript
function resolveChain(roleId: string, rolesMap: Map<string, RoleConfig>, visited: Set<string>): RoleConfig {
  if (visited.has(roleId)) throw circular error;
  visited.add(roleId);
  const role = rolesMap.get(roleId);
  if (!role?.extends) return role;
  const parent = resolveChain(role.extends, rolesMap, visited);
  return mergeRoleCredentials(parent, role);
}
```

**Alternatives considered**:
- **Topological sort**: More complex; unnecessary when extends is a single-parent chain
- **Lazy resolution (resolve on access)**: Defers errors; we want fail-closed at boot

### 5. Module Organization: `src/config/` Subdirectory

**Decision**: Place all config loading code in `src/config/` with its own barrel export, keeping Phase 1 schemas/types untouched.

**Rationale**:
- Phase 1 (`src/schemas/`, `src/types/`) is pure contracts — no runtime behavior
- Phase 2 adds runtime file I/O and validation logic — different concern
- Separate subdirectory makes the boundary clear and avoids cluttering the existing structure
- Follows the general pattern of grouping related modules (like `src/types/` groups all type files)

**Alternatives considered**:
- **Flat in `src/`**: A single `src/loader.ts` would work for simple cases, but this feature has 5+ files — subdirectory keeps it organized
- **Separate package**: Over-engineered; the loader and schemas are tightly coupled (same Zod schemas)

### 6. Optional Plugin Registry (Dependency Injection)

**Decision**: `loadConfig()` accepts an optional `pluginRegistry?: Map<string, ExposureKind[]>` parameter. Exposure-against-plugin validation runs only when provided.

**Rationale** (from clarification C1):
- Config loader's primary job is reading and validating files
- Exposure-against-plugin validation depends on both config and plugins being loaded
- Making the registry optional keeps the loader testable in isolation
- The daemon boot sequence passes the real registry for full validation

**Alternatives considered**:
- **Always require registry**: Forces circular dependency with #460 (plugin loader)
- **Never validate exposures**: Defers errors too late; when the registry is available, we should use it
- **Post-load validation hook**: Same effect but less discoverable

## Implementation Patterns

### File Reader Pattern

Following `@generacy-ai/config/src/loader.ts`:
```typescript
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodSchema, ZodError } from 'zod';

function readRequiredYaml<T>(
  filePath: string,
  schema: ZodSchema<T>,
  errors: ConfigError[],
): T | null {
  if (!existsSync(filePath)) {
    errors.push({ file: filePath, message: 'Required file not found' });
    return null;
  }
  try {
    const raw = parseYaml(readFileSync(filePath, 'utf-8'));
    return schema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      mapZodErrors(err, filePath, errors);
    } else {
      errors.push({ file: filePath, message: `YAML parse error: ${(err as Error).message}` });
    }
    return null;
  }
}
```

### Cross-Reference Validation Pattern

```typescript
function validateCredentialBackendRefs(
  credentials: CredentialEntry[],
  backendIds: Set<string>,
  credentialsFile: string,
  errors: ConfigError[],
): void {
  for (const cred of credentials) {
    if (!backendIds.has(cred.backend)) {
      errors.push({
        file: credentialsFile,
        field: `credentials[id=${cred.id}].backend`,
        message: `Backend "${cred.backend}" not found in backends.yaml`,
      });
    }
  }
}
```

### Test Pattern

Following existing credhelper test patterns with temp directories:
```typescript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';

let agencyDir: string;
beforeEach(() => {
  agencyDir = mkdtempSync(join(tmpdir(), 'credhelper-test-'));
  mkdirSync(join(agencyDir, 'secrets'), { recursive: true });
  mkdirSync(join(agencyDir, 'roles'), { recursive: true });
});
afterEach(() => {
  rmSync(agencyDir, { recursive: true, force: true });
});
```

## Key Sources

- [Credentials Architecture Plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md) — decisions #10 and #11
- [Phase 1 Spec](/workspaces/generacy/specs/458-credentials-architecture/) — Zod schemas and types
- [Clarifications](/workspaces/generacy/specs/462-credentials-architecture/clarifications.md) — C1–C5 resolved design decisions
- [`@generacy-ai/config` loader](/workspaces/generacy/packages/config/src/loader.ts) — reference for YAML loading patterns
- [yaml package docs](https://eemeli.org/yaml/) — YAML 1.2 parser with source map support
