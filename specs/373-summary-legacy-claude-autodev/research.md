# Research: Config Migration from autodev.json to .generacy/config.yaml

## Technology Decisions

### 1. YAML Parsing Strategy in workflow-engine

**Decision**: Parse `.generacy/config.yaml` directly using the `yaml` package in `fs.ts` and `feature.ts`, rather than importing `loadConfig()` from `@generacy-ai/generacy`.

**Rationale**:
- The existing functions already do direct file I/O (read file → JSON.parse → extract field → fallback)
- Importing `loadConfig()` would create a new cross-package dependency (`workflow-engine` → `generacy`)
- `loadConfig()` performs full schema validation via Zod, which is heavier than needed for extracting a single config field
- The `yaml` package is already available transitively; adding it as an explicit dependency is trivial

**Alternative considered**: Use the full `loadConfig()` pipeline
- Pro: Zod-validated, type-safe
- Con: Introduces circular or undesirable dependency graph; overkill for fallback-to-default pattern

### 2. Schema Design: Optional with Nested Defaults

**Decision**: Make the entire `speckit` section optional with `.optional().default({})` and use `.default()` on each leaf field.

**Rationale**:
- Existing `.generacy/config.yaml` files in the wild have no `speckit` section
- Adding a required section would break validation for all existing configs
- Zod's `.default()` on nested objects ensures correct values bubble up even when the section is omitted

**Pattern**:
```typescript
const SpecKitConfigSchema = z.object({
  paths: z.object({
    specs: z.string().default('specs'),
    templates: z.string().default('.specify/templates'),
  }).default({}),
  files: z.object({ ... }).default({}),
  branches: z.object({ ... }).default({}),
}).optional();
```

### 3. No Backward Compatibility / Fallback

**Decision**: No code will check `.claude/autodev.json` after migration. Forward-only.

**Rationale**:
- `.claude/autodev.json` only exists in this repo (generacy)
- We control the migration — no external consumers
- A fallback chain adds complexity and testing burden with no benefit
- Clean break simplifies long-term maintenance

## Implementation Patterns

### Config Reading Pattern (Before → After)

**Before** (`fs.ts:111-130`):
```typescript
const configPath = join(repoRoot, '.claude', 'autodev.json');
if (await exists(configPath)) {
  const content = await readFile(configPath);
  const config = JSON.parse(content);
  if (config.paths?.specs) {
    return join(repoRoot, config.paths.specs);
  }
}
return join(repoRoot, 'specs'); // default
```

**After**:
```typescript
const configPath = join(repoRoot, '.generacy', 'config.yaml');
if (await exists(configPath)) {
  const content = await readFile(configPath);
  const config = parseYaml(content);
  if (config?.speckit?.paths?.specs) {
    return join(repoRoot, config.speckit.paths.specs);
  }
}
return join(repoRoot, 'specs'); // default
```

The pattern is nearly identical — only the file path, parser (`parseYaml` vs `JSON.parse`), and property path change.

### Test Mock Pattern

**Before** (`feature.test.ts`):
```typescript
existsFor({
  '.git': true,
  'autodev.json': false,
});
```

**After**:
```typescript
existsFor({
  '.git': true,
  'config.yaml': false,
});
```

The `existsFor` helper in the test file maps short filenames to `exists()` mock behavior. The key changes from `'autodev.json'` to `'config.yaml'`.

## Key Sources

- Existing schema: `packages/generacy/src/config/schema.ts` (lines 145-184)
- Config loader: `packages/generacy/src/config/loader.ts` (uses `yaml` package, Zod validation)
- Current autodev.json content: `{ version, stateProvider, paths: { specs: "specs" } }`
- Default branch config: `feature.ts:25-34` (pattern, numberPadding, slugOptions)
- Default files config: `fs.ts:173-180` (spec, plan, tasks, clarifications, research, dataModel)
