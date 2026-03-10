# Data Model: Workspace Config Schema Extension

## Overview

Extends the existing `GeneracyConfig` schema (`.generacy/config.yaml`) with a new `workspace` section that becomes the single source of truth for repos to clone and monitor.

## Schema Changes

### New: `WorkspaceRepoSchema`

```typescript
const WorkspaceRepoSchema = z.object({
  /** Repo name (bare, e.g. "generacy") */
  name: z.string().min(1),
  /** Whether the orchestrator monitors this repo for label events */
  monitor: z.boolean().default(true),
});
```

### New: `WorkspaceConfigSchema`

```typescript
const WorkspaceConfigSchema = z.object({
  /** GitHub org/owner for all repos in this workspace */
  org: z.string().min(1),
  /** Default branch to clone/track */
  branch: z.string().min(1).default('develop'),
  /** List of repos in this workspace */
  repos: z.array(WorkspaceRepoSchema).min(1),
});
```

### Updated: `GeneracyConfigSchema`

The `workspace` field is added as **optional** to the root schema:

```typescript
const GeneracyConfigSchema = z.object({
  schemaVersion: z.string().default('1'),
  project: ProjectConfigSchema,
  repos: ReposConfigSchema,
  defaults: DefaultsConfigSchema.optional(),
  orchestrator: OrchestratorSettingsSchema.optional(),
  cluster: ClusterConfigSchema.optional(),
  workspace: WorkspaceConfigSchema.optional(),  // NEW
});
```

## Example Config File

```yaml
# .generacy/config.yaml in tetrad-development
schemaVersion: "1"

project:
  id: proj_generacy001
  name: Generacy

repos:
  primary: github.com/generacy-ai/tetrad-development
  dev:
    - github.com/generacy-ai/generacy
    - github.com/generacy-ai/agency
  clone: []

workspace:
  org: generacy-ai
  branch: develop
  repos:
    - name: tetrad-development
      monitor: true
    - name: cluster-templates
      monitor: true
    - name: latency
      monitor: true
    - name: agency
      monitor: true
    - name: generacy
      monitor: true
    - name: humancy
      monitor: true
    - name: generacy-cloud
      monitor: true
    - name: humancy-cloud
      monitor: true
```

## Derived Types

### `RepoInfo` (shared helper output)

```typescript
interface RepoInfo {
  /** GitHub org/owner */
  owner: string;
  /** Repo name */
  repo: string;
  /** Whether to monitor for label events */
  monitor: boolean;
}
```

### Helper Functions Return Types

| Function | Returns | Description |
|----------|---------|-------------|
| `getWorkspaceRepos(config)` | `RepoInfo[]` | All repos from `workspace.repos` |
| `getMonitoredRepos(config)` | `{ owner: string; repo: string }[]` | Only repos with `monitor: true` |
| `getRepoWorkdir(config, owner, repo, basePath?)` | `string` | `/workspaces/{repoName}` path |
| `getWorkspaceOrg(config)` | `string` | `workspace.org` value |
| `getWorkspaceBranch(config)` | `string` | `workspace.branch` value |

## Override Resolution

Override priority is consistent across all fields:

```
CLI flags > Environment variables > Config file > Built-in defaults
```

| Field | CLI Flag | Env Var | Config Path | Default |
|-------|----------|---------|-------------|---------|
| Repos | `--repos` | `REPOS` | `workspace.repos` | (none) |
| Monitored repos | `--monitored-repos` | `MONITORED_REPOS` | `workspace.repos[].monitor` | (none) |
| Org | (none) | `GITHUB_ORG` | `workspace.org` | `generacy-ai` |
| Branch | `--branch` | `REPO_BRANCH` / `DEFAULT_BRANCH` | `workspace.branch` | `develop` |
| Workdir base | `--workdir` | (none) | (none) | `/workspaces` |
