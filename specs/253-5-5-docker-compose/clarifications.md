# Clarification Questions

## Status: Resolved

## Questions

### Q1: Docker Compose `features` Key Validity
**Context**: The template uses a top-level `features` key within the orchestrator and worker service definitions (lines 37-38, 107-108 of `docker-compose.yml.hbs`). The `features` key is a Dev Container specification concept, not a Docker Compose concept. Docker Compose will either ignore it or error on it. Dev container features are typically installed via `devcontainer.json`, not `docker-compose.yml`. The multi-repo `devcontainer.json.hbs` template does NOT currently include a `features` block — it only has `customizations`.
**Question**: How should the Generacy dev container feature be installed in the multi-repo compose setup? Should `features` be moved from docker-compose.yml to devcontainer.json (which is the standard approach), or is there a custom Docker Compose extension/build step that processes this key?
**Options**:
- A) Move to devcontainer.json: Add the `features` block to `multi-repo/devcontainer.json.hbs` (standard Dev Container spec behavior — the CLI processes features when building/starting the service targeted by `devcontainer.json`)
- B) Use a custom Dockerfile build step: Replace the `features` key in compose with a `build` directive that installs the feature during image build
- C) Keep in both places: Add features to `devcontainer.json` AND keep the compose `features` key as documentation/metadata that Dev Container tooling may process
**Answer**: **A — Move to devcontainer.json.** The `features` key is invalid Docker Compose syntax and will error or be silently ignored. Add the `features` block to `multi-repo/devcontainer.json.hbs` — the Dev Container CLI will install it on the orchestrator (the target service). For workers, since they're not the devcontainer target service, the feature will need to be baked into the base image or installed via a custom Dockerfile build step — this can be addressed as a follow-up.

---

### Q2: Worker Count Validation Range Mismatch
**Context**: The spec states worker count range is 1–20 (US2, FR-017), but the Zod schema in `schema.ts:98-102` uses `.nonnegative()` (allowing 0) with a default of 3. The spec says default is 2. A `workerCount` of 0 would produce a compose file with `deploy.replicas: 0`, which starts no workers at all. Additionally, the `MultiRepoInputSchema` uses `.positive()` (minimum 1) for its input, creating an inconsistency with the context schema.
**Question**: What should the valid range and default value be for `workerCount` in multi-repo projects?
**Options**:
- A) Range 1–20, default 2: Match the spec exactly. Workers are always required in multi-repo mode.
- B) Range 1–20, default 3: Keep the current schema default of 3 but enforce minimum of 1.
- C) Range 0–20, default 2: Allow 0 workers for orchestrator-only mode (useful for debugging/development).
**Answer**: **A — Range 1–20, default 2.** Match the spec. Multi-repo mode always requires at least one worker — 0 workers is meaningless when you have an orchestrator/worker architecture. Default of 2 aligns with spec. Fix the schema: change `.nonnegative()` to `.min(1).max(20)` and default to `2`.

---

### Q3: `pollIntervalMs` Minimum Validation Mismatch
**Context**: The spec states `pollIntervalMs >= 5000` with a default of 5000, but the Zod schema in `schema.ts:91-94` only validates `.positive()` (minimum 1). The fixture `multi-repo-context.json` uses `3000` and `large-multi-repo-context.json` uses `2000`, both below the spec's 5000ms minimum. This means the existing test fixtures would fail if the spec's minimum were enforced.
**Question**: What should the minimum `pollIntervalMs` be?
**Options**:
- A) Minimum 5000ms: Match the spec. Update fixtures to use values >= 5000ms. This prevents aggressive polling that could overload Redis.
- B) Minimum 1000ms: Allow faster polling for responsive setups but prevent sub-second values. Update spec.
- C) No practical minimum (positive integer): Keep current schema behavior. Trust users to set reasonable values.
**Answer**: **A — Minimum 5000ms.** Match the spec. Sub-5000ms polling wastes resources and risks Redis overload with no practical benefit. Update fixtures (`multi-repo-context.json` from 3000→5000, `large-multi-repo-context.json` from 2000→5000). Change schema to `.min(5000)`.

---

### Q4: Clone Repos Mount Mode — Read-Write vs Read-Only
**Context**: The spec's US3 acceptance criteria says clone repos are mounted with `:cached` mode, and the template does use `:cached`. However, the spec also calls them "Clone-only repositories (no PRs created)" and "Read-only reference repos." The `:cached` mount mode is a performance hint, not a read-only constraint. If these repos are truly reference-only, they could use `:ro` (read-only) to prevent accidental writes. The template currently treats dev repos and clone repos identically.
**Question**: Should clone-only repository mounts be read-only to enforce their reference-only nature?
**Options**:
- A) Keep `:cached` (read-write): Workers/orchestrator may need to build or install dependencies in clone repos even if they don't create PRs. Read-only would break `npm install`, `go build`, etc.
- B) Use `:cached,ro` (read-only): Enforce the "clone-only" contract at the mount level. If code needs build artifacts, it should use a separate build output directory.
- C) Make it configurable per-repo: Add a `readOnly` flag to clone repo entries so users can choose per-repository.
**Answer**: **A — Keep `:cached` (read-write).** "Clone-only" means Generacy won't create PRs for these repos, not that they should be read-only at the filesystem level. Workers need to `npm install`, build, run tests, etc. in clone repos. Read-only mounts would break standard development workflows.

---

### Q5: Redis Port Exposure to Host
**Context**: FR-023 marks Redis port `6379` exposure as P2 (optional), noting it's "useful for Redis CLI inspection." The current template (line 19-20) unconditionally exposes `"6379:6379"`. In a multi-project environment, this will cause port conflicts if two projects try to run simultaneously. The spec doesn't address port conflict scenarios or whether the port mapping should use a project-specific host port.
**Question**: How should Redis port exposure be handled for multi-project environments?
**Options**:
- A) Remove host port mapping: Only expose within the Docker network. Developers can use `docker exec` for debugging. Eliminates port conflicts entirely.
- B) Keep static `6379:6379`: Accept that only one project's compose stack can run at a time. Simple and matches common expectations.
- C) Use dynamic host port: Map to `0:6379` (Docker assigns a random host port) to avoid conflicts. Developers use `docker compose port redis 6379` to discover the port.
**Answer**: **A — Remove host port mapping.** Remove the `ports:` section entirely and only expose Redis within the Docker network. This eliminates port conflicts in multi-project environments and is more secure. Developers can use `docker exec -it <container> redis-cli` for debugging. An auto-generated config should default to the safest option.

---

### Q6: `version: "3.8"` Compose File Header
**Context**: The template includes `version: "3.8"` (line 9). The spec's assumptions note this is "included for compatibility but is not required by Compose V2." Docker Compose V2 actually emits a deprecation warning when `version` is present: `WARN[0000] /path/docker-compose.yml: 'version' is obsolete`. Since this file is auto-generated and intended to work "out of the box," the deprecation warning on first run may confuse users.
**Question**: Should the `version` field be kept or removed from the generated compose file?
**Options**:
- A) Remove `version` field: Eliminates the deprecation warning. Compose V2 ignores it anyway. This is the modern best practice.
- B) Keep `version: "3.8"`: Maintains backward compatibility with older Compose V1 installations, even though the spec assumes V2.
**Answer**: **A — Remove `version` field.** Compose V2 is the standard. The `version` key triggers a deprecation warning on every `docker compose` invocation — bad UX for an auto-generated "just works" file. Remove it.

---

### Q7: `features` Key in Compose — Worker Health Check Missing
**Context**: The orchestrator has a health check (lines 86-91) that tests for `/home/vscode/.generacy/ready` — a file created when the dev container feature finishes installing. Workers use the same base image and need the same feature installed, but workers have NO health check defined. If the dev container feature takes time to install on workers, the workers may start polling Redis before they're fully initialized. FR-018 says workers depend on orchestrator being healthy, but nothing gates the worker's own readiness.
**Question**: Should workers have their own health check to signal readiness after feature installation?
**Options**:
- A) Add worker health check: Mirror the orchestrator's `/home/vscode/.generacy/ready` check. This ensures workers are fully initialized before they appear healthy to monitoring tools, but it doesn't affect startup order (workers already wait for orchestrator).
- B) No worker health check needed: Workers wait for the orchestrator (which means features are already cached/available). The `sleep infinity` command keeps them running. No downstream service depends on worker health.
- C) Add health check with simpler probe: Use a lightweight check (e.g., test for a specific binary or process) rather than the ready file, since workers may have different initialization.
**Answer**: **A — Add worker health check.** Mirror the orchestrator's `/home/vscode/.generacy/ready` check. Even though workers wait for the orchestrator, their own health check ensures they're fully initialized before reporting healthy. This helps monitoring and diagnostics. Note: the specific health check probe depends on Q1's resolution (how features get installed on workers).

---

### Q8: Shared `vscode-server` Volume Across Orchestrator and Workers
**Context**: FR-010 and FR-019 specify that `vscode-server` is shared between orchestrator and all workers. The template confirms this — all containers mount the same `vscode-server` named volume at `/home/vscode/.vscode-server`. Multiple containers writing to the same VS Code Server directory simultaneously can cause file locking issues, extension corruption, or settings conflicts. Workers are headless (no VS Code attached), so it's unclear why they need VS Code Server state.
**Question**: Should workers share the `vscode-server` named volume with the orchestrator?
**Options**:
- A) Remove from workers: Workers don't run VS Code. Removing the shared volume eliminates potential corruption and reduces the worker's mount surface.
- B) Keep shared: Workers may run VS Code extensions headlessly (e.g., language servers, linters) that are installed in `.vscode-server`. Sharing avoids duplicate extension installs.
- C) Give workers a separate volume: Each worker gets its own `vscode-server-worker` volume to avoid conflicts while still caching extensions.
**Answer**: **A — Remove from workers.** Workers are headless — they don't run VS Code. Sharing the `vscode-server` volume risks file locking issues and extension corruption from concurrent writes. Remove it from the worker service. If workers need language servers or linters in the future, give them their own volume at that point.

---

### Q9: Repo Name Collision Handling
**Context**: The `repoName` helper extracts just the repo name from `owner/repo` format. If a project has repos `acme/utils` and `other-org/utils`, both would be mounted at `/workspaces/utils`, causing a mount collision. The Zod schema doesn't validate for unique repo names across primary, dev, and clone arrays. The spec doesn't address this edge case.
**Question**: How should repo name collisions be handled?
**Options**:
- A) Validate at context creation time: Add a Zod `.refine()` that rejects contexts where any two repos resolve to the same `repoName`. This is the simplest approach — fail fast with a clear error.
- B) Use `owner-repo` format for mounts: Change the mount path to `/workspaces/{owner}-{repo}` to eliminate collisions. This changes the workspace layout for all users.
- C) Use `owner/repo` nested paths: Mount at `/workspaces/{owner}/{repo}` for disambiguation. More natural but deeper nesting.
**Answer**: **A — Validate at context creation time.** Add a Zod `.refine()` that rejects contexts where any two repos across primary, dev, and clone arrays resolve to the same repo name. Fail fast with a clear error message like `"Repos 'acme/utils' and 'other-org/utils' both resolve to mount path '/workspaces/utils'"`. This handles the rare edge case without changing the workspace layout for everyone.

---

### Q10: Missing Env Vars — `POLL_INTERVAL_MS` for Workers
**Context**: FR-006 specifies the orchestrator sets `POLL_INTERVAL_MS`, and the template does pass it to workers (line 120: `POLL_INTERVAL_MS={{orchestrator.pollIntervalMs}}`). However, FR-016 says workers omit orchestrator-only vars including `WORKER_COUNT`, `PROJECT_NAME`, `PRIMARY_REPO` — but doesn't explicitly list `POLL_INTERVAL_MS` as a worker variable. The template includes it for workers, but the spec's functional requirement doesn't clearly define the full set of worker environment variables.
**Question**: What is the canonical set of environment variables for worker containers?
**Options**:
- A) Current template is correct: Workers get `REDIS_URL`, `ROLE=worker`, `POLL_INTERVAL_MS`, and `PROJECT_ID`. The spec's FR-016 listing is just noting what to *omit*, not what to include.
- B) Workers should also get `PROJECT_NAME`: Workers may need the human-readable project name for logging or error messages. Add it to the worker service.
- C) Workers should be minimal: Only `REDIS_URL`, `ROLE=worker`, and `PROJECT_ID`. Remove `POLL_INTERVAL_MS` — workers should get their polling interval from the orchestrator via Redis, not from environment config.
**Answer**: **A — Current template is correct.** Workers get `REDIS_URL`, `ROLE=worker`, `POLL_INTERVAL_MS`, and `PROJECT_ID`. `POLL_INTERVAL_MS` as an env var is simpler and more reliable than fetching it from the orchestrator via Redis at runtime. FR-016 lists what to *omit* (orchestrator-only vars like `WORKER_COUNT`, `PROJECT_NAME`, `PRIMARY_REPO`), not an exhaustive list of what to include.

---

### Q11: Primary Repo Mount Path Inconsistency
**Context**: The spec says the primary repo is mounted at `../..` (two levels up from `.devcontainer/`), which means the mount source is the parent of the parent of `.devcontainer/`. For the mount to be correct, the directory structure must be `{workspace-root}/{primary-repo}/.devcontainer/docker-compose.yml`, and sibling repos must be at `{workspace-root}/{other-repo}/`. But if `.devcontainer/` is inside the primary repo, then `../..` points to the workspace root, not the primary repo itself. The mount `../..:/workspaces/{primary-repo}:cached` actually mounts the *workspace root* as the primary repo workspace, which would include all sibling repos in one mount.
**Question**: Is the primary repo mount source `../..` (workspace root) intentional, or should it be `..` (the primary repo root, one level up from `.devcontainer/`)?
**Options**:
- A) Use `..` for primary repo: `.devcontainer/` is inside the primary repo, so `..` is the primary repo root. Dev/clone repos should use `../../{repo-name}` relative to `.devcontainer/`.
- B) Keep `../..` as workspace root: The intent is to mount the workspace root as the primary repo workspace, giving access to all files. This is intentional for the orchestrator's broader view.
- C) Clarify the directory layout: Document the expected directory structure explicitly in the spec and adjust mounts accordingly.
**Answer**: **A — Use `..` for primary repo.** `.devcontainer/` lives inside the primary repo, so `..` correctly resolves to the primary repo root. The current `../..` would mount the entire workspace root (containing all sibling repos) as the primary repo — that's incorrect. Dev/clone repos should use `../../{repo-name}` to reach sibling directories.

---

### Q12: `noEscape` Handlebars Option and YAML Special Characters
**Context**: The renderer uses `noEscape: false` (line 261 in `renderer.ts`), which means Handlebars HTML-escapes output by default. This means characters like `&`, `<`, `>`, `"` in project names or repo paths would be escaped to `&amp;`, `&lt;`, etc. — which would produce invalid YAML. For example, a project name containing `&` would render as `PROJECT_NAME=Acme &amp; Co` in the compose file. The template uses `{{variable}}` (double-brace) syntax throughout, which triggers HTML escaping.
**Question**: Should the template renderer disable HTML escaping for YAML templates, or should all templates use triple-brace `{{{variable}}}` syntax to avoid escaping?
**Options**:
- A) Set `noEscape: true` for YAML templates: Since these aren't HTML, escaping is never wanted. Apply globally or per-template based on output format.
- B) Use triple-brace `{{{variable}}}` in YAML templates: Keep the safe default but explicitly opt out of escaping where needed. More verbose but explicit.
- C) Validate that context values don't contain special characters: Add Zod constraints that reject `&`, `<`, `>` in project names/IDs. Simplest but restrictive.
**Answer**: **A — Set `noEscape: true` for YAML templates.** These templates produce YAML and Docker Compose files, not HTML. HTML escaping will corrupt output (e.g., `PROJECT_NAME=Acme &amp; Co`). Since none of our templates are HTML, set `noEscape: true` globally in the renderer. Add input validation on context values (e.g., project names) as a separate concern if needed.
