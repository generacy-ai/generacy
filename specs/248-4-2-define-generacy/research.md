# Research and Technical Decisions

**Feature:** 4.2 — Define .generacy/config.yaml schema
**Date:** 2026-02-24

## Purpose

This document captures the research, alternatives considered, and technical decisions made during the design of the `.generacy/config.yaml` schema. It serves as a reference for understanding why specific approaches were chosen and what trade-offs were considered.

---

## 1. Schema Validation Library Selection

### Options Evaluated

#### Option A: Zod (Selected)

**Pros:**
- Already in use by orchestrator package (zero new dependencies)
- Excellent TypeScript type inference (DRY: schemas generate types)
- Composable schemas enable reuse
- Runtime validation + static types in one definition
- Clear, actionable error messages with path information
- Active development and strong community support
- Built-in support for defaults, transforms, refinements

**Cons:**
- Runtime overhead (minimal for config validation use case)
- Learning curve for team members unfamiliar with Zod

**Example:**
```typescript
import { z } from 'zod';

const ConfigSchema = z.object({
  project: z.object({
    id: z.string().regex(/^proj_[a-z0-9]+$/),
    name: z.string().min(1).max(255)
  })
});

type Config = z.infer<typeof ConfigSchema>; // Types auto-generated
```

#### Option B: JSON Schema + Ajv

**Pros:**
- Industry standard (OpenAPI, JSON RPC use it)
- Language-agnostic (schema can be shared with non-TS consumers)
- Excellent tooling (VS Code autocomplete, schema stores)

**Cons:**
- Requires separate TypeScript type definitions (duplication)
- More verbose schema definitions
- Error messages less developer-friendly
- Two sources of truth (schema + types)

**Example:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "project": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^proj_[a-z0-9]+$"
        }
      }
    }
  }
}
```

Then separately:
```typescript
interface Config {
  project: {
    id: string;
  };
}
```

#### Option C: Manual Validation

**Pros:**
- No dependencies
- Full control over error messages
- Easy to understand for all developers

**Cons:**
- Error-prone (easy to miss edge cases)
- Verbose and repetitive code
- No type inference (manual type definitions required)
- Harder to maintain as schema evolves

**Example:**
```typescript
function validateConfig(obj: any): Config {
  if (!obj.project) throw new Error('Missing project');
  if (typeof obj.project.id !== 'string') throw new Error('Invalid project.id');
  if (!/^proj_[a-z0-9]+$/.test(obj.project.id)) throw new Error('Invalid project ID format');
  // ... dozens more checks
  return obj as Config;
}
```

### Decision

**Selected: Zod (Option A)**

**Rationale:**
1. **Zero new dependencies**: Already used in `packages/orchestrator/src/config/schema.ts`
2. **Type safety**: Single source of truth for schemas and types
3. **Developer experience**: Clear error messages, easy to extend
4. **Consistency**: Matches existing codebase patterns

**Impact:**
- Config validation code is concise and type-safe
- Easy to add new fields or refinements
- Team already familiar with Zod from orchestrator work

---

## 2. Repository URL Format

### Options Evaluated

#### Option A: Protocol-agnostic format (Selected)

**Format:** `github.com/owner/repo`

**Pros:**
- Clean, matches GitHub's web URLs
- Protocol (HTTPS/SSH) determined at clone time based on available auth
- Works in both dev (SSH keys) and production (GitHub App tokens)
- No `.git` suffix to confuse users

**Cons:**
- Clone operations must add protocol
- May be unfamiliar to users expecting `git@github.com:` or `https://`

**Example:**
```yaml
repos:
  primary: "github.com/generacy-ai/generacy"
  dev:
    - "github.com/generacy-ai/agency"
```

Clone implementation:
```typescript
function cloneRepo(repoUrl: string, authMethod: 'ssh' | 'https') {
  const fullUrl = authMethod === 'ssh'
    ? `git@${repoUrl.replace('/', ':')}.git`
    : `https://${repoUrl}.git`;

  return exec(`git clone ${fullUrl}`);
}
```

#### Option B: Full Git URLs

**Format:** `https://github.com/owner/repo.git` or `git@github.com:owner/repo.git`

**Pros:**
- Familiar to Git users
- Can be copy-pasted from GitHub UI
- Explicit about protocol

**Cons:**
- Forces choice of HTTPS vs SSH at config time
- Doesn't match how auth is actually handled (runtime decision)
- Config becomes environment-specific (dev uses SSH, prod uses HTTPS)
- Longer, noisier syntax

**Example:**
```yaml
repos:
  primary: "https://github.com/generacy-ai/generacy.git"
  dev:
    - "git@github.com:generacy-ai/agency.git"  # Different protocol!
```

#### Option C: Short format with platform prefix

**Format:** `github:owner/repo` or `gh:owner/repo`

**Pros:**
- Very concise
- Platform-agnostic (could support GitLab: `gitlab:owner/repo`)

**Cons:**
- Non-standard format (not used by any existing tools)
- Less clear than full domain
- Requires parser to handle multiple platforms

### Decision

**Selected: Protocol-agnostic format (Option A)**

**Rationale:**
1. **Auth separation**: Authentication is handled at runtime (Q2 clarification)
2. **Flexibility**: Same config works in dev (SSH) and prod (HTTPS with tokens)
3. **Clarity**: Matches GitHub's web URL format (recognizable)
4. **Simplicity**: No `.git` suffix confusion

**Supporting Evidence from Clarifications:**
- Q2: "Authentication is handled externally, config only stores repo identifiers"
- Q13: "Format validation only, no accessibility checks"

**Impact:**
- Orchestrator and dev container setup must add protocol based on available auth
- Config examples are clean and environment-agnostic
- Works seamlessly with both SSH keys and GitHub App tokens

---

## 3. Config Discovery Strategy

### Options Evaluated

#### Option A: Walk up directory tree (Selected)

**Algorithm:**
1. Start in current working directory
2. Look for `.generacy/config.yaml`
3. If not found, go to parent directory
4. Repeat until found or hit repository root (`.git/`)
5. Fail if not found

**Pros:**
- Works from any subdirectory in the project
- Matches Git's behavior (find `.git/` by walking up)
- Natural for monorepo packages
- Standard pattern used by many tools (ESLint, Prettier, etc.)

**Cons:**
- Potentially slow for deeply nested directories
- Could find config in unexpected parent if not careful

**Example:**
```
/workspace/my-project/
  .git/
  .generacy/
    config.yaml  ← Found from any subdirectory
  packages/
    frontend/
      src/
        components/  ← Run from here, walks up to find config
```

#### Option B: Fixed location only

**Algorithm:**
1. Check `.generacy/config.yaml` in CWD
2. If not found, fail immediately

**Pros:**
- Fastest (no directory walking)
- Predictable behavior

**Cons:**
- Must always run CLI from repository root
- Poor developer experience in monorepos
- Breaks if CWD changes

#### Option C: Multiple search paths

**Algorithm:**
1. Check `.generacy/config.yaml`
2. Check `config/.generacy.yaml`
3. Check `.generacy.yaml`
4. Check `~/.generacy/config.yaml`

**Pros:**
- Flexible configuration locations
- Supports global defaults

**Cons:**
- Confusing: which config takes precedence?
- Multiple locations means users don't know where to look
- Global config not needed (project-specific only)

### Decision

**Selected: Walk up directory tree (Option A)**

**Rationale:**
1. **Developer experience**: Works from any subdirectory
2. **Consistency**: Matches Git's discovery pattern
3. **Monorepo support**: Natural behavior for nested packages (Q8 clarification)
4. **Standard**: Used by ESLint, Prettier, TypeScript, and other tools

**Safeguards:**
- Stop at repository root (`.git/` directory)
- `GENERACY_CONFIG_PATH` env var for explicit override
- Clear error message showing search path if not found

**Impact:**
- CLI can be run from anywhere in the project
- Monorepo packages automatically find root config
- Discovery behavior is predictable and familiar

---

## 4. Schema Versioning Strategy

### Options Evaluated

#### Option A: Optional version field (Selected)

**Approach:**
```yaml
schemaVersion: "1"  # Optional, defaults to "1" if omitted
project:
  id: "proj_abc"
```

**Pros:**
- Future-proof: v2 migration path is clear
- Backward compatible: v1 configs work without version field
- Zero cost today: generated configs include it, manual configs don't need it
- Clear intent when present

**Cons:**
- Slightly verbose in generated configs
- Could be forgotten in manual configs (mitigated by default)

#### Option B: No version field

**Approach:**
```yaml
# No version field, implicitly v1
project:
  id: "proj_abc"
```

**Pros:**
- Simpler configs today
- Less to explain to users

**Cons:**
- V2 migration requires heuristics or breaking change
- No clear signal of intent
- Harder to support multiple versions simultaneously

#### Option C: Required version field

**Approach:**
```yaml
schemaVersion: "1"  # REQUIRED
project:
  id: "proj_abc"
```

**Pros:**
- Explicit versioning from day 1
- No ambiguity

**Cons:**
- Verbose for simple use case
- Breaking change if we add it later
- Users must remember to include it

### Decision

**Selected: Optional version field (Option A)**

**Rationale:**
1. **Future-proofing**: Q12 clarification confirmed this approach
2. **Backward compatibility**: Existing configs work without it
3. **Best of both worlds**: Generated configs include it, manual configs optional
4. **Migration path**: v2 can detect version and handle accordingly

**Implementation:**
```typescript
const GeneracyConfigSchema = z.object({
  schemaVersion: z.string().optional().default("1"),
  // ... rest of schema
});
```

**Migration Example (Future v2):**
```typescript
export function loadConfig(): GeneracyConfig {
  const raw = parseYaml(readFileSync(configPath));
  const version = raw.schemaVersion || "1";

  switch (version) {
    case "1":
      return GeneracyConfigSchemaV1.parse(raw);
    case "2":
      return GeneracyConfigSchemaV2.parse(raw);
    default:
      throw new Error(`Unsupported schema version: ${version}`);
  }
}
```

**Impact:**
- All generated configs (onboarding PR, `generacy init`) include `schemaVersion: "1"`
- Manual configs work without it (defaults to "1")
- Clear upgrade path when v2 arrives

---

## 5. Validation Depth Decision

### Options Evaluated

#### Option A: Format-only validation (Selected)

**Validates:**
- Field types (string, number, array)
- Format patterns (project ID, agent name, repo URLs)
- Value ranges (poll interval, worker count)
- Required fields present

**Does NOT validate:**
- Repository accessibility (network check)
- Branch existence (git check)
- Agent availability (registry lookup)

**Pros:**
- Fast (no network or git operations)
- Works offline
- Config can be created before resources exist
- Clear separation: format vs. existence

**Cons:**
- Runtime errors possible (repo not accessible, branch missing)
- Users may not catch errors until deployment

#### Option B: Full validation

**Validates:**
- Everything from Option A
- Repository accessibility (GitHub API check)
- Branch existence (git ls-remote)
- Agent registration (lookup in generacy.ai)

**Pros:**
- Catch errors early
- Better validation coverage

**Cons:**
- Slow (network calls required)
- Requires authentication to validate
- Doesn't work offline
- Config creation blocked by resources not existing yet

#### Option C: Lazy validation

**Validates:**
- Format validation at config load
- Existence validation on first use (clone, PR creation, etc.)

**Pros:**
- Balance between early and late validation

**Cons:**
- Complexity: two validation layers
- Unclear when errors will surface

### Decision

**Selected: Format-only validation (Option A)**

**Rationale:**
1. **Offline support**: Config validation must work without network (Q13)
2. **Resource timing**: Config may be created before branches exist (Q5)
3. **Auth separation**: Repository accessibility depends on runtime credentials (Q2)
4. **Performance**: Config loading should be fast and predictable

**Supporting Evidence from Clarifications:**
- Q5: "No validation. Accept any branch name string."
- Q13: "Format only. Only validate URL format at config load time."
- Q2: "Out of scope. Auth is handled at runtime."

**Runtime Validation Strategy:**
```typescript
// Config load time (fast, no network)
const config = loadConfig();
// ✅ Format validated, types checked

// Clone time (runtime errors possible)
try {
  await cloneRepo(config.repos.primary);
} catch (error) {
  // Handle: repo not accessible, auth failed, etc.
}

// PR creation time (runtime errors possible)
try {
  await createPR({ base: config.defaults.baseBranch });
} catch (error) {
  // Handle: branch doesn't exist, etc.
}
```

**Impact:**
- Config loading is fast and offline-capable
- Runtime errors have context (operation that failed)
- Config can be committed before all resources exist

---

## 6. Repository Deduplication Enforcement

### Options Evaluated

#### Option A: Strict validation (Selected)

**Behavior:** Reject config if same repo appears in multiple lists

**Error:**
```
Validation error: Repository appears in multiple lists: github.com/acme/shared
A repository cannot be in both 'dev' and 'clone' lists.
```

**Pros:**
- Clear semantics: dev vs clone are mutually exclusive
- Prevents ambiguous workspace setup
- Forces explicit choice about repo role

**Cons:**
- Could be seen as overly strict
- Requires user to decide on role

#### Option B: Allow duplicates, apply precedence

**Behavior:** Allow duplicates, `dev` takes precedence over `clone`

**Pros:**
- More permissive
- Users can override without error

**Cons:**
- Confusing: which role applies?
- Hidden behavior (precedence rules)
- Likely indicates user mistake

#### Option C: Warning only

**Behavior:** Warn but allow duplicates

**Pros:**
- Most permissive
- Users can proceed if intentional

**Cons:**
- Warnings often ignored
- Unclear workspace setup
- Likely indicates configuration error

### Decision

**Selected: Strict validation (Option A)**

**Rationale:**
1. **Semantic clarity**: Q6 clarification states "Forbid duplicates"
2. **Prevent errors**: Dev vs clone are contradictory roles
3. **Explicit intent**: Forces user to choose correct classification
4. **Better DX**: Clear error better than hidden behavior

**Implementation:**
```typescript
export function validateNoDuplicateRepos(config: GeneracyConfig): void {
  const allRepos = [
    config.repos.primary,
    ...(config.repos.dev || []),
    ...(config.repos.clone || [])
  ];

  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const repo of allRepos) {
    if (seen.has(repo)) {
      duplicates.push(repo);
    }
    seen.add(repo);
  }

  if (duplicates.length > 0) {
    throw new Error(
      `Repository appears in multiple lists: ${duplicates.join(', ')}\n` +
      `A repository cannot be in both 'dev' and 'clone' lists.`
    );
  }
}
```

**Impact:**
- Clear distinction between development and reference repos
- Workspace setup is unambiguous
- Errors caught at config validation time, not runtime

---

## 7. Environment Variable Override Strategy

### Options Evaluated

#### Option A: Config path only (Selected)

**Environment variables:**
- `GENERACY_CONFIG_PATH`: Override config file location

**No overrides for:**
- Project ID
- Repository lists
- Defaults
- Orchestrator settings

**Pros:**
- Simple mental model
- Config file is single source of truth
- Clear which settings apply

**Cons:**
- Can't override settings without modifying config file

#### Option B: Full environment override

**Environment variables:**
- `GENERACY_PROJECT_ID`
- `GENERACY_PROJECT_NAME`
- `GENERACY_REPOS_PRIMARY`
- `GENERACY_DEFAULT_AGENT`
- `GENERACY_ORCHESTRATOR_POLL_INTERVAL_MS`
- etc.

**Pros:**
- Maximum flexibility
- Can override any setting

**Cons:**
- Complex precedence rules
- Hard to debug which setting applies
- Config file no longer source of truth

#### Option C: Hybrid (orchestrator settings only)

**Environment variables:**
- `GENERACY_CONFIG_PATH`: Config file location
- `ORCHESTRATOR_*`: Orchestrator settings only

**Pros:**
- Supports production overrides for orchestrator
- Config file still source of truth for project metadata

**Cons:**
- Inconsistent (some fields overridable, others not)

### Decision

**Selected: Config path only (Option A) for generacy config**

**Rationale:**
1. **Separation of concerns**: Q10 clarification distinguishes generacy config from orchestrator config
2. **Generacy config**: Project metadata, loaded from YAML only
3. **Orchestrator config**: Runtime settings, supports env var overrides
4. **Simplicity**: One source of truth for project configuration

**Clarification from Q10:**
> The orchestrator already reads config from YAML with env var overrides. The `.generacy/config.yaml` provides sensible development defaults; production deployments override via environment variables (`ORCHESTRATOR_*` prefix).

**Architecture:**
```
.generacy/config.yaml
├── Project metadata (no env overrides)
│   ├── project.id
│   ├── project.name
│   └── repos.*
├── Workflow defaults (no env overrides)
│   ├── defaults.agent
│   └── defaults.baseBranch
└── Orchestrator settings (env var overrides in orchestrator package)
    ├── orchestrator.pollIntervalMs → ORCHESTRATOR_POLL_INTERVAL_MS
    └── orchestrator.workerCount → ORCHESTRATOR_MAX_CONCURRENT_WORKERS
```

**Impact:**
- Generacy config is simple: one YAML file
- Orchestrator package handles env var overrides for its own settings
- Clear ownership: generacy owns metadata, orchestrator owns runtime settings

---

## 8. Monorepo Configuration Model

### Options Evaluated

#### Option A: Single root config (Selected)

**Structure:**
```
/monorepo-root/
  .generacy/
    config.yaml  ← One config for entire monorepo
  packages/
    frontend/
    backend/
    shared/
```

**Pros:**
- Simple: one config to maintain
- Config represents project, not package
- Clear ownership
- Matches onboarding PR behavior

**Cons:**
- Can't customize per-package
- All packages share same workflow defaults

#### Option B: Per-package configs

**Structure:**
```
/monorepo-root/
  .generacy/
    config.yaml  ← Root config
  packages/
    frontend/
      .generacy/
        config.yaml  ← Frontend-specific
    backend/
      .generacy/
        config.yaml  ← Backend-specific
```

**Pros:**
- Per-package customization
- Independent workflows

**Cons:**
- Which config applies when?
- Complex discovery logic
- Confusing for users
- Multiple project IDs?

#### Option C: Hierarchical merge

**Behavior:** Root config + package overrides merged

**Pros:**
- Shared defaults + package-specific overrides

**Cons:**
- Complex merge semantics
- Hard to debug which setting applies
- Over-engineered for Phase 1

### Decision

**Selected: Single root config (Option A)**

**Rationale:**
1. **Q8 clarification**: "Single root config. The config represents a *project*, not a package."
2. **Simplicity**: One config, one project
3. **Onboarding alignment**: PR creates `.generacy/` at repo root
4. **Phase 1 scope**: Keep it simple, can extend later if needed

**Impact:**
- Monorepos have one Generacy project
- All packages share workflow defaults
- Discovery logic is simple (walk up, stop at `.git/`)

---

## 9. Agent Name Validation Approach

### Options Evaluated

#### Option A: Format-only validation (Selected)

**Rule:** Kebab-case format: `/^[a-z0-9]+(-[a-z0-9]+)*$/`

**Pros:**
- Allows custom agents without schema changes
- Simple validation rule
- Clear error messages

**Cons:**
- Typos not caught (e.g., `claude-cde` instead of `claude-code`)

**Example:**
```yaml
defaults:
  agent: claude-code       # ✅ Valid
  agent: claude-opus       # ✅ Valid
  agent: custom-agent-v2   # ✅ Valid
  agent: my_agent          # ❌ Invalid (underscore)
  agent: MyAgent           # ❌ Invalid (uppercase)
```

#### Option B: Registry-based validation

**Rule:** Agent must exist in known registry

**Pros:**
- Catches typos
- Clear list of valid agents

**Cons:**
- Requires central registry
- Schema updates needed for new agents
- Custom agents blocked
- Network call to validate

#### Option C: No validation

**Rule:** Accept any non-empty string

**Pros:**
- Maximum flexibility

**Cons:**
- No format guidance
- Could allow confusing names

### Decision

**Selected: Format-only validation (Option A)**

**Rationale:**
1. **Q4 clarification**: "Format-only validation: Any kebab-case string"
2. **Extensibility**: Custom agents can be added without config schema changes
3. **Pragmatic**: Prevents obviously invalid names, allows innovation
4. **No registry needed**: Simpler architecture

**Pattern:**
```typescript
const AGENT_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const DefaultsConfigSchema = z.object({
  agent: z.string()
    .regex(
      AGENT_NAME_REGEX,
      "Agent name must be kebab-case (lowercase alphanumeric with hyphens)"
    )
    .optional()
    .default("claude-code")
});
```

**Impact:**
- Built-in agents: `claude-code`, `claude-opus`, `claude-sonnet`, `claude-haiku`
- Custom agents: any kebab-case string (e.g., `gpt-4-turbo`, `custom-v1`)
- Format enforced, but no registry lookup

---

## Existing Codebase Patterns

### Orchestrator Config Pattern

**Location:** `packages/orchestrator/src/config/`

**Key Files:**
- `schema.ts`: Zod schemas for all config sections
- `loader.ts`: Config file discovery, YAML parsing, env var overrides
- `index.ts`: Public exports

**Pattern Used:**
```typescript
// schema.ts
export const ServerConfigSchema = z.object({
  port: z.number().int().min(0).max(65535).default(3000),
  host: z.string().default('0.0.0.0'),
});

// loader.ts
export function loadConfig(options: LoadConfigOptions = {}): OrchestratorConfig {
  const fileConfig = loadFromFile(configPath);
  const envConfig = loadFromEnv();
  const merged = deepMerge(fileConfig, envConfig); // env overrides file
  return validateConfig(merged);
}
```

**Lessons Applied:**
1. Use Zod for schema validation (proven pattern)
2. Separate schema, loader, and exports
3. Support both file and env var sources
4. Deep merge for precedence (env > file > defaults)
5. Comprehensive test coverage

### Repository Config Pattern

**Location:** `packages/orchestrator/src/config/schema.ts:107-113`

**Existing Schema:**
```typescript
export const RepositoryConfigSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});
```

**Notes:**
- Stores `owner`/`repo` separately (not full URL)
- No credentials in config (Q2 pattern)
- Minimal validation (format only, no accessibility check)

**Alignment:**
- Generacy config uses full URL format for clarity
- Same principle: no auth/credentials in config
- Format-only validation matches existing pattern

---

## Summary of Research Impact

| Decision | Impact on Implementation | Supporting Evidence |
|----------|-------------------------|-------------------|
| Zod validation | Use existing dependency, type-safe schemas | Orchestrator precedent |
| Protocol-agnostic URLs | Clean config, runtime auth flexibility | Q2, Q13 clarifications |
| Directory tree walking | Works from any subdirectory | Standard tool behavior |
| Optional schema version | Future-proof, backward compatible | Q12 clarification |
| Format-only validation | Fast, offline-capable | Q5, Q13 clarifications |
| Strict deduplication | Clear semantics, prevent errors | Q6 clarification |
| Config path env var only | Simple, clear source of truth | Q10 clarification |
| Single root config | Simple discovery, clear ownership | Q8 clarification |
| Kebab-case agent names | Extensible, no registry needed | Q4 clarification |

---

## Future Considerations

### Schema v2 Planning

When migrating to v2 (future):

1. **Version Detection:**
   ```typescript
   const version = rawConfig.schemaVersion || "1";
   ```

2. **Multiple Parser Support:**
   ```typescript
   switch (version) {
     case "1": return parseV1(rawConfig);
     case "2": return parseV2(rawConfig);
   }
   ```

3. **Migration Command:**
   ```bash
   generacy config migrate
   ```

### Potential v2 Features

- GitLab support: `repos.primary: "gitlab.com/owner/repo"`
- Per-repo clone options: `depth: 1`, `sparse: true`
- Workflow-specific defaults: `workflows.*.agent`
- Custom orchestrator backends: `orchestrator.backend: "self-hosted"`

---

## References

- [Implementation Plan](./plan.md)
- [Data Model](./data-model.md)
- [Clarifications Q1-Q15](./clarifications.md)
- Orchestrator Config: `/workspaces/generacy/packages/orchestrator/src/config/`
- Zod Documentation: https://zod.dev/
- YAML Specification: https://yaml.org/spec/1.2.2/
