# Tasks: Generacy CLI `generacy init`

**Input**: Design documents from `specs/249-4-5-generacy-cli/`
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel with other [P] tasks in same phase (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US5, or INFRA for infrastructure)

---

## Phase 1: Dependencies & Scaffolding

### T001 [INFRA] Install new dependencies
**File**: `packages/generacy/package.json`
- Add `@generacy-ai/templates@workspace:*` as production dependency
- Add `@clack/prompts` (^0.9) as production dependency
- Add `diff` (^7) as production dependency
- Add `@types/diff` (^7) as dev dependency
- Run `pnpm install` to update lockfile
- Verify workspace link resolves correctly for `@generacy-ai/templates`

### T002 [P] [INFRA] Define shared types
**File**: `packages/generacy/src/cli/commands/init/types.ts`
- Define `InitOptions` interface with all resolved fields:
  - `projectId: string | null` (null = generate local placeholder)
  - `projectName: string`
  - `primaryRepo: string` (normalized to `owner/repo`)
  - `devRepos: string[]`, `cloneRepos: string[]` (normalized)
  - `agent: string`, `baseBranch: string`
  - `releaseStream: 'stable' | 'preview'`
  - `force`, `dryRun`, `skipGithubCheck`, `yes`, `verbose` booleans
- Define `FileAction` type: `'overwrite' | 'skip' | 'merge'`
- Define `FileResult` interface: `{ path, action, size }`
- Define `RepoAccessResult` interface: `{ repo, accessible, writable, error? }`

### T003 [P] [INFRA] Create command skeleton and register in CLI
**Files**:
- `packages/generacy/src/cli/commands/init/index.ts` (new)
- `packages/generacy/src/cli/index.ts` (modify)
- Create `initCommand()` function returning a Commander.js `Command`
- Define all CLI flags matching the spec:
  - `--project-id <id>`, `--project-name <name>`, `--primary-repo <repo>`
  - `--dev-repo <repo...>` (variadic), `--clone-repo <repo...>` (variadic)
  - `--agent <agent>` (default: `claude-code`), `--base-branch <branch>` (default: `main`)
  - `--release-stream <stream>` (choices: `stable`/`preview`, default: `stable`)
  - `--force`, `--dry-run`, `--skip-github-check`
  - `-y, --yes`, `-v, --verbose`
- Set command description: `"Initialize a Generacy project in the current repository"`
- Action body: placeholder that logs "init command invoked" (wired in Phase 9)
- Import `initCommand` in `src/cli/index.ts` and add `program.addCommand(initCommand())`

---

## Phase 2: Repo URL Utilities

### T004 [US1] Implement repo URL parsing and normalization
**File**: `packages/generacy/src/cli/commands/init/repo-utils.ts`
- `parseRepoUrl(input: string): { owner: string; repo: string }` — handles:
  - `owner/repo` shorthand
  - `github.com/owner/repo` (no protocol)
  - `https://github.com/owner/repo` (HTTPS)
  - `https://github.com/owner/repo.git` (HTTPS with .git)
  - `git@github.com:owner/repo.git` (SSH)
  - Throw descriptive error for unrecognizable formats
- `toShorthand(parsed): string` — returns `owner/repo` (for templates)
- `toConfigFormat(parsed): string` — returns `github.com/owner/repo` (for config schema)
- `normalizeRepoUrl(input: string): { shorthand: string; configFormat: string }` — combines parse + both format helpers
- `detectPrimaryRepo(cwd: string): string | null` — run `git remote get-url origin` via `execSafe()`, return normalized `owner/repo` or `null`
- `detectGitRoot(cwd: string): string | null` — run `git rev-parse --show-toplevel` via `execSafe()`, return absolute path or `null`

---

## Phase 3: Interactive Prompts

### T005 [US1] Implement interactive prompt flow
**File**: `packages/generacy/src/cli/commands/init/prompts.ts`
- `runInteractivePrompts(defaults: Partial<InitOptions>): Promise<Partial<InitOptions>>` using `@clack/prompts`:
  1. `p.intro('generacy init')` with version banner
  2. Project name: `p.text()` with default from `defaults.projectName` or dirname
  3. Primary repo: `p.text()` with default from auto-detected remote; validate with `parseRepoUrl()`
  4. Dev repos: `p.text()` — comma-separated or empty; parse and validate each
  5. Clone repos: `p.text()` — only shown if dev repos were provided
  6. Agent: `p.select()` with options `['claude-code', 'cursor-agent']`
  7. Base branch: `p.text()` with default `main`
- Handle `p.isCancel()` on every prompt → `process.exit(130)`
- Skip prompts where values are already provided via `defaults` (from CLI flags)
- Implement existing config detection: if `.generacy/config.yaml` exists and is valid, load via `loadConfig()` and use values as defaults (normalize repo URLs from config format to shorthand for display)

---

## Phase 4: Options Resolver

### T006 [US1, US2] Implement options resolver
**File**: `packages/generacy/src/cli/commands/init/resolver.ts`
- `resolveOptions(flags: Record<string, unknown>, gitRoot: string): Promise<InitOptions>`
- Priority chain: CLI flags > existing config > interactive prompts > auto-detection > defaults
- Logic:
  1. Load existing `.generacy/config.yaml` if present (use as defaults for re-init)
  2. If `--yes` flag: auto-derive missing values:
     - Project name from `basename(gitRoot)`
     - Primary repo from `detectPrimaryRepo()`
     - Print warnings for auto-derived values
     - Fail with exit code 1 if primary repo can't be auto-detected
  3. If not `--yes` and not fully specified by flags: run `runInteractivePrompts()`
  4. Non-TTY detection: if `!process.stdin.isTTY` and prompts needed, error with "Use --yes or provide all flags"
  5. Generate project ID if not provided:
     - `--project-id`: validate `^proj_` format, use as-is
     - Otherwise: `proj_local_<crypto.randomBytes(4).toString('hex')>`
  6. Normalize all repo URLs via `normalizeRepoUrl()` — store shorthand format
  7. Validate no duplicate repo names (same repo basename in different roles)
  8. Return fully resolved `InitOptions`

---

## Phase 5: GitHub Access Validation

### T007 [US4] Implement GitHub access validation
**File**: `packages/generacy/src/cli/commands/init/github.ts`
- `discoverGitHubToken(): string | null`
  - Check `process.env.GITHUB_TOKEN` first
  - Fallback: `execSafe('gh auth token')` → parse stdout
  - Return token or `null`
- `validateRepoAccess(repos: string[], token: string): Promise<RepoAccessResult[]>`
  - For each repo (`owner/repo`): `GET https://api.github.com/repos/{owner}/{repo}`
  - Use `Authorization: Bearer {token}` header
  - Check: 200 = accessible, check `permissions.push` for writable
  - Handle 404 (not found/no access), 401/403 (bad credentials)
  - Return array of `RepoAccessResult`
- `runGitHubValidation(options: InitOptions): Promise<void>`
  - Skip if `options.skipGithubCheck` is true
  - Discover token; if no token: print warning and return (advisory only)
  - Validate primary + dev + clone repos
  - Print warnings for inaccessible or read-only repos using `@clack/prompts` log helpers
  - Use `p.spinner()` for progress feedback during validation
  - Never abort — validation is advisory

---

## Phase 6: File Conflict Handling

### T008 [US5] Implement file conflict detection and resolution
**File**: `packages/generacy/src/cli/commands/init/conflicts.ts`
- `checkConflicts(files: Map<string, string>, gitRoot: string): Map<string, string>`
  - For each rendered file path, check if `join(gitRoot, path)` exists
  - Return map of conflicting paths → existing file content
- `showDiff(path: string, existing: string, generated: string): void`
  - Use `diff` package's `createTwoFilesPatch()` for unified diff
  - Print to stdout with `--- existing` / `+++ generated` headers
- `resolveConflicts(files: Map<string, string>, conflicts: Map<string, string>, options: InitOptions): Promise<Map<string, FileAction>>`
  - For non-conflicting files: action = `'overwrite'` (create new)
  - If `--force`: all conflicting files → `'overwrite'`
  - If `.vscode/extensions.json` conflict: → `'merge'` (smart merge via `renderProject`'s `existingFiles`)
  - Otherwise: prompt per-file with `p.select()`:
    - "Overwrite" → `'overwrite'`
    - "Skip" → `'skip'`
    - "Show diff" → display diff, then re-prompt with overwrite/skip
  - Handle cancel → `process.exit(130)`

---

## Phase 7: File Writer

### T009 [P] [US1, US2] Implement file writer with dry-run support
**File**: `packages/generacy/src/cli/commands/init/writer.ts`
- `writeFiles(files: Map<string, string>, actions: Map<string, FileAction>, gitRoot: string, dryRun: boolean): Promise<FileResult[]>`
  - For each file in rendered map:
    - If `dryRun`: record action without writing, log what would be written
    - If action is `'skip'`: record as `skipped` with size 0
    - If action is `'overwrite'` or `'merge'`:
      - Create parent directories with `mkdirSync(dir, { recursive: true })`
      - Write content with `writeFileSync(fullPath, content, 'utf-8')`
      - Record as `'created'` (new file) or `'overwritten'` (existing) or `'merged'`
  - Return `FileResult[]` for summary
- `collectExistingFiles(gitRoot: string): Map<string, string>`
  - Read existing `.vscode/extensions.json` if present (for smart merge via `renderProject`)
  - Return map of relative path → content

---

## Phase 8: Summary & Next Steps

### T010 [P] [US1] Implement completion summary and next steps output
**File**: `packages/generacy/src/cli/commands/init/summary.ts`
- `printSummary(results: FileResult[], dryRun: boolean): void`
  - Use `@clack/prompts` log helpers for styled output
  - Table format with action + path + size:
    - `Created  .generacy/config.yaml (245 bytes)`
    - `Merged   .vscode/extensions.json (180 bytes)`
    - `Skipped  .devcontainer/docker-compose.yml`
  - Dry-run mode: prefix actions with "Would" (`Would create`, `Would overwrite`, etc.)
  - Show totals: `N files created, N merged, N skipped`
- `printNextSteps(): void`
  - Print guidance using `p.note()` or similar:
    1. Review the generated files
    2. Copy `.generacy/generacy.env.template` to `.generacy/generacy.env` and fill in credentials
    3. Run `generacy doctor` to verify system requirements
    4. Commit the generated files to your repository

---

## Phase 9: Wire Everything Together

### T011 [US1, US2, US3, US4, US5] Implement full command action
**File**: `packages/generacy/src/cli/commands/init/index.ts`
- Replace placeholder action with full `initAction()` implementation
- Wire the complete flow in order:
  1. Detect git root via `detectGitRoot()` — abort with exit code 1 if not in a git repo
  2. Resolve options via `resolveOptions()` (merges flags + prompts + auto-detection)
  3. Run GitHub validation via `runGitHubValidation()` (unless skipped)
  4. Build template context:
     - Determine single-repo vs multi-repo based on `devRepos.length > 0`
     - Call `buildSingleRepoContext()` or `buildMultiRepoContext()` from `@generacy-ai/templates`
     - Generate local project ID (`proj_local_<hex>`) if `projectId` is null
  5. Collect existing files via `collectExistingFiles()` (for smart merge)
  6. Render templates via `renderProject(context, existingFiles)`
  7. Check conflicts via `checkConflicts()`
  8. Resolve conflicts via `resolveConflicts()`
  9. Write files via `writeFiles()` (or preview in dry-run mode)
  10. Post-generation validation: `loadConfig({ startDir: gitRoot })` — warn on failure, don't abort
  11. Print summary via `printSummary()` and next steps via `printNextSteps()` (skip next steps in dry-run)
- Exit codes: 0 (success), 1 (user error / validation failure), 130 (user cancelled)
- Add TODO comments for deferred API integration (FR-017, FR-018)

---

## Phase 10: Unit Tests

### T012 [P] [US1] Write unit tests for repo-utils
**File**: `packages/generacy/src/cli/commands/init/__tests__/repo-utils.test.ts`
- Test `parseRepoUrl()` with all supported formats:
  - `owner/repo` → `{ owner: 'owner', repo: 'repo' }`
  - `github.com/owner/repo` → strips domain
  - `https://github.com/owner/repo` → strips protocol + domain
  - `https://github.com/owner/repo.git` → strips `.git`
  - `git@github.com:owner/repo.git` → parses SSH
  - Invalid inputs throw descriptive errors
- Test `toShorthand()` and `toConfigFormat()` output formats
- Test `normalizeRepoUrl()` combined behavior
- Test `detectGitRoot()` — mock `execSafe` for git repo and non-repo cases
- Test `detectPrimaryRepo()` — mock `execSafe` for various remote URL formats and missing remote

### T013 [P] [US1] Write unit tests for prompts
**File**: `packages/generacy/src/cli/commands/init/__tests__/prompts.test.ts`
- Mock `@clack/prompts` module
- Test prompt flow runs all prompts when no defaults provided
- Test prompts are skipped when corresponding default values exist
- Test cancel handling exits with code 130
- Test existing config detection loads and normalizes values as defaults
- Test validation of repo URL input during prompt

### T014 [P] [US1, US2] Write unit tests for resolver
**File**: `packages/generacy/src/cli/commands/init/__tests__/resolver.test.ts`
- Test CLI flags take priority over all other sources
- Test `--yes` auto-derives project name from directory name and primary repo from git remote
- Test `--yes` fails when primary repo can't be auto-detected
- Test non-TTY without `--yes` produces error
- Test existing config values pre-fill defaults
- Test project ID generation: `--project-id` validates format; missing generates `proj_local_*`
- Test all repo URLs normalized consistently
- Test duplicate repo name detection

### T015 [P] [US4] Write unit tests for github validation
**File**: `packages/generacy/src/cli/commands/init/__tests__/github.test.ts`
- Test `discoverGitHubToken()` priority: env var > `gh auth token`
- Test `discoverGitHubToken()` returns `null` when neither available
- Mock `fetch` for `validateRepoAccess()`:
  - 200 with `permissions.push=true` → accessible + writable
  - 200 with `permissions.push=false` → accessible + read-only
  - 404 → not accessible
  - 401/403 → bad credentials error
- Test `runGitHubValidation()` skips when `skipGithubCheck=true`
- Test `runGitHubValidation()` warns (not errors) when no token found
- Test warning output for inaccessible and read-only repos

### T016 [P] [US5] Write unit tests for conflicts
**File**: `packages/generacy/src/cli/commands/init/__tests__/conflicts.test.ts`
- Test `checkConflicts()` returns empty map when no files exist
- Test `checkConflicts()` detects existing files and returns their content
- Test `resolveConflicts()` with `--force` returns all overwrite
- Test `resolveConflicts()` auto-merges `.vscode/extensions.json`
- Test `showDiff()` produces unified diff output
- Test interactive prompting for each conflicting file (mock `p.select`)
- Test "Show diff" option re-prompts after displaying diff

### T017 [P] [US1] Write unit tests for writer
**File**: `packages/generacy/src/cli/commands/init/__tests__/writer.test.ts`
- Test files written to correct paths in temp directory
- Test parent directories created recursively
- Test dry-run mode writes no files
- Test skip action skips file writing
- Test `FileResult` array matches expected actions and sizes
- Test `collectExistingFiles()` reads `.vscode/extensions.json` when present

### T018 [P] [US1] Write unit tests for summary
**File**: `packages/generacy/src/cli/commands/init/__tests__/summary.test.ts`
- Test `printSummary()` outputs all file results with correct labels
- Test dry-run prefix ("Would create" etc.)
- Test totals line (`N files created, N merged, N skipped`)
- Test `printNextSteps()` outputs all guidance steps

---

## Phase 11: Integration Tests

### T019 [US1, US2, US5] Write integration tests for full init command
**File**: `packages/generacy/src/cli/__tests__/init.test.ts`
- Follow subprocess execution pattern from `validate.test.ts` and `doctor.test.ts`
- Use temp directories with `mkdtempSync()`, initialize git repos with `git init`
- Test scenarios:
  1. **Non-interactive single-repo**: `generacy init --project-name "Test" --primary-repo "acme/app" -y --skip-github-check` → verify all expected files created, config passes `generacy validate`
  2. **Non-interactive multi-repo**: Add `--dev-repo "acme/lib"` → verify `docker-compose.yml` created
  3. **Not in git repo**: Run from non-git temp dir → exit code 1, error message
  4. **Dry-run**: `--dry-run` → no files written, preview output in stdout
  5. **Force overwrite**: Init twice with `--force` → second run succeeds without prompts, files updated
  6. **Invalid repo format**: `--primary-repo "not-valid"` → exit code 1, error message
  7. **Missing required in non-interactive**: No flags, `--yes`, no git remote → exit code 1
- Use `NO_COLOR: '1'` env var for predictable output in assertions
- Clean up temp directories in `afterEach`

---

## Phase 12: Build Verification

### T020 [INFRA] Verify build and lint pass
**Files**: All new and modified files
- Run `pnpm build` in `packages/generacy/` — verify TypeScript compiles without errors
- Run `pnpm lint` — verify ESLint passes on all new files
- Run `pnpm test` — verify all new unit and integration tests pass
- Verify `generacy init --help` outputs correct usage information
- Verify `generacy --help` lists `init` in the commands list

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001–T003) must complete before all subsequent phases
- Phase 2 (T004) must complete before Phase 3 (T005) and Phase 4 (T006)
- Phase 3 (T005) must complete before Phase 4 (T006)
- Phase 4 (T006) must complete before Phase 9 (T011)
- Phase 5 (T007) must complete before Phase 9 (T011)
- Phase 6 (T008) must complete before Phase 9 (T011)
- Phase 7 (T009) and Phase 8 (T010) must complete before Phase 9 (T011)
- Phase 9 (T011) must complete before Phase 11 (T019)
- All implementation phases must complete before Phase 12 (T020)

**Parallel opportunities within phases**:
- Phase 1: T002 and T003 can run in parallel (after T001 completes)
- Phase 5–8: T007, T008, T009, T010 can all run in parallel (they depend on Phase 2–4 but not on each other)
- Phase 10: All unit test tasks (T012–T018) can run in parallel

**Critical path**:
T001 → T002/T003 → T004 → T005 → T006 → T007/T008/T009/T010 (parallel) → T011 → T019 → T020

---

## Story Coverage Matrix

| Story | Tasks |
|-------|-------|
| US1: Interactive init | T002, T003, T004, T005, T006, T009, T010, T011, T012, T013, T014, T017, T018, T019 |
| US2: Non-interactive init | T003, T006, T009, T011, T014, T019 |
| US3: Existing project linking | T006, T011 (deferred — API stubs only, per plan) |
| US4: GitHub validation | T007, T011, T015 |
| US5: File conflict handling | T008, T011, T016, T019 |
| INFRA: Setup & build | T001, T002, T003, T020 |
