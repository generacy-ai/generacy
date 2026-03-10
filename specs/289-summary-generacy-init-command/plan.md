# Implementation Plan: Integrate cluster-templates into `generacy init`

**Branch**: `289-summary-generacy-init-command` | **Date**: 2026-03-03

## Summary

Replace the existing single-repo/multi-repo devcontainer template system with cluster-templates that provide full development cluster configurations (orchestrator + workers + Redis). Users choose between **standard** (DooD) and **microservices** (DinD) variants. The implementation extends the existing `@generacy-ai/templates` package with cluster template files and modifies `selectTemplates()` to route based on a new `variant` field in `TemplateContext`. The init command gains a `--variant` flag integrated into the existing option resolution flow.

## Technical Context

- **Language**: TypeScript (ESM modules)
- **Framework**: Commander.js (CLI), Handlebars (templates), Zod (validation)
- **Packages modified**: `@generacy-ai/templates`, `@generacy-ai/generacy` (CLI)
- **Test framework**: Vitest
- **Key dependencies**: `handlebars@^4.7.8`, `js-yaml@^4.1.0`, `zod@^3.23.8`, `@clack/prompts`, `diff`

## Architecture Overview

```
CLI (generacy init)                    Templates Package
┌─────────────────────┐               ┌──────────────────────────────┐
│ initCommand()       │               │ schema.ts                    │
│  + --variant flag   │               │  + ClusterVariant type       │
│                     │               │  + variant in TemplateContext │
│ resolver.ts         │               │                              │
│  + variant resolution│              │ builders.ts                  │
│    (flag>config>     │              │  + buildClusterContext()      │
│     prompt>default)  │              │    (replaces single/multi)   │
│                     │               │                              │
│ prompts.ts          │               │ renderer.ts                  │
│  + variant select   │               │  + selectTemplates() routes  │
│                     │               │    to cluster/{variant}/*    │
│ writer.ts           │               │                              │
│  + chmod for .sh    │               │ validators.ts                │
│                     │               │  + relaxed devcontainer check│
│ summary.ts          │               │  + .env.template check       │
│  + show variant     │               │                              │
│                     │               │ cluster/standard/*.hbs       │
│ types.ts            │               │ cluster/microservices/*.hbs  │
│  + variant field    │               │ cluster/shared/scripts/      │
└────────┬────────────┘               └──────────────────────────────┘
         │                                          │
         │         config/schema.ts                  │
         └────────►  + cluster.variant field ◄───────┘
```

**Key architectural decision**: Extend `renderProject()` and `selectTemplates()` with variant-aware routing rather than creating a separate `renderCluster()` function. This follows the existing pattern where `isMultiRepo` drives template selection — now `variant` drives it instead.

## Implementation Phases

### Phase 1: Template Schema & Context Changes
**Goal**: Add variant to the type system and context builders

#### 1.1 Extend TemplateContext schema (`packages/templates/src/schema.ts`)

Add `ClusterVariant` type and `cluster` field to `TemplateContext`:

```typescript
// New type
export const ClusterVariantSchema = z.enum(['standard', 'microservices']);
export type ClusterVariant = z.infer<typeof ClusterVariantSchema>;

// New context section
export const ClusterContextSchema = z.object({
  variant: ClusterVariantSchema.default('standard'),
});
export type ClusterContext = z.infer<typeof ClusterContextSchema>;
```

Add `cluster` to `TemplateContextSchema`:

```typescript
export const TemplateContextSchema = z.object({
  project: ProjectContextSchema,
  repos: ReposContextSchema,
  defaults: DefaultsContextSchema,
  orchestrator: OrchestratorContextSchema,
  devcontainer: DevContainerContextSchema,
  metadata: MetadataContextSchema,
  cluster: ClusterContextSchema, // NEW
});
```

Update input schemas (`SingleRepoInput`, `MultiRepoInput`) to accept optional `variant` field.

**Files**: `packages/templates/src/schema.ts`

#### 1.2 Update context builders (`packages/templates/src/builders.ts`)

- Add `variant` parameter to both `buildSingleRepoContext()` and `buildMultiRepoContext()`
- Both builders populate `cluster: { variant }` in the context
- Default variant: `'standard'`
- Add `withVariant()` context modifier for post-build override

Since cluster templates fully replace single-repo/multi-repo (per Q1), all projects now get cluster templates. The `isMultiRepo` flag remains relevant for config.yaml and shared templates but no longer drives devcontainer template selection.

**Files**: `packages/templates/src/builders.ts`

#### 1.3 Export new types (`packages/templates/src/index.ts`)

- Export `ClusterVariant`, `ClusterContext`, `ClusterVariantSchema`, `ClusterContextSchema`
- Export `withVariant` builder helper

**Files**: `packages/templates/src/index.ts`

---

### Phase 2: Create Cluster Template Files
**Goal**: Bundle cluster-templates content as Handlebars templates and static scripts

#### 2.1 Create directory structure

```
packages/templates/src/
├── cluster/
│   ├── standard/
│   │   ├── Dockerfile.hbs
│   │   ├── docker-compose.yml.hbs
│   │   ├── devcontainer.json.hbs
│   │   └── env.template.hbs
│   ├── microservices/
│   │   ├── Dockerfile.hbs
│   │   ├── docker-compose.yml.hbs
│   │   ├── devcontainer.json.hbs
│   │   └── env.template.hbs
│   └── shared/
│       └── scripts/
│           ├── entrypoint-orchestrator.sh
│           ├── entrypoint-worker.sh
│           ├── setup-credentials.sh
│           └── setup-docker-dind.sh  (microservices only)
```

#### 2.2 Create standard variant templates

**`cluster/standard/Dockerfile.hbs`**: Multi-stage Dockerfile with:
- Base: `mcr.microsoft.com/devcontainers/typescript-node:22-bookworm` (hardcoded per Q6)
- Stage 1: Install GH CLI
- Stage 2: Install Generacy CLI + Claude Code
- No Docker CE installation (standard = DooD)
- `COPY --chmod=755` for scripts

**`cluster/standard/docker-compose.yml.hbs`**: Compose file with:
- `redis` service with health check
- `orchestrator` service (builds Dockerfile, role=orchestrator)
- `worker` service (scaled, role=worker)
- Runtime env vars: `${WORKER_COUNT:-3}`, `${ORCHESTRATOR_PORT:-3100}` (per Q12)
- Environment variables use `GITHUB_TOKEN` / `ANTHROPIC_API_KEY` with fallbacks (per Q2)
- Volume mounts for workspace and state persistence
- `generacy` bridge network

**`cluster/standard/devcontainer.json.hbs`**: Dev container config with:
- `name`: `{{project.name}}`
- `dockerComposeFile`: `docker-compose.yml`
- `service`: `orchestrator`
- `workspaceFolder`: based on primary repo
- NO Generacy Dev Container Feature (per Q9, Dockerfile handles CLI installation)
- `customizations.vscode.extensions` with Generacy extensions

**`cluster/standard/env.template.hbs`**: Environment template with:
- `GITHUB_TOKEN` (preferred) with comment noting `GH_TOKEN` alias
- `ANTHROPIC_API_KEY` (preferred) with comment noting `CLAUDE_API_KEY` alias
- `REPO_URL={{repos.primary}}` (Handlebars-substituted default)
- `REPO_BRANCH={{defaults.baseBranch}}` (Handlebars-substituted default)
- `WORKER_COUNT=3`, `ORCHESTRATOR_PORT=3100` as runtime defaults
- `REDIS_URL=redis://redis:6379`

#### 2.3 Create microservices variant templates

Copy standard templates as base, then add:
- **Dockerfile**: Additional stage for Docker CE installation (`docker-ce`, `docker-ce-cli`, `containerd.io`)
- **docker-compose.yml**: Add `privileged: true` and `ENABLE_DIND=true` to worker service
- **devcontainer.json**: Same structure as standard
- **.env.template**: Add `ENABLE_DIND=true`

#### 2.4 Create shared scripts

**Static files** (no Handlebars, copied as-is per Q8):

- `entrypoint-orchestrator.sh`: Orchestrator startup script (source credentials, start orchestrator process)
- `entrypoint-worker.sh`: Worker startup script (source credentials, start worker process)
- `setup-credentials.sh`: Credential setup (handles `${GITHUB_TOKEN:-$GH_TOKEN}` and `${ANTHROPIC_API_KEY:-$CLAUDE_API_KEY}` fallbacks)
- `setup-docker-dind.sh`: DinD setup (start dockerd, wait for socket) — only included for microservices

**Files**: All files under `packages/templates/src/cluster/`

#### 2.5 Update `package.json` files field

Add `src/cluster` to the `files` array in `packages/templates/package.json` so cluster templates are included in the published package.

**Files**: `packages/templates/package.json`

---

### Phase 3: Template Selection & Rendering
**Goal**: Wire cluster templates into the rendering engine

#### 3.1 Update `selectTemplates()` in renderer.ts

Replace the `isMultiRepo`-based template selection with variant-based routing:

```typescript
export function selectTemplates(context: TemplateContext): TemplateInfo[] {
  const templates: TemplateInfo[] = [
    // Shared templates (always included — unchanged)
    { templatePath: 'shared/config.yaml.hbs', targetPath: '.generacy/config.yaml', ... },
    { templatePath: 'shared/generacy.env.template.hbs', targetPath: '.generacy/generacy.env.template', ... },
    { templatePath: 'shared/gitignore.template', targetPath: '.generacy/.gitignore', ... },
    { templatePath: 'shared/extensions.json.hbs', targetPath: '.vscode/extensions.json', ... },
  ];

  const variant = context.cluster.variant;

  // Cluster variant templates (Handlebars)
  templates.push(
    { templatePath: `cluster/${variant}/Dockerfile.hbs`, targetPath: '.devcontainer/Dockerfile', requiresMerge: false, isStatic: false },
    { templatePath: `cluster/${variant}/docker-compose.yml.hbs`, targetPath: '.devcontainer/docker-compose.yml', requiresMerge: false, isStatic: false },
    { templatePath: `cluster/${variant}/devcontainer.json.hbs`, targetPath: '.devcontainer/devcontainer.json', requiresMerge: false, isStatic: false },
    { templatePath: `cluster/${variant}/env.template.hbs`, targetPath: '.devcontainer/.env.template', requiresMerge: false, isStatic: false },
  );

  // Shared scripts (static)
  templates.push(
    { templatePath: 'cluster/shared/scripts/entrypoint-orchestrator.sh', targetPath: '.devcontainer/scripts/entrypoint-orchestrator.sh', requiresMerge: false, isStatic: true },
    { templatePath: 'cluster/shared/scripts/entrypoint-worker.sh', targetPath: '.devcontainer/scripts/entrypoint-worker.sh', requiresMerge: false, isStatic: true },
    { templatePath: 'cluster/shared/scripts/setup-credentials.sh', targetPath: '.devcontainer/scripts/setup-credentials.sh', requiresMerge: false, isStatic: true },
  );

  // Microservices-only script
  if (variant === 'microservices') {
    templates.push({
      templatePath: 'cluster/shared/scripts/setup-docker-dind.sh',
      targetPath: '.devcontainer/scripts/setup-docker-dind.sh',
      requiresMerge: false,
      isStatic: true,
    });
  }

  return templates;
}
```

The old `single-repo/` and `multi-repo/` template paths are no longer selected. They can remain in the codebase for backward compatibility during the transition but are effectively dead code.

**Files**: `packages/templates/src/renderer.ts`

#### 3.2 Update Handlebars strict mode handling

Since cluster Handlebars templates reference `cluster.variant` and shell scripts are static (no Handlebars), no changes are needed to the Handlebars configuration. The existing `strict: true` + `noEscape: true` settings work for cluster templates.

Verify that `findUndefinedVariables()` in `validators.ts` won't false-positive on bash `${VAR:-default}` syntax in static files. Since static files skip Handlebars rendering and `findUndefinedVariables()` checks for `{{ }}` Handlebars syntax (not `${ }` bash syntax), this is safe.

**Files**: No changes needed (verification only)

---

### Phase 4: CLI Integration
**Goal**: Add variant flag, prompt, and resolution to the init command

#### 4.1 Add variant to `InitOptions` (`packages/generacy/src/cli/commands/init/types.ts`)

```typescript
export interface InitOptions {
  // ... existing fields ...
  /** Cluster variant: standard (DooD) or microservices (DinD). */
  variant: 'standard' | 'microservices';
}
```

**Files**: `packages/generacy/src/cli/commands/init/types.ts`

#### 4.2 Add `--variant` CLI flag (`packages/generacy/src/cli/commands/init/index.ts`)

```typescript
.addOption(
  new Option('--variant <variant>', 'Cluster variant')
    .choices(['standard', 'microservices'])
)
```

No default value on the Option — resolution happens in `resolveOptions()`.

**Files**: `packages/generacy/src/cli/commands/init/index.ts`

#### 4.3 Update option resolver (`packages/generacy/src/cli/commands/init/resolver.ts`)

**In `extractFlags()`**: Extract `variant` from CLI flags:
```typescript
if (typeof flags.variant === 'string') {
  partial.variant = flags.variant as 'standard' | 'microservices';
}
```

**In `loadExistingDefaults()`**: Read variant from existing config:
```typescript
if (config.cluster?.variant) {
  defaults.variant = config.cluster.variant;
}
```

**In `resolveOptions()`**: After merging flags + existing config:
- If `--yes` and no variant resolved: default to `'standard'`
- If interactive and no variant resolved: prompt will collect it

**In final assembly**: Add `variant: merged.variant ?? 'standard'` to resolved options.

**Files**: `packages/generacy/src/cli/commands/init/resolver.ts`

#### 4.4 Add variant prompt (`packages/generacy/src/cli/commands/init/prompts.ts`)

Insert variant selection prompt **before** the existing project name prompt:

```typescript
// ── Cluster variant ──
if (defaults.variant !== undefined) {
  result.variant = defaults.variant;
} else {
  const defaultVariant = existing.variant ?? 'standard';
  const variant = await p.select({
    message: 'Cluster variant',
    options: [
      {
        value: 'standard',
        label: 'Standard (DooD)',
        hint: 'Docker-outside-of-Docker — for apps that don\'t run containers',
      },
      {
        value: 'microservices',
        label: 'Microservices (DinD)',
        hint: 'Docker-in-Docker — each worker runs isolated container stacks',
      },
    ],
    initialValue: defaultVariant,
  });
  exitIfCancelled(variant);
  result.variant = variant as 'standard' | 'microservices';
}
```

Update `ExistingDefaults` interface to include `variant`:
```typescript
interface ExistingDefaults {
  // ... existing fields ...
  variant?: 'standard' | 'microservices';
}
```

Update `loadExistingConfigDefaults()` to read `config.cluster?.variant`.

**Files**: `packages/generacy/src/cli/commands/init/prompts.ts`

#### 4.5 Update context building in init action (`packages/generacy/src/cli/commands/init/index.ts`)

Replace the `isMultiRepo` branching with unified context building that includes variant:

```typescript
// ── 4. Build template context ──
const isMultiRepo = initOptions.devRepos.length > 0;

let context;
if (isMultiRepo) {
  context = buildMultiRepoContext({
    ...existingBuilderArgs,
    variant: initOptions.variant,
  });
} else {
  context = buildSingleRepoContext({
    ...existingBuilderArgs,
    variant: initOptions.variant,
  });
}
context = withGeneratedBy(context, 'generacy-cli');
```

The key change is passing `variant` through to the context builder so it appears in `context.cluster.variant` for template selection.

**Files**: `packages/generacy/src/cli/commands/init/index.ts`

#### 4.6 Add file permissions for shell scripts (`packages/generacy/src/cli/commands/init/writer.ts`)

After writing each file, check if it's a `.sh` file and set execute permissions:

```typescript
import { chmodSync } from 'node:fs';

// After writeFileSync(fullPath, content, 'utf-8'):
if (relativePath.endsWith('.sh')) {
  chmodSync(fullPath, 0o755);
}
```

**Files**: `packages/generacy/src/cli/commands/init/writer.ts`

#### 4.7 Update summary output (`packages/generacy/src/cli/commands/init/summary.ts`)

Show the selected variant in the summary. Update `printNextSteps()` to mention `.devcontainer/.env.template`:

```typescript
export function printNextSteps(): void {
  p.note(
    [
      '1. Review the generated files',
      '2. Copy .devcontainer/.env.template to .devcontainer/.env and fill in credentials',
      '3. Copy .generacy/generacy.env.template to .generacy/generacy.env and fill in credentials',
      '4. Run `generacy doctor` to verify system requirements',
      '5. Commit the generated files to your repository',
    ].join('\n'),
    'Next steps',
  );
}
```

**Files**: `packages/generacy/src/cli/commands/init/summary.ts`

---

### Phase 5: Config Schema & Migration Detection
**Goal**: Persist variant in config.yaml and detect old-format migrations

#### 5.1 Extend config schema (`packages/generacy/src/config/schema.ts`)

```typescript
export const ClusterConfigSchema = z.object({
  variant: z.enum(['standard', 'microservices']).default('standard'),
});

export const GeneracyConfigSchema = z.object({
  schemaVersion: z.string().default('1'),
  project: ProjectConfigSchema,
  repos: ReposConfigSchema,
  defaults: DefaultsConfigSchema.optional(),
  orchestrator: OrchestratorSettingsSchema.optional(),
  cluster: ClusterConfigSchema.optional(), // NEW
});
```

**Files**: `packages/generacy/src/config/schema.ts`

#### 5.2 Update shared config.yaml template

Update `shared/config.yaml.hbs` to include the `cluster` section:

```yaml
cluster:
  variant: {{cluster.variant}}
```

**Files**: `packages/templates/src/shared/config.yaml.hbs`

#### 5.3 Add migration detection (`packages/generacy/src/cli/commands/init/index.ts`)

Before conflict resolution, detect if existing `devcontainer.json` uses the old format (has `image` key instead of `dockerComposeFile`):

```typescript
// Between step 7 (check conflicts) and step 8 (resolve conflicts):
const devcontainerConflict = conflicts.get('.devcontainer/devcontainer.json');
if (devcontainerConflict) {
  try {
    const existing = JSON.parse(devcontainerConflict);
    if (existing.image && !existing.dockerComposeFile) {
      p.log.warn(
        'Existing .devcontainer/devcontainer.json uses the old image-based format.\n' +
        'Cluster templates use docker-compose. We recommend overwriting to adopt the new format.'
      );
    }
  } catch {
    // Not valid JSON — ignore
  }
}
```

**Files**: `packages/generacy/src/cli/commands/init/index.ts`

---

### Phase 6: Validator Updates
**Goal**: Update post-render validators for cluster template output

#### 6.1 Relax devcontainer.json validator (`packages/templates/src/validators.ts`)

The current validator requires the Generacy Dev Container Feature. Cluster templates don't use it (per Q9). Update `validateRenderedDevContainer()`:

```typescript
// Remove or make optional the Generacy feature check:
// Old: throw if no generacy-ai feature found
// New: only check if features section exists AND we're not using docker-compose
if (hasFeatures && !hasDockerCompose) {
  // Only validate feature presence for non-cluster (legacy) templates
  const hasGeneracyFeature = featureKeys.some(key => /generacy-ai\/.*\/generacy/.test(key));
  if (!hasGeneracyFeature) {
    throw new Error('...');
  }
}
```

#### 6.2 Add .env.template validation

Add a lightweight validator for generated `.env.template` files:

```typescript
export function validateRenderedEnvTemplate(content: string): void {
  // Check it's not empty
  if (!content.trim()) {
    throw new Error('.env.template is empty');
  }
  // Check for key required variables
  const requiredVars = ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY'];
  for (const varName of requiredVars) {
    if (!content.includes(varName)) {
      throw new Error(`.env.template missing required variable: ${varName}`);
    }
  }
}
```

Wire into `validateAllRenderedFiles()`:

```typescript
if (path.endsWith('.env.template') && path.includes('.devcontainer')) {
  validateRenderedEnvTemplate(content);
}
```

#### 6.3 Skip undefined variable check for static shell scripts

The `findUndefinedVariables()` regex matches `{{ }}` Handlebars syntax, not `${ }` bash syntax, so this should already work. However, verify that no shell scripts use `{{ }}` patterns. If any do, add an exclusion for `.sh` files in `validateAllRenderedFiles()`.

**Files**: `packages/templates/src/validators.ts`

---

### Phase 7: Testing
**Goal**: Comprehensive test coverage for all new functionality

#### 7.1 Unit tests for variant context building

**File**: `packages/templates/tests/unit/builders.test.ts` (extend existing)

- Test `buildSingleRepoContext()` with `variant: 'standard'`
- Test `buildSingleRepoContext()` with `variant: 'microservices'`
- Test `buildMultiRepoContext()` with both variants
- Test default variant is `'standard'` when not specified
- Test `withVariant()` modifier

#### 7.2 Unit tests for template selection

**File**: `packages/templates/tests/unit/renderer.test.ts` (extend existing)

- Test `selectTemplates()` returns cluster standard templates
- Test `selectTemplates()` returns cluster microservices templates (includes DinD script)
- Test `selectTemplates()` always includes shared templates
- Test old single-repo/multi-repo paths are NOT selected

#### 7.3 Integration tests for cluster rendering

**File**: `packages/templates/tests/integration/render-project.test.ts` (extend existing)

- Test `renderProject()` with standard variant generates all expected files
- Test `renderProject()` with microservices variant generates DinD files
- Test variable substitution in Dockerfile, docker-compose.yml, devcontainer.json, .env.template
- Test static scripts are copied verbatim
- Test `validateAllRenderedFiles()` passes on rendered cluster output

#### 7.4 Snapshot tests

**File**: `packages/templates/tests/integration/snapshots.test.ts` (extend existing)

- Add snapshot for standard variant full output
- Add snapshot for microservices variant full output

#### 7.5 CLI init command tests

**File**: `packages/generacy/src/cli/commands/init/__tests__/variant.test.ts` (new)

- Test `--variant standard` flag is extracted correctly
- Test `--variant microservices` flag is extracted correctly
- Test invalid variant produces error
- Test variant resolution priority: flag > config > prompt > default
- Test `--yes` with no config defaults to standard
- Test `--yes` with existing microservices config preserves microservices
- Test `--variant` flag overrides config value

#### 7.6 Test fixtures

**File**: `packages/templates/tests/fixtures/` (new fixtures)

- `standard-cluster-context.json`: Standard variant context
- `microservices-cluster-context.json`: Microservices variant context

---

### Phase 8: Cleanup & Documentation
**Goal**: Remove deprecated code paths and update documentation

#### 8.1 Deprecate old templates

Mark `single-repo/` and `multi-repo/` template directories as deprecated. They remain in the codebase but are no longer selected by `selectTemplates()`. Add a comment in each file noting they are deprecated and will be removed in a future version.

#### 8.2 Update template package README

Update any documentation in the templates package to reflect the new cluster variant system.

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Template selection mechanism | Extend `selectTemplates()` with variant routing | Follows existing pattern (Q10-A), single entry point |
| Single-repo/multi-repo fate | Full replacement by cluster templates | All projects get cluster setup; standard is the lightweight option (Q1-A) |
| Shell script rendering | Static (no Handlebars) | Avoids `${}` / `{{}}` conflicts, scripts use runtime env vars (Q8-A) |
| Base image | Hardcoded `typescript-node:22-bookworm` | Tested combination, users edit post-init if needed (Q6-A) |
| Dev Container Feature | Removed from cluster templates | Dockerfile handles CLI installation; Feature deprecated (Q9-A) |
| Env var naming | Official names with fallbacks | `GITHUB_TOKEN` + `ANTHROPIC_API_KEY` primary, `GH_TOKEN` + `CLAUDE_API_KEY` fallback (Q2-C) |
| Worker count / port | Runtime env vars | `${WORKER_COUNT:-3}` in docker-compose.yml; changeable via .env (Q12-A) |
| File permissions | `chmodSync(0o755)` in writer | Scripts work regardless of consumption context (Q3-A) |
| Variant resolution | Integrated into `resolveOptions()` | Same priority chain as other options; no separate step (Q4-A) |
| `--yes` re-init behavior | Config value wins, then default to standard | Prevents silent downgrade from microservices (Q5-C) |
| Migration detection | Warn if old-format devcontainer.json found | Respects user agency while communicating incompatibility (Q7-B) |
| Validation strategy | Undefined variable check on all files | Catches template rendering failures; full syntax validation is low-value (Q11-B) |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Breaking existing `generacy init` users | Conflict resolution flow handles file-by-file overwrite/skip; migration detection warns about format change |
| Handlebars syntax conflicts with bash `${}` in scripts | Shell scripts are static files (no Handlebars rendering); verified regex doesn't false-positive |
| Large template file count increases package size | Scripts are small (<5KB each); Handlebars templates compress well; total addition ~50KB |
| Cluster-templates repo content diverges from bundled version | Bundle at build time; version tested alongside CLI; future issue to add update mechanism |
| Validators reject cluster template output | Relax Generacy Feature requirement for docker-compose devcontainers; add .env.template validator |
| `findUndefinedVariables()` false positives on shell scripts | Static files skip Handlebars rendering; regex targets `{{ }}` not `${ }`; add `.sh` exclusion as safety |
| Test snapshot breakage | Update snapshots as part of Phase 7; CI enforces snapshot consistency |

## File Change Summary

### Modified files

| File | Changes |
|------|---------|
| `packages/templates/src/schema.ts` | Add `ClusterVariant`, `ClusterContext`, `ClusterContextSchema`; add `cluster` to `TemplateContext` |
| `packages/templates/src/builders.ts` | Accept `variant` in both builders; add `withVariant()` modifier; populate `cluster` context |
| `packages/templates/src/renderer.ts` | Rewrite `selectTemplates()` for variant-based cluster template routing |
| `packages/templates/src/validators.ts` | Relax devcontainer feature check; add `.env.template` validator; wire into `validateAllRenderedFiles()` |
| `packages/templates/src/index.ts` | Export new types, schemas, and `withVariant()` |
| `packages/templates/src/shared/config.yaml.hbs` | Add `cluster.variant` section |
| `packages/templates/package.json` | Add `src/cluster` to files field |
| `packages/generacy/src/cli/commands/init/types.ts` | Add `variant` to `InitOptions` |
| `packages/generacy/src/cli/commands/init/index.ts` | Add `--variant` flag; pass variant to context builder; add migration detection |
| `packages/generacy/src/cli/commands/init/resolver.ts` | Extract variant from flags; load from config; resolve with priority chain |
| `packages/generacy/src/cli/commands/init/prompts.ts` | Add variant selection prompt; update `ExistingDefaults` |
| `packages/generacy/src/cli/commands/init/writer.ts` | Add `chmodSync(0o755)` for `.sh` files |
| `packages/generacy/src/cli/commands/init/summary.ts` | Update next steps to mention `.devcontainer/.env.template` |
| `packages/generacy/src/config/schema.ts` | Add `ClusterConfigSchema` and `cluster` field to `GeneracyConfigSchema` |

### New files

| File | Purpose |
|------|---------|
| `packages/templates/src/cluster/standard/Dockerfile.hbs` | Standard variant Dockerfile template |
| `packages/templates/src/cluster/standard/docker-compose.yml.hbs` | Standard variant Compose template |
| `packages/templates/src/cluster/standard/devcontainer.json.hbs` | Standard variant devcontainer config |
| `packages/templates/src/cluster/standard/env.template.hbs` | Standard variant env template |
| `packages/templates/src/cluster/microservices/Dockerfile.hbs` | Microservices variant Dockerfile (+ Docker CE) |
| `packages/templates/src/cluster/microservices/docker-compose.yml.hbs` | Microservices variant Compose (+ DinD) |
| `packages/templates/src/cluster/microservices/devcontainer.json.hbs` | Microservices variant devcontainer config |
| `packages/templates/src/cluster/microservices/env.template.hbs` | Microservices variant env template |
| `packages/templates/src/cluster/shared/scripts/entrypoint-orchestrator.sh` | Orchestrator entrypoint script |
| `packages/templates/src/cluster/shared/scripts/entrypoint-worker.sh` | Worker entrypoint script |
| `packages/templates/src/cluster/shared/scripts/setup-credentials.sh` | Credential setup script |
| `packages/templates/src/cluster/shared/scripts/setup-docker-dind.sh` | DinD setup script (microservices only) |
| `packages/generacy/src/cli/commands/init/__tests__/variant.test.ts` | Variant selection and rendering tests |
| `packages/templates/tests/fixtures/standard-cluster-context.json` | Test fixture for standard variant |
| `packages/templates/tests/fixtures/microservices-cluster-context.json` | Test fixture for microservices variant |

## Implementation Order

1. **Phase 1** (Schema) — Foundation for everything else
2. **Phase 5.1** (Config schema) — Can be done in parallel with Phase 1
3. **Phase 2** (Template files) — Depends on Phase 1 for knowing context shape
4. **Phase 3** (Rendering) — Depends on Phase 1 + 2
5. **Phase 4** (CLI) — Depends on Phase 1 + 3
6. **Phase 5.2-5.3** (Config template + migration) — Depends on Phase 4
7. **Phase 6** (Validators) — Can be done in parallel with Phase 4-5
8. **Phase 7** (Testing) — After all implementation phases
9. **Phase 8** (Cleanup) — Final step
