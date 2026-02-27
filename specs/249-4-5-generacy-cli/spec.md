# Feature Specification: 4.5 — Generacy CLI: `generacy init`

**Branch**: `249-4-5-generacy-cli` | **Date**: 2026-02-27 | **Status**: Draft

## Summary

The `generacy init` command provides an interactive CLI-based project setup flow as an alternative to the web-based onboarding PR. Running `generacy init` inside a Git repository scaffolds `.generacy/`, `.devcontainer/`, and `.vscode/` directories with the same files produced by the onboarding PR, using the existing `@generacy-ai/templates` package. The command supports both interactive prompts and non-interactive (flag-driven) usage, validates GitHub access, and optionally creates a new project via the Generacy API.

### Dependencies

- **4.1** (#247) — Onboarding PR template content (`@generacy-ai/templates` package)
- **4.2** (#248) — `.generacy/config.yaml` schema (config loader + Zod validation)

### Plan Reference

[onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md) — Issue 4.5

---

## User Stories

### US1: Interactive Project Initialization

**As a** developer setting up Generacy in an existing repository,
**I want** to run `generacy init` and answer interactive prompts,
**So that** I can scaffold the required configuration and devcontainer files without leaving the terminal.

**Acceptance Criteria**:
- [ ] Running `generacy init` in a Git repository launches an interactive prompt flow
- [ ] Prompts collect: project name, primary repo, optional dev/clone repos, agent preference, and base branch
- [ ] Generated files match the output of the onboarding PR for identical inputs
- [ ] Generated `.generacy/config.yaml` passes `generacy validate`
- [ ] A summary of created files is printed on completion

### US2: Non-Interactive Project Initialization

**As a** developer scripting project setup or using CI,
**I want** to pass all required values as CLI flags,
**So that** I can automate `generacy init` without interactive prompts.

**Acceptance Criteria**:
- [ ] All interactive prompts can be bypassed with corresponding CLI flags
- [ ] `generacy init --project-name "My App" --primary-repo "github.com/acme/app"` runs without prompts
- [ ] Missing required values in non-interactive mode produce clear error messages and exit code 1
- [ ] A `--yes` / `-y` flag accepts all defaults without prompting

### US3: Existing Project Linking

**As a** developer joining an existing Generacy project,
**I want** to run `generacy init --project-id proj_abc123` to link my local repo,
**So that** I can scaffold files for a project that was already created via the web UI.

**Acceptance Criteria**:
- [ ] `--project-id` fetches project details from the Generacy API
- [ ] Fetched project name and repo configuration are used to populate templates
- [ ] If the API is unreachable or the project ID is invalid, a clear error is shown
- [ ] The user is prompted to confirm fetched details before files are written

### US4: GitHub Access Validation

**As a** developer initializing a project,
**I want** `generacy init` to validate that I have access to the specified GitHub repositories,
**So that** I catch permission issues before they cause problems later.

**Acceptance Criteria**:
- [ ] The command checks GitHub API access for the primary repo (and dev/clone repos if specified)
- [ ] Missing or expired GitHub credentials produce an actionable error message
- [ ] Insufficient repository permissions (e.g., no write access) produce a warning
- [ ] Validation can be skipped with `--skip-github-check`

### US5: Safe File Conflict Handling

**As a** developer re-running `generacy init` in a previously initialized repo,
**I want** to be warned about existing files before they are overwritten,
**So that** I do not accidentally lose local modifications.

**Acceptance Criteria**:
- [ ] If any target file already exists, the user is prompted per file (overwrite / skip / diff)
- [ ] `--force` flag overwrites all existing files without prompting
- [ ] `.vscode/extensions.json` is smart-merged (existing recommendations preserved) rather than overwritten
- [ ] Skipped files are listed in the completion summary

---

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Register `init` subcommand in the existing Commander.js CLI (`src/cli/index.ts`) | P1 | Follows patterns of existing commands (`validate`, `run`, `doctor`) |
| FR-002 | Detect current Git repository root and abort with error if not inside a repo | P1 | Use `git rev-parse --show-toplevel` or equivalent |
| FR-003 | Interactive prompt flow collecting: project name, primary repo (`owner/repo`), optional dev repos, optional clone repos, agent, base branch | P1 | Use inquirer or prompts library consistent with existing CLI |
| FR-004 | Accept CLI flags for all prompted values: `--project-id`, `--project-name`, `--primary-repo`, `--dev-repo` (repeatable), `--clone-repo` (repeatable), `--agent`, `--base-branch` | P1 | Flags take precedence over prompts |
| FR-005 | Auto-detect primary repo from Git remote (`origin`) if not specified | P2 | Parse `git remote get-url origin` into `github.com/owner/repo` format |
| FR-006 | Detect single-repo vs multi-repo based on whether dev/clone repos are provided | P1 | Determines which template context builder to use |
| FR-007 | Build template context using `buildSingleRepoContext()` or `buildMultiRepoContext()` from `@generacy-ai/templates` | P1 | Pass collected values as template context options |
| FR-008 | Render all project files using `renderProject(context)` | P1 | Returns `Map<string, string>` of relative paths to file contents |
| FR-009 | Write rendered files to disk relative to Git repo root | P1 | Create directories recursively with `mkdir -p` semantics |
| FR-010 | Conflict detection: check for existing files before writing | P1 | Prompt per-file unless `--force` is set |
| FR-011 | Smart merge for `.vscode/extensions.json` — union existing and generated recommendations | P2 | Use existing merge logic from `@generacy-ai/templates` |
| FR-012 | Post-generation validation: load and validate the generated config via `loadConfig()` | P1 | Catches template rendering issues immediately |
| FR-013 | Print summary table of created/skipped/merged files on completion | P1 | Clear visual feedback |
| FR-014 | Print "next steps" guidance after successful init | P2 | e.g., "Run `generacy doctor` to verify system requirements" |
| FR-015 | Validate GitHub access for specified repos via GitHub API | P2 | Check read/write permissions; warn on issues |
| FR-016 | `--skip-github-check` flag to bypass GitHub validation | P2 | For offline or air-gapped environments |
| FR-017 | `--project-id` flag to fetch existing project from Generacy API | P2 | Populates template context from server-side project |
| FR-018 | Create new project via Generacy API when no `--project-id` is given | P3 | Requires API authentication; returns server-issued `proj_` ID |
| FR-019 | `--dry-run` flag to preview files without writing them | P2 | Print file paths and sizes that would be created |
| FR-020 | `--yes` / `-y` flag to accept all defaults without prompting | P2 | For scripted/CI usage |
| FR-021 | Exit codes: 0 (success), 1 (user error / validation failure), 2 (API error), 130 (user cancelled) | P1 | Consistent with `generacy validate` exit code conventions |

---

## Generated Files

The following files are produced, matching the onboarding PR output:

### All projects

| File | Description |
|------|-------------|
| `.generacy/config.yaml` | Project configuration (schema version 1) |
| `.generacy/generacy.env.template` | Environment variable template |
| `.generacy/.gitignore` | Ignores `generacy.env` and `.agent-state/` |
| `.vscode/extensions.json` | VS Code extension recommendations (smart-merged) |

### Single-repo projects

| File | Description |
|------|-------------|
| `.devcontainer/devcontainer.json` | Dev container with Generacy feature reference |

### Multi-repo projects

| File | Description |
|------|-------------|
| `.devcontainer/devcontainer.json` | Docker Compose-based dev container |
| `.devcontainer/docker-compose.yml` | Orchestrator + workers + Redis |

---

## CLI Interface

```
generacy init [options]

Options:
  --project-id <id>         Link to existing project (proj_xxx format)
  --project-name <name>     Project display name
  --primary-repo <repo>     Primary repository (github.com/owner/repo)
  --dev-repo <repo>         Dev repository (repeatable)
  --clone-repo <repo>       Clone repository (repeatable)
  --agent <agent>           Default agent (default: claude-code)
  --base-branch <branch>    Default base branch (default: main)
  --force                   Overwrite existing files without prompting
  --dry-run                 Preview files without writing
  --skip-github-check       Skip GitHub access validation
  -y, --yes                 Accept defaults without prompting
  -v, --verbose             Verbose output
```

### Example Usage

```bash
# Interactive — prompts for all values
generacy init

# Non-interactive — single repo
generacy init --project-name "My API" --primary-repo "github.com/acme/api" -y

# Link to existing project
generacy init --project-id proj_abc123xyz

# Multi-repo setup
generacy init \
  --project-name "Platform" \
  --primary-repo "github.com/acme/api" \
  --dev-repo "github.com/acme/shared-lib" \
  --clone-repo "github.com/acme/design-system" \
  -y

# Preview without writing
generacy init --dry-run
```

---

## Command Flow

```
generacy init
    │
    ├─ 1. Verify inside a Git repository
    │     └─ Abort with error if not in a Git repo
    │
    ├─ 2. Collect project details (interactive or flags)
    │     ├─ Project ID (existing) or project name (new)
    │     ├─ Primary repo (auto-detect from git remote or prompt)
    │     ├─ Dev repos (optional, repeatable)
    │     ├─ Clone repos (optional, repeatable)
    │     ├─ Default agent (default: claude-code)
    │     └─ Default base branch (default: main)
    │
    ├─ 3. Validate GitHub access (unless --skip-github-check)
    │     ├─ Check credentials exist
    │     └─ Verify repo permissions (warn if insufficient)
    │
    ├─ 4. Resolve project ID
    │     ├─ If --project-id: fetch from API, confirm details
    │     └─ If new: optionally create via API (or generate placeholder)
    │
    ├─ 5. Build template context
    │     ├─ Single-repo: buildSingleRepoContext()
    │     └─ Multi-repo: buildMultiRepoContext()
    │
    ├─ 6. Render templates
    │     └─ renderProject(context) → Map<path, content>
    │
    ├─ 7. Handle file conflicts
    │     ├─ Check for existing files
    │     ├─ Prompt per-file (overwrite / skip / diff) unless --force
    │     └─ Smart-merge .vscode/extensions.json
    │
    ├─ 8. Write files to disk (or preview if --dry-run)
    │
    ├─ 9. Post-generation validation
    │     └─ loadConfig() to verify generated config
    │
    └─ 10. Print summary and next steps
```

---

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | File parity with onboarding PR | 100% — identical file content for identical inputs | Diff generated files against onboarding PR output for same project config |
| SC-002 | Generated config validation | 100% pass rate — all generated configs pass `generacy validate` | Run `generacy validate` after every `generacy init` in tests |
| SC-003 | Non-interactive completeness | All values passable via flags | Unit test that runs `generacy init` with all flags, no TTY required |
| SC-004 | Error handling coverage | All error paths produce actionable messages with correct exit codes | Unit tests for: no git repo, invalid project ID, API unreachable, invalid repo format |
| SC-005 | Conflict handling | No silent overwrites | Integration test: init twice, verify prompt on second run; verify --force skips prompt |

---

## Assumptions

- The `@generacy-ai/templates` package is published and importable within the CLI package
- The config schema (v1) and template context interfaces are stable and will not change during implementation
- GitHub API access uses the user's existing `gh` CLI authentication or a `GITHUB_TOKEN` environment variable
- The Generacy API endpoint for project creation/lookup is available (or can be stubbed for initial implementation)
- The CLI runs in a Node.js environment with filesystem write access
- Commander.js remains the CLI framework (consistent with existing commands)

## Out of Scope

- **Web-based onboarding flow** — handled by a separate service, not this CLI command
- **Dev container feature publishing** — tracked in issue #252
- **`generacy update` command** — re-scaffolding with updated templates is a future feature
- **Monorepo detection** — automatic detection of monorepo structures (e.g., Nx, Turborepo) is not included; users specify repos explicitly
- **Custom template overrides** — user-provided template customization (e.g., additional Dockerfile layers) is deferred
- **GitHub App installation** — the command validates access but does not install or configure the Generacy GitHub App
- **IDE extension integration** — the command writes `.vscode/extensions.json` but does not trigger extension installation

---

*Generated by speckit*
