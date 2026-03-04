# Clarification Questions

## Status: Pending

## Questions

### Q1: Template Fetching Strategy
**Context**: FR-006 says "Use GitHub API (similar to generacy-cloud worker approach) or git clone" but does not commit to a strategy. This is the single most impactful architectural decision — it affects latency, authentication requirements, offline behavior, error handling, and dependency footprint. The `generacy-cloud` worker uses Octokit's `repos.getContent()` which requires the `octokit` dependency; the CLI currently uses bare `fetch()` for GitHub API calls.
**Question**: Which fetching mechanism should the CLI use to download templates from the `cluster-templates` repo?
**Options**:
- A) GitHub Contents API via bare `fetch()`**: Lightweight, no new dependencies. Matches the CLI's existing pattern in `github.ts`. Requires recursive directory listing (one request per directory level) and base64 decoding for file contents.
- B) GitHub tarball/zipball download via `fetch()`**: Single HTTP request to download the entire repo (or a subtree). Requires extracting the archive, but avoids recursive API calls. Needs a tar/zip extraction dependency or Node.js built-in `zlib`.
- C) `git clone --depth 1 --sparse`**: Uses git CLI (already available since `generacy init` requires a git repo). No GitHub API auth needed for public repos. Requires `git` to be on PATH.
- D) Octokit (add as dependency)**: Mirrors the `generacy-cloud` reference implementation most closely. Adds `octokit` as a dependency to the CLI package.
**Answer**:

---

### Q2: Template Variable Substitution Format
**Context**: The current Handlebars templates use a rich `TemplateContext` object with 5 custom helpers (`repoName`, `configRepoUrl`, `json`, `urlEncode`, `eq`) and deeply nested context (project, repos, defaults, orchestrator, devcontainer, metadata, cluster). FR-007 says "Templates from cluster-templates **may** use a simpler substitution format" — the word "may" indicates uncertainty. The entire approach to steps 4-6 of the init flow depends on whether `cluster-templates` files are pre-rendered or still contain template variables.
**Question**: Do the files in the `cluster-templates` repo contain template variables that need substitution, or are they fully rendered (static) files that can be used as-is?
**Options**:
- A) Fully static files: `cluster-templates` contains ready-to-use devcontainer files with no variable placeholders. The CLI fetches and writes them directly, making the entire `TemplateContext` building step (step 4) unnecessary.
- B) Simple placeholder substitution: Files use a simple `{{variable}}` or `${variable}` syntax that can be replaced with a basic string-replace (no logic, no helpers). The CLI builds a flat key-value map and does find-and-replace.
- C) Still Handlebars-based: `cluster-templates` uses the same `.hbs` format, and the CLI must retain Handlebars as a dependency for rendering. This contradicts the goal of removing Handlebars.
- D) Mixed: Some files are static (scripts), some need substitution (config.yaml, devcontainer.json). The CLI needs a lightweight substitution engine for the dynamic files.
**Answer**:

---

### Q3: Offline and Network Failure Behavior
**Context**: The Risks section identifies "generacy init breaks if cluster-templates repo is unreachable" and suggests "bundling a fallback snapshot or caching fetched templates." Currently, `generacy init` works fully offline because templates are bundled in the npm package. Switching to runtime fetching is a significant UX regression for users without network access (e.g., air-gapped environments, planes, VPNs blocking GitHub).
**Question**: What should happen when `generacy init` cannot reach the `cluster-templates` repository?
**Options**:
- A) Hard fail with clear error: No fallback. If the network is unavailable, print an error message explaining that templates could not be fetched and suggest checking connectivity. Simple to implement, defers caching to a follow-up.
- B) Bundle a snapshot as fallback: Ship a pinned copy of the templates inside the CLI package. Use it when the network fetch fails. Adds a build step to sync the snapshot but preserves offline capability.
- C) Cache-first with TTL: After the first successful fetch, cache templates locally (e.g., `~/.generacy/template-cache/`). Subsequent runs use the cache if it's fresh (e.g., <24h) or if the network is unavailable. Requires cache invalidation logic.
- D) Cache with explicit refresh: Cache fetched templates indefinitely. Add a `--refresh-templates` flag (or `generacy update-templates` command) to force re-download. Simplest caching model.
**Answer**:

---

### Q4: GitHub Authentication for Template Fetching
**Context**: The init command already discovers GitHub tokens via `GITHUB_TOKEN` env var and `gh auth token` fallback (in `github.ts`). If `cluster-templates` is a public repo, unauthenticated requests work but are rate-limited to 60 req/hr. If it's private (or if rate limits are a concern), authentication is needed. The spec doesn't clarify the repo's visibility.
**Question**: Is the `generacy-ai/cluster-templates` repository public or private, and should the template fetcher require authentication?
**Options**:
- A) Public repo, no auth required: Fetch without authentication. Accept the 60 req/hr rate limit for unauthenticated requests (sufficient for CLI usage).
- B) Public repo, use auth opportunistically: Fetch without auth by default, but if a GitHub token is already available (from the earlier discovery step), include it for higher rate limits (5000 req/hr).
- C) Private repo, auth required: The fetcher must use a GitHub token. Reuse the token discovered in step 3 of the init flow. Fail with a clear error if no token is available.
**Answer**:

---

### Q5: Template Version Pinning
**Context**: The spec does not specify which branch, tag, or commit of `cluster-templates` the CLI should fetch from. This affects reproducibility — two developers running the same CLI version could get different templates if `main` has been updated between runs. The `generacy-cloud` worker fetches a specific `ref` parameter.
**Question**: Which ref (branch/tag/commit) of the `cluster-templates` repo should the CLI fetch?
**Options**:
- A) Always fetch `main` (latest): Simplest approach. Templates are always up-to-date. Risk: breaking changes in templates could affect older CLI versions.
- B) Pin to a tag matching CLI version: The CLI fetches `cluster-templates@v{cli-version}`. Requires the `cluster-templates` repo to publish matching tags. Ensures reproducibility.
- C) Pin to a hardcoded tag/commit in CLI source: Each CLI release hardcodes the `cluster-templates` ref it's compatible with. Updated as part of the CLI release process. Most reproducible.
- D) Configurable with a sensible default: Default to `main` but allow override via `--template-ref <ref>` flag or `GENERACY_TEMPLATE_REF` env var. Flexible for development and debugging.
**Answer**:

---

### Q6: Extensions.json Merge Logic Migration
**Context**: The current `renderExtensionsJson()` function in `renderer.ts` implements smart merging: when `.vscode/extensions.json` already exists, it deduplicates and merges the `GENERACY_EXTENSIONS` list into the existing `recommendations` array. This logic lives inside the templates package. The spec's FR-005 says to "replace Handlebars rendering" but doesn't specify where the extensions merge logic should move. If cluster-templates returns a static `extensions.json`, the merge logic must be preserved in the CLI.
**Question**: Where should the extensions.json merge logic live after the templates package is removed?
**Options**:
- A) Inline in `init/index.ts` or `init/writer.ts`: Move the merge logic (parse existing JSON, deduplicate recommendations, merge) directly into the init command's file-writing step. Keep `GENERACY_EXTENSIONS` as a constant in the init module.
- B) Fetch extensions list from `cluster-templates`: The fetched `extensions.json` from `cluster-templates` provides the Generacy extensions list. The CLI only needs to merge it with any existing file. No hardcoded extension list in the CLI.
- C) Skip merge, always overwrite: Simplify by always writing the fetched `extensions.json`. Users who want custom extensions can re-add them after init. Reduces complexity but loses the current "non-destructive" behavior.
**Answer**:

---

### Q7: TemplateContext Building (Steps 4-5) After Migration
**Context**: The current init flow builds a complex `TemplateContext` object (via `buildSingleRepoContext`/`buildMultiRepoContext`) containing project metadata, repo lists, orchestrator config, devcontainer settings, and cluster variant. This context is then passed to Handlebars for rendering. If `cluster-templates` handles rendering differently (or files are static), the entire context-building step may need to change. The spec says to "replace" the rendering pipeline but is vague about whether context building is also replaced or just the rendering part.
**Question**: After migration, does the CLI still need to build a `TemplateContext`-like object, or does the fetching approach eliminate that need entirely?
**Options**:
- A) No context needed: `cluster-templates` files are fetched as-is with no variable substitution. The context-building step (step 4) is removed entirely. The CLI only needs the variant to know which directory to fetch.
- B) Simplified context: The CLI builds a flat key-value map (e.g., `{projectName: "...", primaryRepo: "...", ...}`) for simple string substitution. No nested structure, no Zod validation.
- C) Same context, different renderer: The `TemplateContext` structure stays the same (or moves into the CLI), but instead of Handlebars it's used with a lighter rendering approach.
**Answer**:

---

### Q8: File List Parity Between Old Templates and cluster-templates
**Context**: The current `selectTemplates()` function produces a specific set of 11-12 files (depending on variant). US2 requires "generated files match the output from the cluster-templates repo." But the spec doesn't confirm that `cluster-templates` produces the exact same file set. If the file list differs (e.g., cluster-templates has additional files or uses different paths), the writer, conflict checker, and summary modules may need updates.
**Question**: Does the `cluster-templates` repo produce the exact same set of files at the same target paths as the current templates package?
**Options**:
- A) Exact match: Same files, same paths. The CLI can use the same target path mapping and the writer/conflict modules need no changes.
- B) Superset: `cluster-templates` may include additional files not in the current package. The CLI should fetch and write all files from the repo, updating the file list dynamically.
- C) Different paths: The files are equivalent but may use different directory structures or naming. A path mapping layer is needed in the CLI.
- D) Unknown — needs investigation: Someone needs to inspect the `cluster-templates` repo to confirm file parity before implementation begins.
**Answer**:

---

### Q9: Error Handling and Retry Strategy for Fetching
**Context**: The `generacy-cloud` worker classifies errors as `PermanentJobError` (404 → variant doesn't exist) vs `TransientJobError` (429, 5xx → retry). The CLI runs interactively with a human watching a spinner, so the retry UX is different from a background worker. The spec mentions no retry strategy for the CLI fetcher.
**Question**: Should the CLI retry failed template fetch requests, and how should different error types be communicated to the user?
**Options**:
- A) No retry, fail fast: If the fetch fails, print a descriptive error and exit. Users can re-run `generacy init` manually. Keeps the implementation simple.
- B) Retry with backoff for transient errors: Retry 429 and 5xx errors up to 3 times with exponential backoff. Show a spinner with "Retrying..." message. Fail immediately on 4xx errors (except 429).
- C) Retry with user prompt: On transient failure, ask the user "Template fetch failed. Retry? [Y/n]" before retrying. Gives the user control.
**Answer**:

---

### Q10: Pre-existing Test Bug Fix Scope
**Context**: FR-008 notes that `summary.test.ts` has a pre-existing bug — some test calls to `printSummary()` are missing the required `variant` parameter (the function signature is `printSummary(results, dryRun, variant)`). The spec says to "fix as part of FR-008" but doesn't specify whether the fix should use a default variant value or update every test case explicitly.
**Question**: How should the missing `variant` parameter in `summary.test.ts` be fixed?
**Options**:
- A) Add explicit variant to each test: Pass `'standard'` (or the relevant variant) to every `printSummary()` call in the test file. Most explicit and test-correct.
- B) Make variant optional with default: Change `printSummary()` signature to default `variant` to `'standard'` if not provided. Fixes tests and makes the API more forgiving.
**Answer**:
