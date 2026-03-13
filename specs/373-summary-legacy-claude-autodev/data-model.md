# Data Model: SpecKit Config Schema Extension

## Core Entities

### SpecKitConfig (new)

Top-level optional section added to `GeneracyConfigSchema`.

```typescript
interface SpecKitConfig {
  paths: SpecKitPaths;
  files: SpecKitFiles;
  branches: SpecKitBranches;
}
```

### SpecKitPaths

```typescript
interface SpecKitPaths {
  /** Directory containing spec feature directories. Default: "specs" */
  specs: string;
  /** Directory containing spec templates. Default: ".specify/templates" */
  templates: string;
}
```

### SpecKitFiles

```typescript
interface SpecKitFiles {
  /** Spec document filename. Default: "spec.md" */
  spec: string;
  /** Plan document filename. Default: "plan.md" */
  plan: string;
  /** Tasks document filename. Default: "tasks.md" */
  tasks: string;
  /** Clarifications document filename. Default: "clarifications.md" */
  clarifications: string;
  /** Research document filename. Default: "research.md" */
  research: string;
  /** Data model document filename. Default: "data-model.md" */
  dataModel: string;
}
```

### SpecKitBranches

```typescript
interface SpecKitBranches {
  /** Branch name pattern. Default: "{paddedNumber}-{slug}" */
  pattern: string;
  /** Zero-padding width for issue numbers. Default: 3 */
  numberPadding: number;
  /** Slug generation options */
  slugOptions: SlugOptions;
}

interface SlugOptions {
  /** Maximum slug length. Default: 30 */
  maxLength: number;
  /** Word separator character. Default: "-" */
  separator: string;
  /** Whether to strip stop words. Default: true */
  removeStopWords: boolean;
  /** Maximum words in slug. Default: 4 */
  maxWords: number;
}
```

## YAML Representation

```yaml
# .generacy/config.yaml (speckit section)
speckit:                          # optional, entire section
  paths:                          # optional, defaults to {}
    specs: "specs"                # optional, default "specs"
    templates: ".specify/templates" # optional, default ".specify/templates"
  files:                          # optional, defaults to {}
    spec: "spec.md"               # optional, default "spec.md"
    plan: "plan.md"               # optional, default "plan.md"
    tasks: "tasks.md"             # optional, default "tasks.md"
    clarifications: "clarifications.md"
    research: "research.md"
    dataModel: "data-model.md"
  branches:                       # optional, defaults to {}
    pattern: "{paddedNumber}-{slug}"
    numberPadding: 3
    slugOptions:
      maxLength: 30
      separator: "-"
      removeStopWords: true
      maxWords: 4
```

## Zod Schema

```typescript
export const SlugOptionsSchema = z.object({
  maxLength: z.number().int().min(1).default(30),
  separator: z.string().default('-'),
  removeStopWords: z.boolean().default(true),
  maxWords: z.number().int().min(1).default(4),
}).default({});

export const SpecKitBranchesSchema = z.object({
  pattern: z.string().default('{paddedNumber}-{slug}'),
  numberPadding: z.number().int().min(1).default(3),
  slugOptions: SlugOptionsSchema,
}).default({});

export const SpecKitPathsSchema = z.object({
  specs: z.string().default('specs'),
  templates: z.string().default('.specify/templates'),
}).default({});

export const SpecKitFilesSchema = z.object({
  spec: z.string().default('spec.md'),
  plan: z.string().default('plan.md'),
  tasks: z.string().default('tasks.md'),
  clarifications: z.string().default('clarifications.md'),
  research: z.string().default('research.md'),
  dataModel: z.string().default('data-model.md'),
}).default({});

export const SpecKitConfigSchema = z.object({
  paths: SpecKitPathsSchema,
  files: SpecKitFilesSchema,
  branches: SpecKitBranchesSchema,
});
```

## Relationships

```
GeneracyConfig
├── project (required)
├── repos (required)
├── defaults (optional)
├── orchestrator (optional)
├── cluster (optional)
├── workspace (optional)
└── speckit (optional, NEW)
    ├── paths
    │   ├── specs → used by resolveSpecsPath()
    │   └── templates → used by resolveTemplatesPath()
    ├── files → used by getFilesConfig()
    │   ├── spec, plan, tasks, clarifications, research, dataModel
    └── branches → used by loadBranchConfig()
        ├── pattern, numberPadding
        └── slugOptions
```

## Validation Rules

- All string fields: non-empty when provided
- `numberPadding`: positive integer (≥1)
- `slugOptions.maxLength`: positive integer (≥1)
- `slugOptions.maxWords`: positive integer (≥1)
- No path traversal validation (runtime concern, not schema)
