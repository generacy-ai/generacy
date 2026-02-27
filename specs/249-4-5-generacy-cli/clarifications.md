# Clarification Questions

## Status: Resolved

## Questions

### Q1: Interactive Prompt Library
**Context**: No interactive prompt library (inquirer, prompts, @inquirer/prompts, etc.) is currently used anywhere in the CLI package. A library must be added for the interactive flow. The choice affects bundle size, ESM compatibility, and the style of prompt UX available (e.g., autocomplete, multi-select).
**Question**: Which interactive prompt library should be used for the `generacy init` interactive flow?
**Options**:
- A) `@inquirer/prompts`: Modern ESM-native rewrite of inquirer. Modular (import only what you use), well-maintained, good TypeScript support. ~30KB per prompt type.
- B) `prompts`: Lightweight (~15KB), zero-dependency, simple API. Less feature-rich but sufficient for basic text/select/confirm prompts.
- C) `@clack/prompts`: Opinionated "beautiful CLI" library with spinner, group prompts, and styled output. Used by create-next-app. Provides a polished UX out of the box.
**Answer**: **C) `@clack/prompts`** — `generacy init` is the first interactive touchpoint for new developers onboarding. A polished UX matters here. `@clack/prompts` provides styled output, spinners, and grouped prompts out of the box — the kind of experience create-next-app delivers. The CLI is currently headless (Commander.js only), so this is a fresh addition either way. `@clack/prompts` is lightweight, ESM-compatible, and its opinionated design means less custom styling code.

---

### Q2: Project ID Generation for New Projects
**Context**: The template context builders (`buildSingleRepoContext`, `buildMultiRepoContext`) require a `projectId` string (e.g., `proj_abc123`). The spec says FR-018 (P3) optionally creates a project via the Generacy API to get a server-issued ID. However, when the API is unavailable or the user opts out, the command still needs a project ID to write valid config files. The spec mentions "generate placeholder" but doesn't define the format or strategy.
**Question**: What should `generacy init` use as the project ID when the Generacy API is not called (no `--project-id` and API creation is skipped)?
**Options**:
- A) Generate a local placeholder ID (e.g., `proj_local_<random>`): Config files are valid immediately but will need updating when the project is registered with the API later.
- B) Prompt the user to provide a project ID or authenticate: Require either a `--project-id` flag or API authentication so that a real ID is always used.
- C) Use a deterministic ID derived from repo name (e.g., `proj_<hash(owner/repo)>`): Reproducible across runs but may conflict with server-issued IDs.
**Answer**: **A) Generate a local placeholder ID (`proj_local_<random>`)** — The template schema requires `^proj_[a-z0-9]+$` with min 12 chars. A local placeholder like `proj_local_a1b2c3d4` satisfies validation immediately, and config files are valid without an API call. The CLI should work fully offline. The config file can be updated with a real server-issued ID later (via `generacy init --project-id` or when API integration lands). This aligns with the plan's P3 priority for API creation (FR-018).

---

### Q3: Generacy API Authentication
**Context**: FR-017 (fetch project by ID) and FR-018 (create project) both require authenticated calls to the Generacy API. No Generacy API client currently exists in the CLI package — only GitHub API clients exist in the `github-issues` package. The spec does not define how users authenticate with the Generacy platform, what the API base URL is, or how credentials are stored/discovered.
**Question**: How should `generacy init` authenticate with the Generacy API for project creation and lookup?
**Options**:
- A) API key via environment variable (e.g., `GENERACY_API_KEY`): Simple, works in CI, consistent with how `GITHUB_TOKEN` is handled today.
- B) OAuth/browser-based login flow (e.g., `generacy login` as a prerequisite): More secure, better UX for interactive use, but requires a separate auth command.
- C) Defer API integration entirely for initial implementation: Stub the API calls, implement only offline/local init first, and add API integration as a follow-up.
**Answer**: **C) Defer API integration entirely** — The generacy-cloud API endpoints for project management (Epic 3, issue 3.7) don't exist yet, and the CLI init (4.5) is blocked only on templates (4.1) and config schema (4.2) — not on cloud infrastructure. Stubbing the API calls and implementing offline/local init first lets this issue proceed without blocking on Epics 2-3. API integration can be added as a follow-up once the cloud endpoints, GitHub App auth (2.2), and web interface (3.x) are in place.

---

### Q4: Repo Format — CLI Flags vs Template Context
**Context**: The spec says the `--primary-repo` flag accepts `github.com/owner/repo` format, but the `@generacy-ai/templates` context builders and schemas expect `owner/repo` shorthand format (validated by regex `^[\w.-]+\/[\w.-]+$`). The auto-detect from `git remote get-url origin` would return a full URL like `https://github.com/owner/repo.git` or `git@github.com:owner/repo.git`. The spec needs to clarify the expected input format and any normalization.
**Question**: What format should `--primary-repo` (and `--dev-repo`, `--clone-repo`) accept, and should the CLI normalize input?
**Options**:
- A) Accept `owner/repo` shorthand only: Matches template schemas directly, simplest to implement, but users must know the expected format.
- B) Accept multiple formats and normalize: Accept `github.com/owner/repo`, `https://github.com/owner/repo.git`, `git@github.com:owner/repo.git`, and `owner/repo` — normalize all to `owner/repo` for templates.
- C) Accept `github.com/owner/repo` as specified: Matches the spec's CLI example but requires stripping the domain prefix before passing to templates.
**Answer**: **B) Accept multiple formats and normalize** — The CLI will auto-detect repos from `git remote get-url origin`, which returns URLs like `https://github.com/owner/repo.git` or `git@github.com:owner/repo.git`. Users may also type `owner/repo` or `github.com/owner/repo`. The CLI should normalize all of these to `owner/repo` for the templates package (which validates `^[\w.-]+\/[\w.-]+$`) and to `github.com/owner/repo` for config.yaml (which validates `^github\.com\/...`). This format gap already exists between the two packages — the CLI is the natural place to bridge it.

---

### Q5: GitHub Credential Discovery
**Context**: US4 requires validating GitHub access for specified repos. The spec's Assumptions section mentions "existing `gh` CLI authentication or a `GITHUB_TOKEN` environment variable" but doesn't specify the priority order or what happens when neither is available. The existing `github-issues` package uses Octokit with `GITHUB_TOKEN` or GitHub App auth — the `gh` CLI pattern would be new.
**Question**: What is the priority order for discovering GitHub credentials, and should `gh` CLI auth be supported?
**Options**:
- A) `GITHUB_TOKEN` env var only: Simplest, consistent with existing patterns in `github-issues` package, works in CI.
- B) `GITHUB_TOKEN` env var, then `gh auth token` fallback: Convenient for developers who use the `gh` CLI, broader compatibility.
- C) `GITHUB_TOKEN`, then `gh auth token`, then `.generacy/generacy.env` file: Also checks the local env file that `generacy init` itself generates, creating a self-bootstrapping flow.
**Answer**: **B) `GITHUB_TOKEN` env var, then `gh auth token` fallback** — `GITHUB_TOKEN` first maintains consistency with the existing `github-issues` package and works in CI. Falling back to `gh auth token` is convenient for developers who already use the GitHub CLI (which is installed by the Dev Container Feature). The buildout plan's assumptions section explicitly mentions both. Option C creates a chicken-and-egg problem — `generacy init` generates the env file, so it can't rely on it during init.

---

### Q6: Release Stream Prompt
**Context**: The `@generacy-ai/templates` builders accept a `releaseStream` option (`'stable'` | `'preview'`) which determines the Dev Container Feature tag (`:1` for stable, `:preview` for preview). However, the spec's CLI interface and prompt flow do not mention `releaseStream` as a prompted value or CLI flag — only `--agent` and `--base-branch` are listed as defaults. This means users would always get the `stable` default with no way to choose `preview`.
**Question**: Should `generacy init` expose the release stream as a prompt/flag, or always default to `stable`?
**Options**:
- A) Always default to `stable`, no prompt or flag: Simplest UX, `preview` can be set by editing config later. Most users should use stable.
- B) Add `--release-stream` flag but don't prompt interactively: Power users can opt into preview via flag, but the interactive flow stays simple.
- C) Include release stream in both interactive prompts and as a `--release-stream` flag: Full parity with template capabilities, but adds cognitive load to the prompt flow.
**Answer**: **B) Add `--release-stream` flag but don't prompt interactively** — The plan states `:preview` is for early adopters and `:1` (stable) is for production. Most users should get stable by default. A `--release-stream preview` flag gives power users and internal developers an opt-in without adding cognitive load to the interactive flow. This matches the templates package which already supports the `releaseStream` option in builders.

---

### Q7: Diff Display for File Conflicts
**Context**: US5 acceptance criteria state that when existing files are found, the user is prompted with "overwrite / skip / diff" options per file. The "diff" option implies showing a comparison between the existing file and the generated file, but the spec doesn't define how this diff should be displayed (inline terminal diff, side-by-side, external diff tool, etc.) or what happens after viewing the diff.
**Question**: How should the "diff" option in file conflict resolution be implemented?
**Options**:
- A) Show inline unified diff in terminal (like `git diff`): No external dependencies, works everywhere, familiar format.
- B) Show inline diff, then re-prompt with overwrite/skip: User sees the diff and then decides what to do with that specific file.
- C) Open in external diff tool (`$DIFFTOOL` or `code --diff`): Better for large files but requires tool availability and may not work in CI/headless environments.
**Answer**: **B) Show inline unified diff, then re-prompt with overwrite/skip** — Showing the diff alone (option A) leaves the user in limbo. Option B lets the user inspect the changes and then make an informed decision for that specific file. This is the pattern used by tools like `npm init` and package manager conflict resolution. An inline unified diff (like `git diff`) needs no external dependencies and works in all environments including headless/CI.

---

### Q8: `--yes` Flag Behavior with Missing Required Values
**Context**: FR-020 specifies that `--yes` / `-y` "accepts all defaults without prompting." However, some values have no sensible default — specifically `project name` when it can't be inferred. The spec doesn't clarify whether `--yes` should fail if required values can't be defaulted, or if it should use auto-detected values (e.g., derive project name from the repo name or directory name).
**Question**: When `--yes` is used without explicit flags, how should missing values with no preset default be handled?
**Options**:
- A) Auto-derive from context: Use directory name for project name, `origin` remote for primary repo. Fail only if auto-detection is impossible (e.g., no git remote).
- B) Fail with clear error listing missing required values: Require explicit flags for any value that can't be defaulted. `--yes` only skips confirmation prompts, not data-collection prompts.
- C) Use auto-derived values but print a warning: Proceed with best-guess values and clearly show what was assumed, so the user can re-run with explicit flags if needed.
**Answer**: **C) Auto-derive values but print a warning** — The CLI can infer project name from the directory name and primary repo from the `origin` git remote. With `--yes`, proceed with these best-guess values but clearly print what was assumed (e.g., "Using project name: my-app (from directory name)"). Fail only if auto-detection is truly impossible (no git remote, not in a git repo). This is the pattern used by `npm init -y` — reasonable defaults with visibility.

---

### Q9: Multi-Repo Orchestrator Settings in Interactive Flow
**Context**: When a multi-repo project is detected (dev repos are provided), the templates require `workerCount` and `pollIntervalMs` orchestrator settings. The spec's interactive prompt flow (Step 2 in Command Flow) does not mention prompting for these values. The builders default to `workerCount: 2` and `pollIntervalMs: 5000`. The spec also does not list `--worker-count` or `--poll-interval` as CLI flags.
**Question**: Should orchestrator settings (`workerCount`, `pollIntervalMs`) be configurable during `generacy init`?
**Options**:
- A) Always use defaults (2 workers, 5000ms poll): Keep the init flow simple; users can edit `config.yaml` or `docker-compose.yml` afterward.
- B) Add CLI flags but don't prompt interactively: `--worker-count` and `--poll-interval` for advanced users, defaults for everyone else.
- C) Prompt interactively for worker count only (skip poll interval): Worker count is the most impactful setting and worth asking about; poll interval is too technical for most users.
**Answer**: **A) Always use defaults (2 workers, 5000ms poll)** — These are advanced operational settings that most users won't understand during initial setup. The defaults are sensible and already validated by the template schema (workerCount: 1-20, pollIntervalMs: min 5000). Users can edit `config.yaml` or `docker-compose.yml` after init. This keeps the interactive flow focused on project identity and repo topology — the decisions that actually matter during onboarding.

---

### Q10: Post-Init API Project Creation Confirmation
**Context**: FR-018 (P3) says "Create new project via Generacy API when no `--project-id` is given." This is an API call that creates a server-side resource, which is a side effect beyond local file generation. The spec doesn't clarify whether the user should be asked before this API call is made, or whether it should happen automatically as part of the init flow.
**Question**: Should `generacy init` prompt for confirmation before creating a project via the Generacy API?
**Options**:
- A) Always prompt before API creation: "Would you like to register this project with Generacy? (Y/n)" — safe default, user stays in control.
- B) Create automatically unless `--no-api` flag is passed: Streamlined flow, most users want API registration. Opt-out for offline use.
- C) Skip API creation by default, offer `--register` flag to opt in: Local-first approach; API registration is a separate conscious step.
**Answer**: **A) Always prompt before API creation** — Creating a server-side resource is a meaningful side effect. The user should explicitly opt in: "Would you like to register this project with Generacy? (Y/n)". This is consistent with the local-first philosophy (Q3 defers API entirely for now) and respects users who may be evaluating the tool or working offline. When API integration is added later, this prompt is the natural place to insert it.

---

### Q11: Existing Config Detection Before Init
**Context**: The spec covers file conflict handling (US5) but doesn't address the scenario where a valid `.generacy/config.yaml` already exists and `generacy init` is run. This is different from file-level conflicts — it's a project-level question of whether the user intends to re-initialize (overwrite config) or update (merge changes). Running init on an already-initialized project could also mean the project is already registered with the API.
**Question**: When `.generacy/config.yaml` already exists and is valid, what should `generacy init` do before proceeding?
**Options**:
- A) Show a warning and prompt to continue: "This project appears to be already initialized. Continue? (y/N)" — then proceed to file conflict handling as normal.
- B) Load existing config and offer to update specific fields: Present current values as defaults in the interactive flow, allowing selective updates.
- C) Treat it identically to any other file conflict: No special behavior — the per-file overwrite/skip/diff prompt handles it like all other generated files.
**Answer**: **B) Load existing config and offer to update specific fields** — If `.generacy/config.yaml` already exists and is valid, the user is re-initializing — likely to change a setting, add repos, or update after a team change. Loading existing values as defaults in the interactive flow (pre-filling project name, repos, etc.) is the most useful behavior. The user sees their current config and can selectively update. This is more intentional than a blanket "continue?" warning (A) and more semantic than treating config as just another file conflict (C).

---

### Q12: Base Image Selection
**Context**: The `@generacy-ai/templates` schema supports a configurable `baseImage` for the dev container (default: `mcr.microsoft.com/devcontainers/base:ubuntu`). The spec does not mention exposing base image selection in the interactive flow or as a CLI flag. Language-specific base images (e.g., `mcr.microsoft.com/devcontainers/python:3.11`) could be valuable but add complexity.
**Question**: Should `generacy init` allow users to select or specify a dev container base image?
**Options**:
- A) Always use the default base image: Keep the flow simple; advanced users can edit `devcontainer.json` after init.
- B) Add `--base-image` flag but don't prompt interactively: Power users can customize via flag, no added complexity to the interactive flow.
- C) Add both interactive prompt and `--base-image` flag: Offer a curated list of common images (Ubuntu, Node, Python, Go) during interactive setup.
**Answer**: **A) Always use the default base image** — The default (`mcr.microsoft.com/devcontainers/base:ubuntu`) is language-agnostic by design — the buildout plan explicitly says "Language-agnostic base (works with any stack)" for template content (4.1). The Dev Container Feature installs Node.js, GitHub CLI, Claude Code, Generacy CLI, and Agency MCP regardless of the base image. Advanced users who need a language-specific image can edit `devcontainer.json` after init. Adding base image selection to the flow adds complexity with little payoff for the typical onboarding case.
