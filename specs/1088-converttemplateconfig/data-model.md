# Data Model: 1088-converttemplateconfig

## Schema changes (`@generacy-ai/config`)

### `WorkspaceConfigSchema` — `packages/config/src/workspace-schema.ts`

```ts
// BEFORE
export const WorkspaceConfigSchema = z.object({
  org: z.string().min(1),
  branch: z.string().min(1).default('develop'),
  repos: z.array(WorkspaceRepoSchema).min(1),
});

// AFTER (FR-001a)
export const WorkspaceConfigSchema = z.object({
  org: z.string().min(1),
  branch: z.string().min(1).optional(),   // no default — absent means "no preference"
  repos: z.array(WorkspaceRepoSchema).min(1),
});
```

Inferred type change: `WorkspaceConfig.branch: string` → `branch?: string | undefined`.

**Validation rules**: when present, `branch` must be a non-empty string (`.min(1)` — empty string still rejected). When absent, the parsed object has `branch: undefined`.

### `TemplateConfigSchema` — `packages/config/src/template-schema.ts`

```ts
// AFTER (FR-002, Q3=A — top-level key mirroring the workspace format)
export const TemplateConfigSchema = z.object({
  project: z.object({ org_name: z.string().optional() }).passthrough().optional(),
  branch: z.string().min(1).optional(),   // NEW
  repos: TemplateReposSchema,
  orchestrator: OrchestratorSettingsSchema.optional(),
});
```

**Validation rules**: identical to workspace format — optional, non-empty when present.

### `convertTemplateConfig` — `packages/config/src/convert-template.ts`

```ts
// BEFORE
return { org: primary.owner, branch: 'develop', repos };

// AFTER (FR-001)
return { org: primary.owner, branch: template.branch, repos };
```

`template.branch` is `string | undefined`; the literal is gone (SC-004). No other logic changes.

## CLI-side types (`packages/generacy/src/cli/commands/setup/workspace.ts`)

### Local `WorkspaceConfig` interface (resolved runtime config, distinct from the schema type)

```ts
// BEFORE
interface WorkspaceConfig {
  repos: string[];
  branch: string;
  workdir: string;
  clean: boolean;
  githubOrg: string;
  repoSource: 'CLI flag' | 'REPOS env var' | 'config file';
}

// AFTER
type BranchSource = 'CLI flag' | 'REPO_BRANCH env' | 'DEFAULT_BRANCH env' | 'config file' | 'none';

interface WorkspaceConfig {
  repos: string[];
  branch: string | undefined;   // undefined ⇒ no preference (FR-003/FR-004)
  branchSource: BranchSource;   // NEW — FR-006 observability
  workdir: string;
  clean: boolean;
  githubOrg: string;
  repoSource: 'CLI flag' | 'REPOS env var' | 'config file';
}
```

### Branch resolution invariants

| Invariant | Statement |
|-----------|-----------|
| I1 | `branch !== undefined` ⇔ `branchSource !== 'none'` |
| I2 | `branchSource` names the highest-precedence tier that supplied a defined value: flag > `REPO_BRANCH` > `DEFAULT_BRANCH` > config (FR-005) |
| I3 | No code path assigns `'develop'` (or any literal) to `branch` (SC-004) |
| I4 | `branch === undefined` ⇒ `cloneOrUpdateRepo` performs zero branch mutations on existing checkouts (FR-003) |

## Relationships

```text
.generacy/config.yaml (template format)          .generacy/config.yaml (workspace format)
  branch?: string  ──┐                              workspace.branch?: string ──┐
                     │ TemplateConfigSchema.parse                               │ WorkspaceConfigSchema.parse
                     ▼                                                          ▼
            convertTemplateConfig ────────────────────────────► WorkspaceConfig.branch?: string
                                                                        │
                                                                        │ tryLoadWorkspaceConfig → configBranch
                                                                        ▼
        cliArgs.branch ?? REPO_BRANCH ?? DEFAULT_BRANCH ?? configBranch   (no final literal)
                                                                        │
                                                                        ▼
                                              local WorkspaceConfig { branch, branchSource }
                                                                        │
                                                                        ▼
                                              cloneOrUpdateRepo (see contracts/branch-resolution.md)
```

## Unaffected consumers (audited)

`WorkspaceConfig` is consumed by `packages/config/src/repos.ts` (`getRepoNames`, `resolveSiblingWorkdirs` — repos/org only), orchestrator (`claude-cli-worker.ts` — sibling workdirs only), cockpit (`findWorkspaceConfigPath` only), and `packages/generacy/src/config/schema.ts` (`GeneracyConfigSchema.workspace` — embedded schema; no runtime `.branch` reads). None read `branch`; the optionality change is type-compatible for all of them.
