# Implementation Plan: 4.5 — Generacy CLI: `generacy init`

**Branch**: `249-4-5-generacy-cli` | **Date**: 2026-02-27

## Summary

Implement the `generacy init` command as a new subcommand in the existing `@generacy-ai/generacy` CLI package. The command scaffolds `.generacy/`, `.devcontainer/`, and `.vscode/` directories using `@generacy-ai/templates`. It supports both interactive prompts (via `@clack/prompts`) and non-interactive flag-driven usage, validates GitHub access, handles file conflicts with per-file overwrite/skip/diff prompting, and generates a local placeholder project ID when the API is unavailable.

The implementation adds `@generacy-ai/templates` and `@clack/prompts` as dependencies, introduces a repo URL normalizer, and follows the established command patterns (Commander.js, Pino logger, `exec`/`execSafe` utilities).

## Technical Context

| Aspect | Detail |
|--------|--------|
| **Language** | TypeScript (ESM, strict mode, ES2022 target) |
| **Package** | `@generacy-ai/generacy` at `packages/generacy/` |
| **CLI framework** | Commander.js 12.x |
| **Prompt library** | `@clack/prompts` (new dependency — per Q1) |
| **Template engine** | `@generacy-ai/templates` (new dependency — workspace link) |
| **Diff library** | `diff` npm package (new dependency — for file conflict diff display) |
| **Schema validation** | Zod 3.23.x (existing) |
| **Config loader** | `loadConfig()` from internal `config/` module |
| **Test framework** | Vitest 4.x with `@vitest/coverage-v8` |
| **Node.js** | >= 20.0.0 |

## Architecture Overview

```
packages/generacy/src/cli/
├── index.ts                           ← Add initCommand() registration
├── commands/
│   └── init/
│       ├── index.ts                   ← initCommand() — Commander setup + action
│       ├── prompts.ts                 ← Interactive prompt flow using @clack/prompts
│       ├── resolver.ts                ← Merge flags + prompts + auto-detection into InitOptions
│       ├── github.ts                  ← GitHub access validation
│       ├── conflicts.ts               ← File conflict detection, diff display, merge logic
│       ├── writer.ts                  ← File writer (mkdir + writeFile) + dry-run support
│       ├── summary.ts                 ← Completion summary + next steps
│       ├── repo-utils.ts              ← Repo URL parsing, normalization, auto-detect
│       └── types.ts                   ← Shared types (InitOptions, FileAction, etc.)
└── utils/
    ├── exec.ts                        ← Existing (used for git/gh commands)
    └── logger.ts                      ← Existing (Pino logger)
```

**Data flow**:
```
CLI flags + interactive prompts + auto-detection
    ↓
resolver.ts → InitOptions
    ↓
buildSingleRepoContext() / buildMultiRepoContext()  (from @generacy-ai/templates)
    ↓
renderProject(context, existingFiles)
    ↓
conflicts.ts → per-file overwrite/skip/diff decisions
    ↓
writer.ts → files written to disk (or dry-run preview)
    ↓
loadConfig() → post-generation validation
    ↓
summary.ts → completion output
```

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Modular `init/` subdirectory | Follows `doctor/` pattern; keeps concerns separated (prompts, conflicts, writing, summary) for testability |
| `@clack/prompts` for interactive UX | Per Q1 — polished UX for first interactive touchpoint; lightweight, ESM-compatible |
| `diff` npm package for conflict diffs | Reliable unified diff output; ~50KB; avoids reimplementing diff algorithm |
| `@generacy-ai/templates` as workspace dependency | Already in monorepo; provides `buildSingleRepoContext`, `buildMultiRepoContext`, `renderProject` |
| Local placeholder ID `proj_local_<hex>` | Per Q2 — works offline; satisfies `^proj_[a-z0-9]+$` validation; updatable later |
| API integration deferred entirely | Per Q3 — cloud endpoints don't exist yet; stub with TODO comments |
| Accept multiple repo URL formats, normalize | Per Q4 — bridges gap between git remote URLs (`https://`, `git@`) and template `owner/repo` format |
| `GITHUB_TOKEN` then `gh auth token` fallback | Per Q5 — consistent with existing `github-issues` package; `gh` CLI available in Dev Container |
| `--release-stream` flag, no interactive prompt | Per Q6 — power users opt in; most users get stable default |
| Inline unified diff, then re-prompt | Per Q7 — user sees diff then decides per-file; works headless |
| `--yes` auto-derives from context + prints warnings | Per Q8 — like `npm init -y`; fail only if truly impossible |
| Always use default orchestrator settings | Per Q9 — 2 workers, 5000ms poll; editable post-init |
| Prompt before API creation (deferred) | Per Q10 — respect user control over server-side resource creation |
| Load existing config as defaults on re-init | Per Q11 — pre-fill interactive flow with current values |
| Always use default base image | Per Q12 — language-agnostic base; editable post-init |

---

## Implementation Phases

### Phase 1: Dependencies & Scaffolding

**Goal**: Add dependencies, create file structure, register command.

**Files to modify**:
- `packages/generacy/package.json` — add `@generacy-ai/templates`, `@clack/prompts`, `diff` dependencies
- `packages/generacy/src/cli/index.ts` — import and register `initCommand()`

**Files to create**:
- `packages/generacy/src/cli/commands/init/types.ts`
- `packages/generacy/src/cli/commands/init/index.ts` (skeleton)

#### 1a. Add dependencies

```
pnpm add @generacy-ai/templates@workspace:* @clack/prompts diff
pnpm add -D @types/diff
```

#### 1b. Define shared types (`types.ts`)

```typescript
/** Resolved options for init — all values are concrete (no undefined) */
export interface InitOptions {
  projectId: string | null;       // null = generate local placeholder
  projectName: string;
  primaryRepo: string;            // normalized to "owner/repo"
  devRepos: string[];             // normalized to "owner/repo"
  cloneRepos: string[];           // normalized to "owner/repo"
  agent: string;                  // default: 'claude-code'
  baseBranch: string;             // default: 'main'
  releaseStream: 'stable' | 'preview';  // default: 'stable'
  force: boolean;
  dryRun: boolean;
  skipGithubCheck: boolean;
  yes: boolean;
  verbose: boolean;
}

/** Per-file conflict resolution action */
export type FileAction = 'overwrite' | 'skip' | 'merge';

/** Result of file writing for summary */
export interface FileResult {
  path: string;
  action: 'created' | 'overwritten' | 'merged' | 'skipped';
  size: number;
}
```

#### 1c. Register command (`index.ts` skeleton + CLI registration)

Create the Commander.js command with all flags defined (action body as TODO placeholder). Register in `src/cli/index.ts` alongside existing commands.

**Flags**:
- `--project-id <id>`
- `--project-name <name>`
- `--primary-repo <repo>`
- `--dev-repo <repo...>` (variadic)
- `--clone-repo <repo...>` (variadic)
- `--agent <agent>` (default: `claude-code`)
- `--base-branch <branch>` (default: `main`)
- `--release-stream <stream>` (choices: `stable`, `preview`; default: `stable`)
- `--force`
- `--dry-run`
- `--skip-github-check`
- `-y, --yes`
- `-v, --verbose`

---

### Phase 2: Repo URL Utilities

**Goal**: Parse and normalize all supported repo URL formats.

**File**: `packages/generacy/src/cli/commands/init/repo-utils.ts`

#### 2a. `parseRepoUrl(input: string): { owner: string; repo: string }`

Handles:
- `owner/repo` → `{ owner, repo }`
- `github.com/owner/repo` → strip domain
- `https://github.com/owner/repo` → strip protocol + domain
- `https://github.com/owner/repo.git` → strip `.git`
- `git@github.com:owner/repo.git` → parse SSH format

Throws descriptive error if format is unrecognizable.

#### 2b. `toShorthand(parsed: { owner, repo }): string`

Returns `owner/repo` for templates package.

#### 2c. `toConfigFormat(parsed: { owner, repo }): string`

Returns `github.com/owner/repo` for config schema.

#### 2d. `normalizeRepoUrl(input: string): { shorthand: string; configFormat: string }`

Combines parse + both format helpers.

#### 2e. `detectPrimaryRepo(cwd: string): string | null`

Runs `git remote get-url origin` via `execSafe()`. Returns normalized `owner/repo` or `null` if no remote or not parseable.

#### 2f. `detectGitRoot(cwd: string): string | null`

Runs `git rev-parse --show-toplevel` via `execSafe()`. Returns absolute path or `null`.

---

### Phase 3: Interactive Prompts

**Goal**: Build the `@clack/prompts` interactive flow.

**File**: `packages/generacy/src/cli/commands/init/prompts.ts`

#### 3a. `runInteractivePrompts(defaults: Partial<InitOptions>): Promise<InitOptions>`

Uses `@clack/prompts` group/sequential prompts:

1. **Intro**: `p.intro('generacy init')` with version
2. **Project name**: `p.text()` with `defaults.projectName` as initial value (auto-derived from directory name if not provided)
3. **Primary repo**: `p.text()` with auto-detected remote as initial value; validate with `parseRepoUrl()`
4. **Dev repos**: `p.text()` with prompt "Add development repos? (comma-separated, or leave empty)"; parse and validate each
5. **Clone repos**: `p.text()` (same pattern, only shown if dev repos were provided for multi-repo)
6. **Agent**: `p.select()` with options `['claude-code', 'cursor-agent']`, default `claude-code`
7. **Base branch**: `p.text()` with default `main`
8. **Cancel handler**: `p.isCancel()` → `process.exit(130)`

Pre-fill all prompts with values from CLI flags or existing config (Q11). Skip prompts where CLI flags already provide the value.

#### 3b. Existing config detection

If `.generacy/config.yaml` exists and is valid:
- Load it via `loadConfig()`
- Use existing values as defaults in prompts
- Normalize existing repo URLs from config format to shorthand for display

---

### Phase 4: Options Resolver

**Goal**: Merge CLI flags, interactive prompts, auto-detection, and defaults into `InitOptions`.

**File**: `packages/generacy/src/cli/commands/init/resolver.ts`

#### 4a. `resolveOptions(flags, gitRoot): Promise<InitOptions>`

Priority: CLI flags > existing config > interactive prompts > auto-detection > defaults

Logic:
1. Check if inside git repo via `detectGitRoot()` — abort if not
2. Check for existing `.generacy/config.yaml` — load if valid (Q11)
3. If `--yes` flag: auto-derive missing values (Q8):
   - Project name: directory name (basename of git root)
   - Primary repo: `detectPrimaryRepo()`
   - Print warnings for auto-derived values
   - Fail if auto-detection impossible (no git remote for primary repo)
4. If interactive (no `--yes` and no complete flags): run `runInteractivePrompts()`
5. Generate project ID if not provided:
   - `--project-id` flag: use as-is (validate `^proj_` format)
   - Otherwise: generate `proj_local_<crypto.randomBytes(4).toString('hex')>` (Q2)
6. Normalize all repo URLs via `normalizeRepoUrl()`
7. Return fully resolved `InitOptions`

---

### Phase 5: GitHub Access Validation

**Goal**: Validate repository permissions via GitHub API.

**File**: `packages/generacy/src/cli/commands/init/github.ts`

#### 5a. `discoverGitHubToken(): string | null`

1. Check `process.env.GITHUB_TOKEN`
2. Fallback: `execSafe('gh auth token')` → parse stdout
3. Return token or `null`

#### 5b. `validateRepoAccess(repos: string[], token: string): Promise<RepoAccessResult[]>`

For each repo (`owner/repo`):
- `GET https://api.github.com/repos/{owner}/{repo}` with `Authorization: Bearer {token}`
- Check response: 200 = ok, 404 = not found / no access, 401/403 = bad credentials
- Check `permissions.push` for write access

Return array of `{ repo, accessible, writable, error? }`.

#### 5c. `runGitHubValidation(options: InitOptions): Promise<void>`

- Skip if `--skip-github-check`
- Discover token
- If no token: print warning ("GitHub validation skipped — no credentials found") and return
- Validate primary repo + dev repos + clone repos
- Print warnings for inaccessible or read-only repos
- Do NOT abort — validation is advisory

Use `@clack/prompts` spinner for feedback during validation.

---

### Phase 6: File Conflict Handling

**Goal**: Detect existing files, prompt for resolution, show diffs.

**File**: `packages/generacy/src/cli/commands/init/conflicts.ts`

#### 6a. `checkConflicts(files: Map<string, string>, gitRoot: string): Map<string, string>`

For each rendered file path, check if `join(gitRoot, path)` exists. Return map of conflicting paths to existing content.

#### 6b. `showDiff(path: string, existing: string, generated: string): void`

Use `diff` package (`createTwoFilesPatch()`) to show unified diff. Print to stdout with `--- existing` / `+++ generated` headers.

#### 6c. `resolveConflicts(files, conflicts, options): Promise<Map<string, FileAction>>`

For each conflicting file:
- If `--force`: action = `overwrite` for all
- If `.vscode/extensions.json`: action = `merge` (smart merge handled by `renderProject` via `existingFiles` parameter)
- Otherwise: prompt user with `p.select()`:
  - "Overwrite" → `overwrite`
  - "Skip" → `skip`
  - "Show diff" → display diff, then re-prompt with overwrite/skip (Q7)

Non-conflicting files: action = `overwrite` (create new).

---

### Phase 7: File Writer

**Goal**: Write files to disk or preview in dry-run mode.

**File**: `packages/generacy/src/cli/commands/init/writer.ts`

#### 7a. `writeFiles(files, actions, gitRoot, dryRun): Promise<FileResult[]>`

For each file:
- If `dryRun`: print path + size, record as `created` (no write)
- If action is `skip`: record as `skipped`
- If action is `overwrite` or `merge`:
  - Create parent directories with `mkdirSync(dir, { recursive: true })`
  - Write file with `writeFileSync(fullPath, content, 'utf-8')`
  - Record as `created` / `overwritten` / `merged`

Return array of `FileResult` for summary.

---

### Phase 8: Summary & Next Steps

**Goal**: Print completion summary with file list and guidance.

**File**: `packages/generacy/src/cli/commands/init/summary.ts`

#### 8a. `printSummary(results: FileResult[], dryRun: boolean): void`

Table format:
```
  Created  .generacy/config.yaml (245 bytes)
  Created  .generacy/generacy.env.template (120 bytes)
  Created  .generacy/.gitignore (45 bytes)
  Merged   .vscode/extensions.json (180 bytes)
  Created  .devcontainer/devcontainer.json (890 bytes)
  Skipped  .devcontainer/docker-compose.yml
```

For `--dry-run`: prefix with "Would create" / "Would overwrite" / etc.

#### 8b. `printNextSteps(): void`

```
Next steps:
  1. Review the generated files
  2. Copy .generacy/generacy.env.template to .generacy/generacy.env and fill in credentials
  3. Run `generacy doctor` to verify system requirements
  4. Commit the generated files to your repository
```

---

### Phase 9: Command Action (Wire Everything Together)

**Goal**: Implement the full `generacy init` action connecting all modules.

**File**: `packages/generacy/src/cli/commands/init/index.ts`

Complete flow:

```typescript
async function initAction(options: CLIFlags): Promise<void> {
  const logger = getLogger();

  // 1. Detect git root
  const gitRoot = detectGitRoot(process.cwd());
  if (!gitRoot) {
    p.log.error('Not inside a Git repository. Run this command from within a Git repo.');
    process.exit(1);
  }

  // 2. Resolve options (flags + prompts + auto-detect)
  const initOptions = await resolveOptions(options, gitRoot);

  // 3. GitHub validation (unless skipped)
  await runGitHubValidation(initOptions);

  // 4. Build template context
  const isMultiRepo = initOptions.devRepos.length > 0;
  const context = isMultiRepo
    ? buildMultiRepoContext({
        projectId: initOptions.projectId ?? generateLocalProjectId(),
        projectName: initOptions.projectName,
        primaryRepo: initOptions.primaryRepo,
        devRepos: initOptions.devRepos,
        cloneRepos: initOptions.cloneRepos,
        baseBranch: initOptions.baseBranch,
        releaseStream: initOptions.releaseStream,
      })
    : buildSingleRepoContext({
        projectId: initOptions.projectId ?? generateLocalProjectId(),
        projectName: initOptions.projectName,
        primaryRepo: initOptions.primaryRepo,
        baseBranch: initOptions.baseBranch,
        releaseStream: initOptions.releaseStream,
      });

  // 5. Collect existing files for merge support
  const existingFiles = collectExistingFiles(gitRoot);

  // 6. Render templates
  const renderedFiles = await renderProject(context, existingFiles);

  // 7. Check conflicts
  const conflicts = checkConflicts(renderedFiles, gitRoot);

  // 8. Resolve conflicts (prompt or force)
  const actions = await resolveConflicts(renderedFiles, conflicts, initOptions);

  // 9. Write files (or dry-run preview)
  const results = await writeFiles(renderedFiles, actions, gitRoot, initOptions.dryRun);

  // 10. Post-generation validation (skip if dry-run)
  if (!initOptions.dryRun) {
    try {
      loadConfig({ startDir: gitRoot });
      logger.debug('Post-generation config validation passed');
    } catch (error) {
      p.log.warn('Generated config failed validation — please check .generacy/config.yaml');
      logger.debug({ error }, 'Post-generation validation error');
    }
  }

  // 11. Print summary and next steps
  printSummary(results, initOptions.dryRun);
  if (!initOptions.dryRun) {
    printNextSteps();
  }

  process.exit(0);
}
```

---

### Phase 10: Tests

**Goal**: Unit tests for each module + integration test for the full command.

#### 10a. Unit tests

| Test file | Module | Key test cases |
|-----------|--------|----------------|
| `repo-utils.test.ts` | `repo-utils.ts` | Parse all URL formats; reject invalid; normalize to both formats; auto-detect from mock git remote |
| `prompts.test.ts` | `prompts.ts` | Mock `@clack/prompts`; verify prompt flow with defaults; verify skip when flags provided; verify cancel exits 130 |
| `resolver.test.ts` | `resolver.ts` | Flags override prompts; `--yes` auto-derives; existing config pre-fills; project ID generation; missing required → error |
| `github.test.ts` | `github.ts` | Token discovery order; mock API responses (200, 404, 401); skip flag; warning messages |
| `conflicts.test.ts` | `conflicts.ts` | No conflicts → all create; existing files detected; `--force` overrides; `.vscode/extensions.json` merge; diff display |
| `writer.test.ts` | `writer.ts` | Files written to temp dir; directories created recursively; dry-run no-op; skip respected |
| `summary.test.ts` | `summary.ts` | Output contains file paths and actions; dry-run prefix; next steps printed |

#### 10b. Integration test

**File**: `packages/generacy/src/cli/__tests__/init.test.ts`

Pattern: subprocess execution with temp directory (matching `validate.test.ts` and `doctor.test.ts` patterns).

Key scenarios:
1. **Non-interactive single-repo**: `generacy init --project-name "Test" --primary-repo "acme/app" -y` → verify files created, config validates
2. **Non-interactive multi-repo**: Add `--dev-repo "acme/lib"` → verify docker-compose.yml created
3. **Not in git repo**: Run from non-git temp dir → exit code 1
4. **Dry-run**: `--dry-run` → no files written, preview printed
5. **Force overwrite**: Init twice with `--force` → no prompts on second run
6. **Invalid repo format**: `--primary-repo "not-valid"` → exit code 1
7. **Missing required in non-interactive**: No flags, no TTY → exit code 1

---

## Data Models

No new persistent data models. The `InitOptions` type is internal to the command. The generated files use existing schemas:
- `.generacy/config.yaml` → `GeneracyConfig` (Zod schema in `config/schema.ts`)
- Template context → `TemplateContext` (from `@generacy-ai/templates`)

See [research.md](./research.md) for the format gap between config schema and template schema.

## API Contracts

No new API endpoints. The Generacy API integration (FR-017, FR-018) is deferred per Q3. Placeholder comments will mark where API calls would be inserted.

GitHub API is used read-only for validation:
- `GET /repos/{owner}/{repo}` — check repo existence and permissions

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Format gap between config schema (`github.com/owner/repo`) and templates (`owner/repo`) causes validation failures | `repo-utils.ts` normalizes all inputs to both formats; unit tests cover all URL variations |
| `@clack/prompts` breaks in non-TTY environments (CI) | `--yes` flag bypasses all prompts; detect `!process.stdin.isTTY` and require `--yes` or complete flags |
| Generated config fails `loadConfig()` validation | Post-generation validation (step 10) catches issues immediately; test parity with `generacy validate` |
| File conflict handling overwrites user work | Per-file prompting by default; `--force` requires explicit opt-in; diff display before decision |
| Templates package API changes | Pin workspace dependency; integration test renders and validates output |
| `gh auth token` not available in all environments | Graceful fallback — validation is advisory, not blocking; `--skip-github-check` escape hatch |

## Dependency Summary

**New production dependencies**:
| Package | Version | Purpose |
|---------|---------|---------|
| `@generacy-ai/templates` | `workspace:*` | Template rendering engine |
| `@clack/prompts` | `^0.9` | Interactive CLI prompts |
| `diff` | `^7` | Unified diff for file conflict display |

**New dev dependencies**:
| Package | Version | Purpose |
|---------|---------|---------|
| `@types/diff` | `^7` | TypeScript types for diff package |
