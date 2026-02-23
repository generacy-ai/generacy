# Clarification Questions

## Status: Pending

## Questions

### Q1: Agency Package Reference
**Context**: The spec references `@generacy-ai/agency` as an MCP server to install globally, but the project's packages directory has no `agency` package. The closest match is `@generacy-ai/orchestrator` or possibly an external package not in this repo. If `@generacy-ai/agency` doesn't exist on npm, the install script will fail.
**Question**: Does the `@generacy-ai/agency` npm package exist, or should the feature install a different package? If it doesn't exist yet, should the feature be built to gracefully handle a missing package, or should we wait for that package to be published first?
**Options**:
- A) Package exists externally: `@generacy-ai/agency` is published separately outside this monorepo — proceed as specified
- B) Use a different package name: The correct package name is something else (please specify)
- C) Graceful fallback: Install if available on npm, warn and continue if not found
- D) Defer Agency support: Ship the feature without Agency support initially and add it when the package is published
**Answer**:

### Q2: Claude Code Installation Method
**Context**: The spec says to use "the official installer" at `https://claude.ai/install.sh` for Claude Code. Claude Code's installation method may vary (npm package `@anthropic-ai/claude-code`, direct binary download, or a shell installer script). The exact URL and mechanism need to be confirmed to write a reliable install script. Using an unverified URL risks breakage.
**Question**: What is the exact installation method for Claude Code? Is it an npm global install (`npm install -g @anthropic-ai/claude-code`), a shell script (`curl -fsSL https://claude.ai/install.sh | sh`), or something else?
**Options**:
- A) npm global install: `npm install -g @anthropic-ai/claude-code` — simplest, consistent with other tool installs
- B) Official shell installer: Use `curl -fsSL <URL> | sh` with a confirmed URL
- C) Direct binary download: Download a prebuilt binary from a release page
**Answer**:

### Q3: Non-Root User Detection Fallback
**Context**: The spec says Claude Code must be installed in a non-root user context using `$_REMOTE_USER` with a "fallback." Dev Container Features run as root, but Claude Code may need to be installed as the container user. If `$_REMOTE_USER` is unset (e.g., in minimal images or custom Dockerfiles), the script needs a reliable fallback strategy.
**Question**: What should the fallback be when `$_REMOTE_USER` is not set? Should we default to a specific user, scan `/home/` for the first non-root user, or fail with an error?
**Options**:
- A) Default to `vscode`: Most devcontainer base images create a `vscode` user — use that as fallback
- B) Scan for first non-root user: Check `/home/` for the first available user directory
- C) Fall back to `root`: Install as root if no non-root user is detected
- D) Fail with error: Require `$_REMOTE_USER` to be set; error out with a helpful message if missing
**Answer**:

### Q4: Agency Version Coupling
**Context**: FR-006 says Agency should use "the same version as generacy package," but the `version` option controls the `@generacy-ai/generacy` version. If these are independent packages, their version numbers may not be in sync. Installing `@generacy-ai/agency@1.2.3` when only `@generacy-ai/generacy@1.2.3` was specified could fail if Agency hasn't published that exact version.
**Question**: Should Agency always use the exact same version as the Generacy package, should it have its own version option, or should it always install `latest`?
**Options**:
- A) Same version: Use `$VERSION` for both packages — assume versions are kept in sync
- B) Separate option: Add an `agencyVersion` option to `devcontainer-feature.json`
- C) Always latest: Agency always installs `latest` regardless of the generacy version
**Answer**:

### Q5: Node.js Installation Method
**Context**: The spec says to use NodeSource for Node.js installation, but NodeSource changed their distribution model in 2023-2024, requiring authentication for some versions and deprecating their setup scripts. The `ghcr.io/devcontainers/features/node` feature is the standard devcontainer way to install Node.js. Using NodeSource directly may be unreliable.
**Question**: Should the install script use NodeSource's setup script directly, or use a more reliable method like `nvm`, the official devcontainers node feature helper scripts, or download Node.js binaries directly?
**Options**:
- A) NodeSource as specified: Use NodeSource setup script per the spec, accepting potential reliability issues
- B) nvm: Install via nvm which is well-maintained and commonly used in devcontainers
- C) Direct binary download: Download Node.js binaries from `nodejs.org` directly
- D) Devcontainer library scripts: Use the shared devcontainer scripts from `devcontainers/features` for consistency
**Answer**:

### Q6: Workspace Integration
**Context**: The spec says the feature package is "standalone and not part of the pnpm workspace build," and the current `pnpm-workspace.yaml` uses `packages/*` glob. Adding `packages/devcontainer-feature/` will automatically include it in the workspace, potentially causing issues since it has no `package.json` typical of a Node.js package (it's a shell-based dev container feature).
**Question**: Should the devcontainer-feature directory be excluded from the pnpm workspace, placed outside `packages/`, or given a minimal `package.json` for workspace compatibility?
**Options**:
- A) Exclude from workspace: Add `!packages/devcontainer-feature` to `pnpm-workspace.yaml`
- B) Move outside packages: Place at repo root (e.g., `devcontainer-feature/` or `.devcontainer-feature/`)
- C) Minimal package.json: Add a `package.json` with `"private": true` so pnpm treats it as a workspace member without issues
**Answer**:

### Q7: GitHub Actions Workflow Location
**Context**: The spec places the workflow at `.github/workflows/publish-devcontainer-feature.yml`, but no `.github/workflows/` directory exists in this repo. The spec's "Related" section references `generacy-ai/tetrad-development#6`, suggesting this feature may be part of a broader infrastructure refactor. The workflow needs to be in the correct repository to trigger on tag pushes.
**Question**: Should the GitHub Actions workflow be created in this repository (`generacy-ai/generacy`), or does it belong in the `tetrad-development` repo or another infrastructure repo? Also, should we create the `.github/workflows/` directory as part of this feature?
**Options**:
- A) This repo: Create `.github/workflows/` in `generacy-ai/generacy` — the feature source lives here so the workflow should too
- B) tetrad-development repo: The workflow belongs in the infrastructure repo alongside other CI/CD configuration
- C) Defer workflow: Create the feature files only; workflow creation is a separate task
**Answer**:

### Q8: Existing Node.js Version Mismatch
**Context**: US3 says "existing installations are not overwritten or downgraded," but what if the base image has Node.js 18 and the developer specifies `nodeVersion: 22`? The spec says skip if `node` is on PATH, but doesn't address version mismatches. This could leave developers with an unexpected Node.js version.
**Question**: If Node.js is already installed but at a different major version than `nodeVersion`, should the feature skip installation (current behavior per spec), warn but skip, upgrade to the requested version, or fail with an error?
**Options**:
- A) Skip silently: If any Node.js is present, skip — match the current spec behavior exactly
- B) Warn and skip: Print a warning about the version mismatch but don't install
- C) Install requested version: Install the specified version alongside (or replacing) the existing one
- D) Fail with error: Error out if the existing version doesn't match, forcing the user to resolve the conflict
**Answer**:

### Q9: Error Handling and Logging
**Context**: The spec says `set -e` and "exit 1 with descriptive error if any check fails" but doesn't specify logging behavior during installation. Dev container feature installs can be opaque — if something fails, developers see a generic build error. Good logging is critical for debugging onboarding issues with external developers.
**Question**: What level of logging should the install script provide? Should it be verbose by default (showing each step), quiet (only errors), or should there be a `verbose` option?
**Options**:
- A) Verbose by default: Echo each major step (e.g., "Installing Node.js 22...", "Skipping GitHub CLI (already installed)") — best for debugging
- B) Quiet by default with verbose option: Minimal output normally, add a `verbose` boolean option for troubleshooting
- C) Quiet by default: Only log errors — keeps build output clean
**Answer**:

### Q10: Feature Versioning Strategy
**Context**: The spec starts at version `0.1.0` and users reference the feature via `ghcr.io/generacy-ai/generacy/generacy:1`. The `:1` suggests semver major version pinning, but `0.x` versions are pre-1.0 and don't follow the same stability guarantees. The tag format `feature/v*` needs to map clearly to the published version.
**Question**: What is the versioning strategy? Should the initial publish be `0.1.0` (pre-release, breaking changes expected) or `1.0.0` (stable, matching the `:1` reference in the user story)? How do tag versions map to published versions?
**Options**:
- A) Start at 0.1.0: Pre-release; users reference `:0` — update US1 acceptance criteria to use `:0` instead of `:1`
- B) Start at 1.0.0: Ship as stable from the start; tag `feature/v1.0.0` publishes version `1.0.0`
- C) Start at 0.1.0 but reference as `:latest`: Use `:latest` tag in examples until 1.0.0 is reached
**Answer**:

### Q11: Claude Code Install Script URL Stability
**Context**: The spec assumes `https://claude.ai/install.sh` remains stable and available. If this URL changes or becomes unavailable, every new dev container build will fail. There's no fallback mechanism specified, and external developers would be blocked from onboarding.
**Question**: Should the install script include a fallback mechanism for Claude Code installation (e.g., try npm install if the shell script fails), or should it just fail and require users to set `installClaudeCode: false`?
**Options**:
- A) Single method, fail fast: Use one installation method; fail clearly if it's unavailable — keeps the script simple
- B) Fallback chain: Try the primary method, fall back to npm install, then fail — more resilient but more complex
- C) Version-pin the installer: Download a known-good version of the installer script and bundle it with the feature
**Answer**:

### Q12: Test Infrastructure for CI
**Context**: US5 requires tests that "can be run locally via `devcontainer features test`," which requires the `devcontainer` CLI. The spec doesn't mention whether tests should also run in CI (GitHub Actions) as a PR check. Without CI tests, regressions could be published.
**Question**: Should the feature include a CI workflow that runs `devcontainer features test` on PRs/pushes, or is local-only testing sufficient for the initial version?
**Options**:
- A) Local only initially: Tests exist for local runs only; CI testing is future work (per "Out of Scope" section)
- B) Add CI test workflow: Create a separate workflow that runs feature tests on PRs touching `packages/devcontainer-feature/`
- C) Combine with publish workflow: Add a test step to the publish workflow that runs before publishing
**Answer**:
