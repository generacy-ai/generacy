# Research: generacy init Command

**Date**: 2026-02-27

## Key Integration Points

### Templates Package API (`@generacy-ai/templates`)

The init command orchestrates the templates package. Key functions:

| Function | Signature | Purpose |
|----------|-----------|---------|
| `buildSingleRepoContext` | `(options: SingleRepoInput) => TemplateContext` | Build context for single-repo projects |
| `buildMultiRepoContext` | `(options: MultiRepoInput) => TemplateContext` | Build context for multi-repo projects |
| `renderProject` | `(context: TemplateContext, existingFiles?: Map<string, string>) => Promise<RenderedFileMap>` | Render all templates |
| `validateAllRenderedFiles` | `(files: Map<string, string>) => void` | Validate rendered output |

### Input Types

```typescript
interface SingleRepoInput {
  projectId: string;
  projectName: string;
  primaryRepo: string;           // "owner/repo" format
  baseImage?: string;            // default: 'mcr.microsoft.com/devcontainers/base:ubuntu'
  releaseStream?: 'stable' | 'preview';  // default: 'stable'
  baseBranch?: string;           // default: 'main'
}

interface MultiRepoInput {
  projectId: string;
  projectName: string;
  primaryRepo: string;           // "owner/repo" format
  devRepos: string[];            // at least 1
  cloneRepos?: string[];
  baseImage?: string;
  releaseStream?: 'stable' | 'preview';
  baseBranch?: string;
  workerCount?: number;          // 1-20, default: 2
  pollIntervalMs?: number;       // min 5000, default: 5000
}
```

### Format Gap: Config Schema vs Templates Schema

| Field | Config Schema (`config.yaml`) | Templates Schema (builders) |
|-------|-------------------------------|----------------------------|
| Repo format | `github.com/owner/repo` (validated by `^github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$`) | `owner/repo` (validated by `^[\w.-]+\/[\w.-]+$`) |
| Project ID | `^proj_[a-z0-9]+$` min 12 chars | `string.min(1)` |

The CLI must normalize repos to both formats:
- `owner/repo` when calling template builders
- `github.com/owner/repo` for config validation

### Existing CLI Patterns

**Command registration** (`src/cli/index.ts`):
```typescript
export function initCommand(): Command { ... }
// Then: program.addCommand(initCommand());
```

**Exec utilities** (`src/cli/utils/exec.ts`):
- `exec(cmd)` — synchronous, throws on error
- `execSafe(cmd)` — non-throwing, returns `{ ok, stdout, stderr }`

**Logger** (`src/cli/utils/logger.ts`):
- `getLogger()` — global Pino logger singleton

**Config loader** (`src/config/loader.ts`):
- `loadConfig(options?)` — loads and validates `.generacy/config.yaml`
- `findConfigFile(startDir?)` — discovers config file

## Prompt Library: @clack/prompts

Per Q1 clarification, `@clack/prompts` is the chosen library.

**Key API surface**:
```typescript
import * as p from '@clack/prompts';

p.intro('Welcome message');
p.outro('Done!');

const name = await p.text({ message: 'Project name?', placeholder: 'my-app', validate: (v) => ... });
const repo = await p.text({ message: 'Primary repo?', initialValue: 'owner/repo' });
const agent = await p.select({ message: 'Default agent?', options: [...] });
const confirm = await p.confirm({ message: 'Overwrite file?' });

const s = p.spinner();
s.start('Rendering templates...');
s.stop('Templates rendered');

// Group prompts
const result = await p.group({
  name: () => p.text({ message: '...' }),
  repo: () => p.text({ message: '...' }),
}, { onCancel: () => process.exit(130) });
```

**Installation**: `pnpm add @clack/prompts` + `pnpm add -D @clack/core` (types)

## Repo URL Normalization

Per Q4, the CLI accepts multiple formats and normalizes. Supported inputs:
- `owner/repo`
- `github.com/owner/repo`
- `https://github.com/owner/repo`
- `https://github.com/owner/repo.git`
- `git@github.com:owner/repo.git`

Normalization targets:
- For templates: `owner/repo`
- For config: `github.com/owner/repo`

## GitHub Credential Discovery (Q5)

Priority order:
1. `GITHUB_TOKEN` environment variable
2. `gh auth token` via `execSafe()`

## Project ID Generation (Q2)

When no `--project-id` and API is deferred:
- Generate `proj_local_<random8chars>` where random is lowercase alphanumeric
- Format: `proj_local_a1b2c3d4` (satisfies `^proj_[a-z0-9]+$` and min 12 chars)
- `crypto.randomBytes(4).toString('hex')` gives 8 hex chars

## Diff Display (Q7)

Use Node.js built-in or simple unified diff:
- Compare existing vs generated line-by-line
- Show `--- existing` / `+++ generated` header
- Use `+`/`-` line prefixes
- No external dependency needed — implement minimal unified diff or use a small utility

Options:
- **`diff` npm package**: Well-known, 50KB, provides `createTwoFilesPatch()`
- **Manual**: ~30 lines of code for basic unified diff
- **Recommendation**: Use the `diff` npm package for correctness and maintainability

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | User error / validation failure |
| 2 | API error (reserved for future) |
| 130 | User cancelled (SIGINT / prompt cancellation) |
