# Clarification Questions

## Status: Resolved

## Questions

### Q1: Default Repository List
**Context**: The spec references "8 default repos" multiple times (FR-005, env var table) but never enumerates them. The existing `setup-repos.sh` defines a specific list. The implementation needs to know the exact repos and their clone order (e.g., `tetrad-development` is cloned first in the current scripts).
**Question**: What are the 8 default repositories, and does clone order matter (e.g., should `tetrad-development` always be cloned first)?
**Options**:
- A) Hardcode the list in the command: Embed the repo names directly in `workspace.ts` as a constant array
- B) Load from a config file: Read the default list from a JSON/YAML file in `tetrad-development` (e.g., `.devcontainer/repos.json`)
- C) Define in `resolveConfig` defaults: Add the list to the existing config resolution pattern alongside other defaults
**Answer**: **C) Define in `resolveConfig` defaults.** The list is already enumerated in the issue body. The existing config pattern (defaults → env vars → CLI args) is the natural place. Clone order matters — `tetrad-development` first (the existing script does this explicitly), then the rest. The `resolveConfig` pattern keeps it discoverable and overridable via `REPOS` env var.

### Q2: Auth Credential Strategy Priority
**Context**: The spec says auth should use "gh auth setup-git OR writes ~/.git-credentials" (FR-003) but doesn't specify the decision logic. The existing `ensure-auth.sh` always writes `~/.git-credentials` with `credential.helper store` and separately checks `gh auth status`. These are two different credential mechanisms (git credential store vs gh CLI integration).
**Question**: Should the auth command prefer `gh auth setup-git` and only fall back to manual `.git-credentials`, or always set up both? What happens if `GH_TOKEN` is available but `gh auth login` fails?
**Options**:
- A) Prefer gh CLI, fallback to git-credentials: Try `gh auth setup-git` first; if it fails, write `~/.git-credentials` manually using `GH_TOKEN`
- B) Always set up both: Configure both `gh auth setup-git` and `~/.git-credentials` for maximum compatibility
- C) Match existing script behavior: Always write `~/.git-credentials` with `credential.helper store`, and separately run `gh auth login --with-token` if `GH_TOKEN` is set
**Answer**: **C) Match existing script behavior.** The existing scripts always write `~/.git-credentials` with `credential.helper store`, and separately handle `gh` auth (which auto-detects `GH_TOKEN` from the environment). This two-pronged approach is battle-tested. `gh auth setup-git` is used in `setup-repos.sh` as an additional layer, but `.git-credentials` is the primary mechanism.

### Q3: Auth Required vs Optional Fields
**Context**: The spec says `--email` and `--username` come from flags or env vars but doesn't specify whether they are required. The existing `ensure-auth.sh` silently skips git config if vars are unset and uses `git` as a fallback username for credentials. Should the TypeScript command enforce these or be lenient?
**Question**: Should `setup auth` fail if `--email` or `--username` (and their env var equivalents) are not provided, or should it continue with warnings/fallbacks?
**Options**:
- A) Require both: Exit with error if email or username cannot be resolved from flags or env vars
- B) Warn and continue: Log warnings for missing values but proceed with whatever is available (matching current script behavior)
- C) Require email, optional username: Email is needed for git commits; username can default to a placeholder
**Answer**: **B) Warn and continue.** Matches existing `ensure-auth.sh` behavior, which silently skips git config if vars are unset and uses `git` as a fallback username. In the dev container, these env vars are always injected via `agent.env`, so missing values signal a misconfigured environment — a warning is appropriate, but a hard failure would break flexibility for partial setups.

### Q4: Claude Plugin Cleanup Implementation
**Context**: Phase 1 of `setup build` cleans stale Claude plugin state. The existing `setup-plugins.sh` uses Python3 to manipulate `settings.json` (removing the `enabledPlugins` key). The spec's Assumptions section notes "Python3 is available... or this is reimplemented in Node.js" but doesn't decide.
**Question**: Should the Claude plugin cleanup be implemented in pure Node.js (JSON parse/modify/write) or continue using Python3 for JSON manipulation?
**Options**:
- A) Pure Node.js: Use `fs.readFileSync` + `JSON.parse` + `JSON.stringify` + `fs.writeFileSync` — no Python dependency needed
- B) Keep Python3: Shell out to `python3 -c` for JSON manipulation, matching current behavior
**Answer**: **A) Pure Node.js.** We're building a Node.js CLI. Using Python3 for JSON manipulation is an unnecessary external dependency. `JSON.parse` / `JSON.stringify` / `fs` is trivial and more portable. The whole point of this refactor is to reduce the bash/script surface area.

### Q5: Workspace Dependency Filter
**Context**: The existing `setup-plugins.sh` uses `pnpm install --filter "!@generacy-ai/generacy-plugin-claude-code"` when building Generacy, explicitly excluding a broken workspace dependency. The spec mentions "excluding claude-code plugin filter" in US3 but doesn't explain why or whether this is a permanent workaround or temporary.
**Question**: Is the `--filter "!@generacy-ai/generacy-plugin-claude-code"` exclusion a permanent architectural decision or a temporary workaround? Should the filter be hardcoded or configurable?
**Options**:
- A) Hardcode the filter: It's a known constraint; embed it directly in the build command
- B) Make it configurable: Add a `--exclude-packages` flag so filters can be adjusted without code changes
- C) Investigate and fix: The broken dependency should be fixed upstream, making the filter unnecessary
**Answer**: **A) Hardcode the filter.** It's a known, current constraint. Add a code comment noting it's a workaround for the `generacy-plugin-claude-code` package having unresolvable workspace dependencies. If/when that package is fixed, the filter gets removed in a single line. Making it configurable is over-engineering for a workaround.

### Q6: FIRESTORE_EMULATOR_HOST Conflict
**Context**: The service port table shows `FIRESTORE_EMULATOR_HOST` set to `127.0.0.1:8080` for Generacy and `127.0.0.1:8081` for Humancy. However, this is a single environment variable — it can only hold one value at a time. The existing scripts set it differently per service spawn, but if both APIs run in the same process tree, only one value persists.
**Question**: How should conflicting `FIRESTORE_EMULATOR_HOST` values be handled when both Generacy and Humancy services run simultaneously? Each API server child process needs a different value.
**Options**:
- A) Per-process env: Set the env var differently in each spawned child process's environment (not in the parent shell)
- B) Use prefixed env vars: Use `GENERACY_FIRESTORE_EMULATOR_HOST` and `HUMANCY_FIRESTORE_EMULATOR_HOST` and update API servers to read them
- C) Match existing scripts: Set the env var globally before starting each group of services (Generacy services first, then Humancy with overwritten value)
**Answer**: **A) Per-process env.** This is exactly what the existing script does — it sets env vars inline when spawning each API server process. In Node.js, this maps to setting `env` in `child_process.spawn()` options. Clean and correct.

### Q7: Health Check Implementation
**Context**: FR-016 says "Netcat or TCP connect checks" for service readiness. The spec doesn't specify whether to use the `nc` (netcat) binary (external dependency) or Node.js native `net.connect` (no dependency). The existing script uses `nc -z` which requires netcat to be installed.
**Question**: Should health checks use netcat (`nc -z`) via shell command or native Node.js `net.Socket.connect()` for TCP port checking?
**Options**:
- A) Node.js net.Socket: Use `net.createConnection()` for zero-dependency TCP checks — more portable and testable
- B) Netcat via shell: Use `nc -z` matching existing behavior — simpler but requires netcat installed
- C) HTTP fetch: Use `fetch()` against known health endpoints where available, falling back to TCP connect
**Answer**: **A) Node.js `net.Socket`.** Zero external dependencies, fully testable, and more portable. We're in a Node.js CLI — using `net.createConnection()` with a retry loop is straightforward and doesn't require netcat to be installed in every target container.

### Q8: Services Foreground vs Background Behavior
**Context**: The spec says `setup services` starts emulators and API servers but doesn't specify whether the command should block (foreground, waiting for all services) or return after startup (background). The existing script backgrounds processes with `&`. If foreground, the command holds the terminal; if background, there's no built-in way to stop services later.
**Question**: Should `generacy setup services` run in the foreground (blocking until SIGINT) or start services in the background and return?
**Options**:
- A) Foreground blocking: Command blocks and manages all child processes; SIGINT triggers graceful shutdown — simpler lifecycle management
- B) Background with PID file: Start services in background, write PIDs to a file, provide `generacy setup services --stop` to kill them
- C) Background fire-and-forget: Start services in background and return immediately; user manages processes manually (matching current scripts)
**Answer**: **C) Background fire-and-forget.** The entrypoint flow is sequential: `setup services` runs before `exec generacy orchestrator`. It must start services and return. The existing script does exactly this — backgrounds processes with `&`. The container's process lifecycle manages cleanup (container stop kills everything). PID files add complexity with no real benefit in a container context.

### Q9: Exec Utility Scope and Location
**Context**: The spec shows an `exec()` wrapper function for shell commands but doesn't specify where it should live. Multiple subcommands need shell execution (`auth`, `workspace`, `build`, `services`). The existing CLI has `execSync` usage directly in `job-handler.ts` without a shared utility.
**Question**: Should the shell execution utility (`exec`/`spawn` wrappers) be a shared module in `utils/`, local to the `setup/` directory, or inline in each command file?
**Options**:
- A) Shared in `utils/exec.ts`: Create a reusable utility alongside `utils/logger.ts` and `utils/config.ts` for use across the CLI
- B) Local to `setup/utils.ts`: Create a `setup/` scoped utility since only setup commands need it
- C) Inline per command: Each command file defines its own execution helpers — no shared abstraction
**Answer**: **A) Shared in `utils/exec.ts`.** Shell execution is a general-purpose utility. Putting it alongside `utils/logger.ts` and `utils/config.ts` is consistent with the existing project structure. Other CLI commands (beyond setup) may also need shell execution in the future. A shared utility avoids duplication across the 4 setup subcommands.

### Q10: Workspace Branch Fallback Behavior
**Context**: The existing `setup-repos.sh` handles the case where cloning with a specific branch fails by retrying without the branch flag (falling back to the repo's default branch). The spec doesn't mention this fallback. Some repos may not have the `develop` branch.
**Question**: If the specified branch (default `develop`) doesn't exist on a repository, should the command fail, fall back to the repo's default branch, or skip that repo?
**Options**:
- A) Fail the repo: Log an error for that repo and continue with others; include it in the failure summary
- B) Fall back to default branch: Clone without specifying a branch (use repo's default), log a warning
- C) Clone then attempt checkout: Clone the repo first, then try to checkout the branch; if branch doesn't exist, stay on default and warn
**Answer**: **B) Fall back to default branch.** This matches the existing `setup-repos.sh` behavior exactly: try the specified branch, fall back to cloning without `--branch` (repo's default HEAD), log a warning. Some repos legitimately may not have a `develop` branch.

### Q11: Build Artifact Verification Specifics
**Context**: FR-026 says "verifies critical artifacts exist after build" but doesn't list which artifacts or what to do on failure. The existing script checks for `packages/agency/dist/cli.js` and `packages/agency-plugin-spec-kit/dist/index.js`. Should verification failure be a hard error or a warning?
**Question**: Which specific artifacts should be verified after each build phase, and should missing artifacts cause the command to exit with an error or just warn?
**Options**:
- A) Hard error on missing artifacts: Define specific file paths per phase; exit non-zero if any are missing
- B) Warning only: Check for artifacts and log warnings but don't fail the command (build may have partially succeeded)
- C) Configurable strictness: Default to warning; add `--strict` flag that turns missing artifacts into errors
**Answer**: **A) Hard error on missing artifacts.** If critical build artifacts are missing, everything downstream fails anyway. Fail fast with a clear error message listing which artifacts are missing. Use the same paths as the existing script (`packages/agency/dist/cli.js`, `packages/agency-plugin-spec-kit/dist/index.js`) plus the generacy CLI equivalent.

### Q12: Graceful Shutdown Timeout
**Context**: FR-019 requires graceful shutdown on SIGTERM/SIGINT for `setup services`, but doesn't specify a timeout for child process cleanup. If a Firebase emulator hangs during shutdown, the command could wait indefinitely.
**Question**: What should the graceful shutdown timeout be before force-killing child processes?
**Options**:
- A) 5 seconds: Quick shutdown; Firebase emulators don't need persistent state
- B) 10 seconds: Moderate grace period for clean process termination
- C) 30 seconds: Conservative timeout to allow Firebase emulators to flush any in-progress operations
**Answer**: **A) 5 seconds.** Firebase emulators in a dev container have no persistent state to flush. Quick shutdown is appropriate. If a process doesn't respond to SIGTERM in 5 seconds, SIGKILL it.

### Q13: Setup Config Resolution Pattern
**Context**: FR-023 requires "three-tier config resolution pattern" matching the existing `resolveConfig` in `utils/config.ts`. However, setup commands have entirely different options (repos, branches, build phases) than the existing config (orchestrator URL, worker ID, poll intervals). The Assumptions section notes the existing pattern "will be extended or a parallel setup config module will be created."
**Question**: Should setup commands extend the existing `CLIConfig` interface and `resolveConfig` function, or create a separate `SetupConfig` with its own resolution module?
**Options**:
- A) Separate module: Create `utils/setup-config.ts` with `SetupConfig` interface and `resolveSetupConfig()` — clean separation of concerns
- B) Extend existing: Add setup-specific fields to `CLIConfig` and update `resolveConfig()` — single source of truth but larger interface
- C) Per-command config: Each setup subcommand resolves its own config inline using the same three-tier pattern — no shared setup config type
**Answer**: **C) Per-command config.** Each setup subcommand has completely different options. A unified `SetupConfig` would be a grab-bag. Each command should define its own config type and resolve it inline using the same three-tier pattern. This keeps each command self-contained and easy to understand.

### Q14: Error Recovery and Partial State
**Context**: US5 says "A failure in one command produces a clear error message without corrupting state for subsequent runs." However, `setup workspace` could fail mid-way through cloning 8 repos, and `setup build` could fail between Phase 2 and Phase 3. The spec doesn't address partial completion or resume behavior.
**Question**: When a command fails partway through (e.g., 5 of 8 repos cloned, or Agency built but Generacy failed), should subsequent re-runs skip already-completed work or redo everything?
**Options**:
- A) Always redo: Each run starts fresh — simpler logic, idempotent by design since operations like clone-if-not-exists naturally skip
- B) Track and resume: Write a progress file (e.g., `.setup-state.json`) to skip completed steps on re-run
- C) Rely on idempotent operations: Don't track state explicitly, but design each operation to be a no-op if already done (clone skips if dir exists, build always rebuilds)
**Answer**: **C) Rely on idempotent operations.** Design each operation to be naturally idempotent: `clone` skips if the directory exists, `git fetch` always works, `pnpm install` is idempotent, `build` always rebuilds. No state tracking file needed. This matches the existing scripts' approach and is the simplest correct solution.

### Q15: Log File Rotation and Cleanup
**Context**: FR-020 specifies logging service output to `/tmp/cloud-services/` with separate files per service. The spec doesn't address log file rotation, maximum size, or cleanup of old logs. Long-running dev containers could accumulate large log files.
**Question**: Should service log files be rotated, truncated on restart, or left to grow indefinitely?
**Options**:
- A) Truncate on restart: Clear/recreate log files each time `setup services` starts — simple, prevents unbounded growth
- B) Append with rotation: Append to logs but rotate when files exceed a size threshold (e.g., 10MB)
- C) Append indefinitely: Let logs grow; `/tmp` is cleaned on container restart anyway
**Answer**: **A) Truncate on restart.** Clear log files each time `setup services` starts. Logs from previous runs are stale. `/tmp` is ephemeral anyway in a container, so there's no long-term accumulation concern. Truncating on restart ensures logs only contain output from the current session.

### Q16: Safe Directory Wildcard vs Per-Repo
**Context**: FR-009 says "adds each repo path as a git safe directory" individually. However, the existing `setup-repos.sh` uses `git config --global --add safe.directory '*'` (wildcard) which trusts all directories. Individual entries are more secure but require maintenance.
**Question**: Should the safe directory configuration use a wildcard (`*`) matching the existing script or add each repo path individually?
**Options**:
- A) Wildcard: Use `safe.directory '*'` matching existing behavior — simpler, no maintenance
- B) Per-repo paths: Add each cloned repo path individually — more secure, matches spec FR-009 literally
**Answer**: **A) Wildcard.** This is a dev container, not a production environment. The wildcard (`safe.directory '*'`) is what the existing script uses, is simpler, and avoids maintenance. Security of git safe directories is irrelevant in a throwaway container.
