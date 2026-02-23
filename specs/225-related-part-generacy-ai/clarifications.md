# Clarification Questions

## Status: Pending

## Questions

### Q1: Error Handling Strictness vs. Bash Script Behavior
**Context**: The existing bash scripts use `|| true` extensively — nearly every git, install, and service command is wrapped to never fail. The spec says "Exits with code 1 on failure" (FR-052) and "Continues processing remaining repos when one fails" (US2), but doesn't define what constitutes a "failure" versus a recoverable warning. For example, `setup-cloud-services.sh` uses `|| true` on all `wait_for_port` calls, meaning it reports success even if services don't start — directly contradicting the spec's "Exits with code 1 if services fail to start within the timeout."
**Question**: Should the new TypeScript commands be stricter than the bash scripts (fail on errors as the spec states), or should they preserve the bash scripts' permissive behavior (warn but continue)?
**Options**:
- A) Strict (match spec): Commands exit 1 when critical operations fail (auth fails, clone fails, build fails, services don't start). Warnings only for truly optional operations.
- B) Permissive (match bash): Preserve the `|| true` philosophy — warn on errors, always exit 0 unless something truly catastrophic happens. This matches what developers are used to.
- C) Configurable: Add a `--strict` flag (default off) that controls whether errors cause exit 1 or just warnings. Default behavior matches current bash permissiveness.
**Answer**:

### Q2: Git Safe Directory — Wildcard vs. Per-Repo
**Context**: The spec says "configures `git safe.directory` per repo" (FR-025), but the existing `setup-repos.sh` uses `git config --global --add safe.directory '*'` (a global wildcard trusting all directories). Per-repo configuration is more secure but requires iterating over each repo path. The wildcard approach is simpler and matches current behavior.
**Question**: Should `setup workspace` configure `safe.directory` per-repo (more secure, as spec states) or use a wildcard (simpler, matches current bash behavior)?
**Options**:
- A) Per-repo: Add each repo path individually to `safe.directory` — more secure, follows least-privilege principle.
- B) Wildcard: Use `safe.directory '*'` as the bash script does — simpler, avoids issues with dynamic repo lists.
**Answer**:

### Q3: Default Repo List Format and Org Handling
**Context**: The spec's default repo list uses full `org/repo` format (e.g., `generacy-ai/tetrad-development`), but the bash script uses bare repo names (e.g., `tetrad-development`) with a separate `GITHUB_ORG` environment variable (defaulting to `generacy-ai`). The `--repos` CLI option and `REPOS` env var format isn't specified — should users pass `org/repo` or just `repo` names?
**Question**: Should the repo list use full `org/repo` format (as the spec shows) or bare repo names with a separate `--org` option (as the bash script does)?
**Options**:
- A) Full `org/repo` format: Users pass `generacy-ai/tetrad-development,generacy-ai/agency`. No separate org option. Simpler parsing but more verbose.
- B) Bare names + `--org`: Users pass `tetrad-development,agency` and optionally `--org generacy-ai`. Matches current bash behavior and is less verbose.
- C) Support both: Accept either `org/repo` or bare `repo` names. If no org prefix, use `--org` / `GITHUB_ORG` env var (default `generacy-ai`).
**Answer**:

### Q4: Branch Checkout Fallback Chain
**Context**: The bash script `setup-repos.sh` has a multi-step branch checkout fallback: (1) try `git checkout $branch`, (2) if that fails try `git checkout -b $branch origin/$branch`, (3) if that fails continue with `|| true`. Similarly, `git clone` first tries with `--branch`, then falls back to cloning without a branch arg. The spec only says "Checks out the specified branch" without describing what happens when the branch doesn't exist on a repo.
**Question**: What should happen when the specified branch doesn't exist for a given repo?
**Options**:
- A) Fallback to default branch: If the target branch doesn't exist, stay on whatever the repo's default branch is (usually `main` or `develop`). Log a warning.
- B) Try tracking remote: Attempt `git checkout -b $branch origin/$branch` first, then fall back to default branch with a warning. Matches the bash script's current behavior.
- C) Fail the repo: If the branch doesn't exist, treat it as a repo failure and report it in the summary. Other repos continue.
**Answer**:

### Q5: Agency Config JSON Structure
**Context**: The spec says `setup build` Phase 2 should "create `.agency/config.json` for plugin discovery" (FR-034), but doesn't provide the JSON structure. The bash script (`setup-plugins.sh`) creates this file with a heredoc containing `name`, `pluginPaths`, `defaultMode`, and `modes` fields with hardcoded paths and values. The exact content matters because Agency's plugin system reads this file.
**Question**: Should the config.json structure be hardcoded to match the current bash script output, or should it be derived from the built artifacts dynamically?
**Options**:
- A) Hardcoded (match bash): Reproduce the exact JSON structure from `setup-plugins.sh` with the same paths and values. Simple, guaranteed compatible.
- B) Dynamic discovery: Scan the Agency build output to discover plugin paths and generate config dynamically. More robust to future changes but more complex.
- C) Template-based: Use a JSON template file checked into the repo that gets copied to `~/.agency/config.json`. Changes to the config are version-controlled.
**Answer**:

### Q6: Pnpm Install Frozen Lockfile Fallback
**Context**: The bash scripts use a three-level install fallback: `pnpm install` (strict/frozen lockfile) → `pnpm install --no-frozen-lockfile` → continue. The spec says "Installs dependencies per repo using the detected package manager" but doesn't specify whether to use frozen lockfile or how to handle lockfile mismatches. In CI-like environments (dev containers), lockfile mismatches are common after branch switches.
**Question**: Should `pnpm install` use `--frozen-lockfile` by default with a fallback to `--no-frozen-lockfile`, or always use a permissive install?
**Options**:
- A) Strict then fallback: Try `pnpm install --frozen-lockfile` first, fall back to `pnpm install --no-frozen-lockfile` if it fails. Matches bash behavior.
- B) Always permissive: Always use `pnpm install` without `--frozen-lockfile`. Simpler, avoids double-install overhead.
- C) Configurable: Default to `--frozen-lockfile` with a `--no-frozen-lockfile` flag on the CLI to override. Lets users choose.
**Answer**:

### Q7: Artifact Verification — Fail vs. Warn
**Context**: The spec says `setup build` Phase 2 should "verify Agency CLI and spec-kit plugin artifacts exist" and "fail if missing" (FR-035). However, the bash script only prints warnings when artifacts are missing — it does not exit with an error. This is a behavioral change that could break existing workflows where partial builds are acceptable.
**Question**: Should missing build artifacts cause `setup build` to exit with code 1 (as spec states) or only warn (as bash script does)?
**Options**:
- A) Fail (match spec): Exit with code 1 if any verified artifact is missing. Forces developers to fix build issues immediately.
- B) Warn (match bash): Print warnings for missing artifacts but continue and exit 0. Allows partial setups.
- C) Fail only in strict mode: Default to warning, add `--strict` flag that makes missing artifacts a fatal error.
**Answer**:

### Q8: Services Subcommand — Foreground Process Lifecycle
**Context**: The spec says "Services subcommand runs in the foreground (keeps the process alive) while spawning child processes in the background" (Assumptions). But it doesn't specify what the foreground process does while waiting — does it block indefinitely until SIGTERM? Does it print ongoing health status? Should it restart failed child processes? The bash script simply starts processes and exits, relying on the shell to keep things running.
**Question**: What should the `setup services` foreground process do after all services are started and ready?
**Options**:
- A) Block until signal: Stay alive doing nothing, forwarding signals to children. Exit when SIGTERM/SIGINT received. Simplest approach.
- B) Health monitoring: Periodically check that services are still running (port checks). Log if a service dies. Exit with error if a critical service dies.
- C) Start and exit: Start all services in the background and exit immediately (like the bash script). The terminal/shell session keeps processes alive.
**Answer**:

### Q9: Stripe and Other Undocumented Environment Variables
**Context**: The bash script `setup-cloud-services.sh` sets placeholder Stripe environment variables (`STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`) with `sk_test_dev_placeholder` defaults. It also sets `FIREBASE_PROJECT_ID` per service. These are not mentioned in the spec's environment variables table or anywhere in the functional requirements.
**Question**: Should `setup services` set these additional environment variables for the API servers?
**Options**:
- A) Include all: Replicate all env vars from the bash script including Stripe placeholders and Firebase project IDs. Maintains full compatibility.
- B) Firebase only: Include `FIREBASE_PROJECT_ID` (needed for emulator routing) but not Stripe placeholders. Stripe config should come from the user's environment or a `.env` file.
- C) Document and defer: Don't set any extra env vars. Document them in the command's help text so developers know what to set. Keeps the command simpler.
**Answer**:

### Q10: Per-Service Timeout Configuration
**Context**: The spec defines a single `--timeout <seconds>` option (default 60) for service readiness. However, the bash script uses different timeouts for different services: 60s for Firebase emulators, 30s for API servers. Different services have different startup characteristics — emulators are heavier and slower to start than API servers.
**Question**: Should the `--timeout` option apply uniformly to all services, or should there be per-service timeout customization?
**Options**:
- A) Single uniform timeout: One `--timeout` value applies to each service individually (e.g., each service gets 60s). Simple but may over-wait for fast services.
- B) Single total timeout: The `--timeout` is the total time allowed for ALL services to become ready. More intuitive but harder to debug which service is slow.
- C) Per-service defaults with override: Each service has a sensible default timeout (60s emulators, 30s APIs) but `--timeout` overrides all of them. Matches bash behavior while allowing override.
**Answer**:

### Q11: Claude Plugin State — JSON Editing Implementation
**Context**: The bash script uses Python (`python3 -c`) to parse and edit `~/.claude/settings.json` to remove the `enabledPlugins` key (FR-031). The spec says "Parse JSON, delete key, write back; handle missing file gracefully" but doesn't specify the implementation approach. Since this is a TypeScript CLI, Python shouldn't be needed, but the question is about error handling edge cases: what if the JSON is malformed? What if the file is being written by another process?
**Question**: How should `setup build` handle edge cases when editing `~/.claude/settings.json`?
**Options**:
- A) Best-effort: Try to parse, edit, and write. If the file is missing, malformed, or locked, log a warning and skip. Never fail Phase 1 due to settings.json issues.
- B) Atomic write: Read, parse, modify in memory, write to a temp file, then rename (atomic). If JSON is malformed, back up the original and skip the edit with a warning.
- C) Strict: Parse and edit. If the JSON is malformed, fail Phase 1 with a clear error message telling the user to fix their settings file.
**Answer**:

### Q12: Workspace Command — Dependency Installation Order
**Context**: The bash script `setup-repos.sh` installs dependencies in a specific order: it clones ALL repos first, then installs `tetrad-development` dependencies first (as it may contain shared tooling), then installs the rest. The spec doesn't specify installation order. Some repos may have build-time dependencies on other repos (e.g., packages that reference workspace siblings).
**Question**: Should `setup workspace` install dependencies in a specific order, or process repos in list order?
**Options**:
- A) Clone all, then install all: Clone all repos first, then install dependencies for all repos in list order. Matches the general bash script flow.
- B) Clone all, install ordered: Clone all repos first, then install `tetrad-development` first, then the rest. Matches the exact bash behavior.
- C) Clone and install per-repo: Clone each repo and immediately install its dependencies before moving to the next. Simpler logic but may cause issues with cross-repo dependencies.
**Answer**:

