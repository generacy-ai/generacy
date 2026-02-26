# Clarification Questions

## Status: Pending

## Questions

### Q1: Anthropic API Key Validation Endpoint
**Context**: FR-061 says to call the Anthropic API to verify the key is valid using "e.g., `GET /v1/models` or a minimal `POST /v1/messages`". The choice affects cost, latency, and reliability. `GET /v1/models` is read-only and free but may not exist or may not require auth. A minimal `POST /v1/messages` with `max_tokens: 1` would validate auth but could incur a small cost per invocation.
**Question**: Which Anthropic API endpoint should we use to validate the API key?
**Options**:
- A) `GET /v1/models` (Recommended): List models endpoint — free, read-only, confirms authentication without incurring usage costs. If this endpoint returns 401, the key is invalid.
- B) `POST /v1/messages` with minimal payload: Send a trivial request (`max_tokens: 1`, short prompt). Guarantees full auth validation but costs a small amount per doctor run.
- C) `GET /v1/organizations`: Check organization endpoint if available — free, confirms auth.
**Answer**:

---

### Q2: Env File Parsing Library
**Context**: FR-030/031 require parsing `.generacy/generacy.env` to extract key-value pairs. The spec doesn't specify whether to use a library like `dotenv` (which handles quoting, comments, multiline values) or a simple custom parser. The existing codebase has no `dotenv` dependency.
**Question**: Should we add `dotenv` as a dependency for parsing the env file, or implement a simple custom parser?
**Options**:
- A) Add `dotenv` dependency (Recommended): Handles edge cases (quoted values, comments, multiline) consistently with how the env file will be consumed at runtime.
- B) Simple custom parser: Split on `=`, trim whitespace, skip comments. Zero new dependencies but may miss edge cases.
**Answer**:

---

### Q3: Docker Check — Permission Detection
**Context**: FR-012 (P2) says to "detect Docker running but with insufficient permissions" and suggest adding the user to the `docker` group. However, the spec doesn't detail how to distinguish "Docker not installed" vs "Docker installed but daemon not running" vs "Docker running but permission denied". Each requires a different suggestion message.
**Question**: How granularly should we differentiate Docker failure modes?
**Options**:
- A) Three-way detection (Recommended): Distinguish "not installed" (command not found), "daemon not running" (daemon connection error), and "permission denied" (socket permission error). Each gets a tailored suggestion.
- B) Two-way detection: Distinguish "not installed" vs "other failure". Keep suggestion generic for non-installation failures.
- C) Single failure mode: Any `docker info` failure = fail with a combined suggestion message covering all cases.
**Answer**:

---

### Q4: `--check` and `--skip` — Multiple Values
**Context**: FR-005/006 define `--check <name>` and `--skip <name>` for selective check execution. The spec shows singular usage but doesn't clarify whether these flags accept multiple values (e.g., `--check github-token --check anthropic-key`) or only a single check name per invocation.
**Question**: Should `--check` and `--skip` accept multiple values?
**Options**:
- A) Multiple values via repetition (Recommended): Allow `--check github-token --check anthropic-key`. Commander.js supports this with `.option('--check <name...>')` or collecting into an array.
- B) Single value only: Each flag takes exactly one check name. To run multiple specific checks, users must run the command multiple times.
- C) Comma-separated: Accept `--check github-token,anthropic-key` as a single string and split on commas.
**Answer**:

---

### Q5: Agency MCP Default URL
**Context**: FR-081 says to use `AGENCY_URL` env var or a "default URL" for the Agency MCP health check, but the spec doesn't define what the default URL is. The existing codebase (`cli/utils/config.ts`) has no default for `agencyUrl` — it's optional and only required in network mode. The agent command defaults `agencyMode` to `subprocess`.
**Question**: What is the default Agency MCP URL to use when `AGENCY_URL` is not set inside a dev container?
**Options**:
- A) `http://localhost:3001`: Common convention for local development services alongside the main app.
- B) `http://localhost:8080`: Match the health check port default already in config.
- C) No default — skip check if `AGENCY_URL` not set: If the env var isn't configured, skip the check with a message explaining it needs `AGENCY_URL`.
**Answer**:

---

### Q6: Output Mechanism — Pino Logger vs Direct Console
**Context**: The existing CLI uses Pino (structured logger) for all output via `getLogger()`. However, the doctor command's color-coded, symbol-based output (FR-090–097) is fundamentally presentational and doesn't fit structured logging. The `validate` command already mixes `logger.info()` and `console.log()`. Using Pino would add JSON wrappers and timestamps that conflict with the clean output shown in the spec's example.
**Question**: Should the doctor command use Pino logger or write directly to stdout/stderr?
**Options**:
- A) Direct stdout/stderr (Recommended): Use `process.stdout.write()` / `console.log()` for all presentational output. Matches the spec's example output exactly. Use Pino only for `--verbose` debug-level diagnostics.
- B) Pino logger only: Use `logger.info()` for all output. Consistent with other commands but output will include timestamps and may not match the spec's visual format.
- C) Hybrid: Use direct output for the formatted report and Pino for error/debug messages.
**Answer**:

---

### Q7: Timeout and Concurrency for Network Checks
**Context**: SC-009 requires the full doctor run to complete in < 15 seconds including network checks. The spec defines 3 network checks (GitHub API, Anthropic API, Agency MCP). Running them sequentially with default timeouts could exceed 15 seconds on slow networks. The spec doesn't specify timeouts per check or whether network checks should run concurrently.
**Question**: Should network-dependent checks (GitHub token, Anthropic key, Agency MCP) run concurrently where dependency order allows, and what should the per-check timeout be?
**Options**:
- A) Concurrent within category, 5s timeout (Recommended): Run `github-token` and `anthropic-key` concurrently (both depend on `env-file`, not each other). Set a 5-second timeout per network check to stay within the 15-second budget.
- B) Sequential, 10s timeout: Run all checks sequentially. Simpler implementation but risks exceeding 15 seconds.
- C) All concurrent, 5s timeout: Run all independent checks concurrently regardless of category. Fastest but makes output order non-deterministic.
**Answer**:

---

### Q8: Env File Location Resolution
**Context**: FR-030 says to check `.generacy/generacy.env` "adjacent to config" (same parent directory as `config.yaml`). But the config file discovery via `findConfigFile()` walks up the directory tree. If the config is found at `/workspaces/myproject/.generacy/config.yaml`, the env file is at `/workspaces/myproject/.generacy/generacy.env`. However, if `GENERACY_CONFIG_PATH` env var points to a different location (e.g., `/home/user/custom-config.yaml`), there's no `.generacy/` directory to be "adjacent" to.
**Question**: How should env file location be resolved when config is loaded via `GENERACY_CONFIG_PATH` pointing to a non-standard location?
**Options**:
- A) Always relative to config file (Recommended): Resolve env file as `path.dirname(configPath) + '/generacy.env'`. Works for both standard (`.generacy/config.yaml` -> `.generacy/generacy.env`) and custom paths.
- B) Always in `.generacy/` directory: Walk up from CWD to find `.generacy/` directory regardless of where config was loaded from.
- C) Check both locations: Try adjacent to config first, then fall back to `.generacy/` directory discovery.
**Answer**:

---

### Q9: `--check` with Dependencies
**Context**: FR-005 says `--check <name>` runs "a single check (and its dependencies)". The spec doesn't clarify how this interacts with the output. If a user runs `--check github-token`, should they see the full category-grouped output including the automatically-run dependency checks (`env-file`), or only the targeted check's result?
**Question**: When using `--check`, should dependency checks be visible in the output?
**Options**:
- A) Show all executed checks (Recommended): Display dependency checks and the targeted check in the normal category-grouped format. The user sees what was actually validated.
- B) Show only targeted check: Run dependencies silently and only display the result of the requested check. Cleaner output but hides context.
- C) Show dependencies as dimmed/secondary: Display dependency results in a reduced format (e.g., gray text) and the targeted check prominently.
**Answer**:

---

### Q10: Node Package Version Check — Package Manager Detection
**Context**: FR-070-072 check npm package versions. The assumption section says "pnpm is the package manager" but "the check should handle npm fallback." The spec doesn't clarify whether to use `pnpm ls` / `npm ls` commands or directly inspect `node_modules`. The codebase has an existing `detectPackageManager()` function in the setup workspace command that checks for lockfiles.
**Question**: How should the package version check determine and report installed versions?
**Options**:
- A) Inspect `node_modules` directly (Recommended): Read `node_modules/@generacy-ai/generacy/package.json` for the installed version. Fast, no subprocess needed, package-manager agnostic.
- B) Use detected package manager CLI: Call `pnpm ls @generacy-ai/generacy --json` or `npm ls @generacy-ai/generacy --json`. More accurate (validates integrity) but slower and requires package manager to be installed.
- C) Both: Try `node_modules` first for speed, fall back to CLI for accuracy if `node_modules` is missing.
**Answer**:

---

### Q11: `generacy.env.template` vs `generacy.env.template.hbs`
**Context**: FR-033 suggests copying from `generacy.env.template` when the env file is missing, but the actual template in the codebase is a Handlebars template (`generacy.env.template.hbs`) that contains template expressions like `{{project.id}}` and `{{defaults.baseBranch}}`. A raw copy wouldn't produce a usable env file. The rendered template (`generacy.env.template` without `.hbs`) would be generated by `generacy init`.
**Question**: What should the fix suggestion say when `.generacy/generacy.env` is missing?
**Options**:
- A) Suggest `generacy init` (Recommended): The init command generates a properly rendered template. Message: "Run `generacy init` to generate the env file, or create `.generacy/generacy.env` manually with required keys: GITHUB_TOKEN, ANTHROPIC_API_KEY."
- B) Suggest copying rendered template: Reference `.generacy/generacy.env.template` assuming `generacy init` has already been run and left the rendered template in place.
- C) Suggest manual creation: List the required keys and tell the user to create the file manually. No dependency on init or templates.
**Answer**:

---

### Q12: Dev Container Feature Version Check
**Context**: FR-042 (P2) checks that the Generacy dev container feature is referenced in `devcontainer.json` by looking for `ghcr.io/generacy-ai/generacy/generacy` in `features`. The spec doesn't specify whether to also validate the feature version/tag, or just confirm the feature is present.
**Question**: Should the devcontainer check validate the Generacy feature version, or just confirm its presence?
**Options**:
- A) Presence only (Recommended): Just confirm the feature reference exists. Version management is handled by dependabot/renovate and is out of scope for doctor.
- B) Presence + version warning: Confirm presence, and if a version is pinned, warn if it doesn't match the installed `@generacy-ai/generacy` package version.
**Answer**:

---

### Q13: Exit Code 2 — Runtime Error Scenarios
**Context**: US3 defines exit code 2 for "runtime error" distinct from exit code 1 (any check failed). The spec doesn't enumerate what constitutes a "runtime error" vs a check failure. For example, if the GitHub API returns a 500 (server error) during token validation, is that a check failure (exit 1) or a runtime error (exit 2)?
**Question**: What scenarios should produce exit code 2 (runtime error) vs exit code 1 (check failure)?
**Options**:
- A) Only internal errors (Recommended): Exit code 2 for bugs in the doctor command itself (unhandled exceptions, invalid check configuration, file system errors during output). All check-level failures (including network errors, API 500s) are exit code 1 since they represent environment problems.
- B) Network/infrastructure errors: Exit code 2 when the doctor command itself can't function properly (e.g., can't write output, can't resolve check dependencies) OR when external services are unreachable. Exit code 1 only for definitive check failures (wrong scopes, missing files).
**Answer**:

