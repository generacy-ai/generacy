# Tasks: 6.2 — Configuration Reference

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 0: Research & Preparation

### T001 Read source schemas and existing docs
**Files**:
- `packages/generacy/src/config/schema.ts`
- `packages/orchestrator/src/config/schema.ts`
- `packages/orchestrator/src/config/loader.ts`
- `packages/orchestrator/src/worker/config.ts`
- `docs/docs/reference/config/generacy.md`
- `docs/docs/reference/config/agency.md`
- `docs/docs/reference/cli/commands.md`
- Sub-task 1: Read and catalog every field in `GeneracyConfig` Zod schema (types, defaults, constraints, descriptions)
- Sub-task 2: Read and catalog every field in `OrchestratorConfigSchema` Zod schema
- Sub-task 3: Read and catalog every field in `WorkerConfigSchema`
- Sub-task 4: Read and catalog every environment variable read in `loader.ts` (~39 vars)
- Sub-task 5: Read the existing reference docs to understand current Docusaurus frontmatter conventions and documentation style

### T002 Read CLI command sources
**Files**:
- `packages/generacy/src/cli/commands/init.ts`
- `packages/generacy/src/cli/commands/doctor.ts`
- `packages/generacy/src/cli/commands/validate.ts`
- `packages/generacy/src/cli/commands/run.ts`
- `packages/generacy/src/cli/commands/worker.ts`
- `packages/generacy/src/cli/commands/agent.ts`
- `packages/generacy/src/cli/commands/orchestrator.ts`
- `packages/generacy/src/cli/commands/setup/*.ts`
- Sub-task 1: Catalog every command, its description, all flags/options (name, type, default, required/optional)
- Sub-task 2: Note global options (`-l, --log-level`, `--no-pretty`) from the root CLI setup
- Sub-task 3: Identify any related environment variables referenced in command files

### T003 [P] Read Docker Compose files
**Files**:
- `docker-compose.yml`
- `docker-compose.override.yml`
- `docker/docker-compose.worker.yml`
- Sub-task 1: Catalog all services, ports, volumes, environment variables, health checks, networks
- Sub-task 2: Note differences between main compose, dev override, and standalone worker compose
- Sub-task 3: Document the `generacy-network` bridge network configuration

### T004 [P] Check for internal links to existing reference pages
**Files**:
- `docs/docs/**/*.md`
- Sub-task 1: Search for any links pointing to reference pages being rewritten (`/docs/reference/config/generacy`, `/docs/reference/cli/commands`, `/docs/reference/config/agency`)
- Sub-task 2: Record all links that will need updating after rewrites

---

## Phase 1: `.generacy/config.yaml` Schema Reference

### T005 Rewrite generacy config reference
**File**: `docs/docs/reference/config/generacy.md`
**Source**: `packages/generacy/src/config/schema.ts`
- Sub-task 1: Replace all existing content (current docs are entirely speculative and reference non-existent fields)
- Sub-task 2: Add Docusaurus frontmatter with appropriate `sidebar_position`
- Sub-task 3: Document top-level structure: `schemaVersion`, `project`, `repos`, `defaults`, `orchestrator`
- Sub-task 4: Document `schemaVersion` — type: string, default: `"1"`
- Sub-task 5: Document `project` (required) — `id` (format: `proj_{alphanumeric}`, min 12 chars), `name` (max 255 chars)
- Sub-task 6: Document `repos` (required) — `primary` (github.com/owner/repo format URL), `dev[]` (array of URLs), `clone[]` (array of URLs)
- Sub-task 7: Document `defaults` (optional) — `agent` (kebab-case string), `baseBranch` (string)
- Sub-task 8: Document `orchestrator` (optional) — `pollIntervalMs` (min 5000), `workerCount` (1-20)
- Sub-task 9: Use property-by-property format: `**Type**:`, `**Required**:`, `**Default**:`
- Sub-task 10: Add minimal YAML example (required fields only)
- Sub-task 11: Add full YAML example (all fields populated)
- Sub-task 12: Add cross-reference links to orchestrator config (`/docs/reference/config/orchestrator`) and environment variables (`/docs/reference/config/environment-variables`)

---

## Phase 2: Orchestrator Config Schema

### T006 Create orchestrator config reference
**File**: `docs/docs/reference/config/orchestrator.md` (new)
**Sources**: `packages/orchestrator/src/config/schema.ts`, `packages/orchestrator/src/config/loader.ts`, `packages/orchestrator/src/worker/config.ts`
- Sub-task 1: Create new file with Docusaurus frontmatter (`sidebar_position` after generacy.md)
- Sub-task 2: Document config file discovery order: `orchestrator.yaml` → `orchestrator.yml` → `config/orchestrator.yaml` → `config/orchestrator.yml`
- Sub-task 3: Document merge/precedence behavior: environment variables > config file > schema defaults
- Sub-task 4: Document `server` section — `port` (default: 3000), `host` (default: 0.0.0.0)
- Sub-task 5: Document `redis` section — `url` (default: redis://localhost:6379)
- Sub-task 6: Document `auth` section — `enabled`, `providers[]`, `github.{clientId,clientSecret,callbackUrl}`, `jwt.{secret,expiresIn}`
- Sub-task 7: Document `rateLimit` section — `enabled`, `max`, `timeWindow`
- Sub-task 8: Document `cors` section — `origin`, `credentials`
- Sub-task 9: Document `logging` section — `level`, `pretty`
- Sub-task 10: Document `repositories[]` — `owner`, `repo`
- Sub-task 11: Document `monitor` section — `pollIntervalMs`, `webhookSecret`, `maxConcurrentPolls`, `adaptivePolling`
- Sub-task 12: Document `prMonitor` section — `enabled`, `pollIntervalMs`, `webhookSecret`, `adaptivePolling`, `maxConcurrentPolls`
- Sub-task 13: Document `epicMonitor` section — `enabled`, `pollIntervalMs`
- Sub-task 14: Document `dispatch` section — `pollIntervalMs`, `maxConcurrentWorkers`, `heartbeatTtlMs`, `heartbeatCheckIntervalMs`, `shutdownTimeoutMs`, `maxRetries`
- Sub-task 15: Document `worker` section — `phaseTimeoutMs`, `workspaceDir`, `shutdownGracePeriodMs`, `validateCommand`, `maxTurns`, `gates` (brief mention of gate concept)
- Sub-task 16: Add environment variable → config field mapping table (Environment Variable | Config Path | Default | Precedence)
- Sub-task 17: Add note: "Environment variables override config file values"
- Sub-task 18: Add minimal YAML example (server + redis only)
- Sub-task 19: Add production YAML example (full configuration)

---

## Phase 3: Environment Variables Reference

### T007 Create environment variables reference
**File**: `docs/docs/reference/config/environment-variables.md` (new)
**Sources**: `packages/orchestrator/src/config/loader.ts`, `.env.example`, CLI command files
- Sub-task 1: Create new file with Docusaurus frontmatter
- Sub-task 2: Organize by audience tier: **Operator Variables** (full docs) vs **Advanced Variables** (brief descriptions)
- Sub-task 3: Document Operator Variables — Server: `ORCHESTRATOR_PORT`, `ORCHESTRATOR_HOST`
- Sub-task 4: Document Operator Variables — Redis: `REDIS_URL`, `ORCHESTRATOR_REDIS_URL`
- Sub-task 5: Document Operator Variables — Logging: `LOG_LEVEL`, `ORCHESTRATOR_LOG_LEVEL`
- Sub-task 6: Document Operator Variables — Monitor: `POLL_INTERVAL_MS`, `MONITORED_REPOS`, `WEBHOOK_SECRET`
- Sub-task 7: Document Operator Variables — Worker: `ORCHESTRATOR_URL`, `WORKER_CONCURRENCY`
- Sub-task 8: Document Operator Variables — Auth: `API_KEY`, `ORCHESTRATOR_TOKEN`, `GITHUB_TOKEN`
- Sub-task 9: Document Advanced Variables — Auth internals: `ORCHESTRATOR_AUTH_ENABLED`, `ORCHESTRATOR_JWT_SECRET`, `ORCHESTRATOR_JWT_EXPIRES_IN`
- Sub-task 10: Document Advanced Variables — Rate limiting: `ORCHESTRATOR_RATE_LIMIT_*`
- Sub-task 11: Document Advanced Variables — PR Monitor: `PR_MONITOR_*`
- Sub-task 12: Document Advanced Variables — GitHub OAuth: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- Sub-task 13: Add per-service Redis variable callout: orchestrator uses `REDIS_URL`/`ORCHESTRATOR_REDIS_URL`, worker Docker uses `REDIS_HOST`+`REDIS_PORT`, with recommendation to standardize on `REDIS_URL`
- Sub-task 14: Add `.env.example` reference section noting current contents and recommended additions
- Sub-task 15: Add cross-reference to orchestrator config mapping table in `orchestrator.md`

---

## Phase 4: Docker Compose Configuration

### T008 Create Docker Compose configuration reference
**File**: `docs/docs/reference/config/docker-compose.md` (new)
**Sources**: `docker-compose.yml`, `docker-compose.override.yml`, `docker/docker-compose.worker.yml`
- Sub-task 1: Create new file with Docusaurus frontmatter
- Sub-task 2: Document main `docker-compose.yml` — overview of all three services
- Sub-task 3: Document **orchestrator** service — build context, ports (3000), environment variables, health check, volumes
- Sub-task 4: Document **worker** service — build context, environment variables, Docker socket mount (`/var/run/docker.sock`), replicas (2), health check
- Sub-task 5: Document **redis** service — image (`redis:7-alpine`), port (6379), persistent volume, health check
- Sub-task 6: Document `docker-compose.override.yml` — development overrides: hot reload volumes, dev build target
- Sub-task 7: Document `docker/docker-compose.worker.yml` — standalone worker: `REDIS_HOST`/`REDIS_PORT` instead of `REDIS_URL`, different health check (`/health/live` via wget)
- Sub-task 8: Document `generacy-network` bridge network and inter-service communication
- Sub-task 9: Document startup order and service dependencies (`depends_on` with health checks)
- Sub-task 10: Add operator customization guide — common overrides (scaling workers, changing ports, external Redis, custom volumes)

---

## Phase 5: CLI Command Reference

### T009 Rewrite CLI command reference
**File**: `docs/docs/reference/cli/commands.md`
**Source**: `packages/generacy/src/cli/commands/*.ts`
- Sub-task 1: Replace all existing content (current docs reference entirely non-existent commands like `generacy start`, `generacy stop`, `agency init`, `humancy workflow`, etc.)
- Sub-task 2: Add Docusaurus frontmatter preserving `sidebar_position`
- Sub-task 3: Document command hierarchy tree (init, doctor, validate, run, worker, agent, orchestrator, setup.{auth,workspace,build,services})
- Sub-task 4: Document global options: `-l, --log-level` (choices), `--no-pretty`
- Sub-task 5: Document `generacy init` — description, all flags including `--release-stream` (stable/preview), examples
- Sub-task 6: Document `generacy doctor` — description, flags, examples
- Sub-task 7: Document `generacy validate` — description, flags, examples
- Sub-task 8: Document `generacy run` — description, flags, examples
- Sub-task 9: Document `generacy worker` — description, flags (`--url`, `--worker-id`, `--health-port`, `--heartbeat-interval`), environment variables, examples
- Sub-task 10: Document `generacy agent` — description, flags (same as worker plus `--agency-mode`, `--agency-url`), examples
- Sub-task 11: Document `generacy orchestrator` — description, flags (`--port` default 3000 NOT 3100, `--host`, `--redis-url`, `--label-monitor`), environment variables, examples
- Sub-task 12: Document `generacy setup auth` — description, flags, examples
- Sub-task 13: Document `generacy setup workspace` — description, flags, examples
- Sub-task 14: Document `generacy setup build` — description, flags, examples
- Sub-task 15: Document `generacy setup services` — description, flags, examples
- Sub-task 16: For each command, use consistent format: Description, Usage, Options table (Flag | Type | Default | Description), Environment Variables, Examples

---

## Phase 6: Agency Config Placeholder

### T010 Rewrite agency config as placeholder
**File**: `docs/docs/reference/config/agency.md`
- Sub-task 1: Replace all speculative schema content with honest placeholder
- Sub-task 2: Add Docusaurus frontmatter preserving `sidebar_position`
- Sub-task 3: Document known top-level structure only (fields that are stable)
- Sub-task 4: Link to Agency extension repository for latest schema
- Sub-task 5: Add note that full schema reference will be added when agency#294 ships

---

## Phase 7: Update `.env.example`

### T011 Expand `.env.example` with common operator variables
**File**: `.env.example`
- Sub-task 1: Read current `.env.example` (currently 7 variables)
- Sub-task 2: Add `ORCHESTRATOR_HOST` with inline comment
- Sub-task 3: Add `MONITORED_REPOS` with inline comment and format example
- Sub-task 4: Add `WEBHOOK_SECRET` with inline comment
- Sub-task 5: Add `POLL_INTERVAL_MS` with inline comment
- Sub-task 6: Add `ORCHESTRATOR_URL` with inline comment (for workers connecting to orchestrator)
- Sub-task 7: Add section headers/comments grouping variables by purpose (Server, Redis, Auth, Monitor, Worker)
- Sub-task 8: Add inline comments to existing variables that lack them
- Sub-task 9: Keep concise — do not add all ~39 vars, only common operator-facing ones

---

## Phase 8: Cross-References & Link Fixes

### T012 Update internal cross-references
**Files**:
- `docs/docs/reference/config/generacy.md`
- `docs/docs/reference/config/orchestrator.md`
- `docs/docs/reference/config/environment-variables.md`
- `docs/docs/reference/config/docker-compose.md`
- `docs/docs/reference/cli/commands.md`
- Any other docs with links to rewritten pages
- Sub-task 1: Add cross-references between all new/rewritten docs (e.g., env vars page links to orchestrator mapping table, CLI page links to config docs)
- Sub-task 2: Fix any broken internal links found in T004 that pointed to old reference page structures
- Sub-task 3: Verify all `[text](/docs/reference/config/file)` format links resolve correctly

---

## Phase 9: Validation Audit

### T013 Validate generacy config docs against source
**Files**:
- `docs/docs/reference/config/generacy.md` (doc)
- `packages/generacy/src/config/schema.ts` (source)
- Sub-task 1: Compare every documented field against `GeneracyConfig` Zod schema
- Sub-task 2: Verify all types, defaults, and constraints match exactly
- Sub-task 3: Confirm 0 discrepancies

### T014 [P] Validate orchestrator config docs against source
**Files**:
- `docs/docs/reference/config/orchestrator.md` (doc)
- `packages/orchestrator/src/config/schema.ts` (source)
- `packages/orchestrator/src/worker/config.ts` (source)
- Sub-task 1: Compare every documented field against `OrchestratorConfigSchema` Zod schema
- Sub-task 2: Compare every documented field against `WorkerConfigSchema`
- Sub-task 3: Verify the env var → config mapping table is complete and correct
- Sub-task 4: Verify all types, defaults, and constraints match exactly

### T015 [P] Validate env vars docs against source
**Files**:
- `docs/docs/reference/config/environment-variables.md` (doc)
- `packages/orchestrator/src/config/loader.ts` (source)
- Sub-task 1: Compare every documented env var against actual `process.env` reads in `loader.ts`
- Sub-task 2: Ensure all ~39 environment variables are accounted for
- Sub-task 3: Verify no env vars are documented that don't exist in the code

### T016 [P] Validate CLI docs against source
**Files**:
- `docs/docs/reference/cli/commands.md` (doc)
- `packages/generacy/src/cli/commands/*.ts` (source)
- Sub-task 1: Compare every documented command and flag against Commander.js definitions
- Sub-task 2: Verify orchestrator default port is documented as 3000 (not 3100)
- Sub-task 3: Verify `--release-stream` flag on `generacy init` is documented
- Sub-task 4: Ensure no commands or flags are documented that don't exist

### T017 [P] Validate Docker Compose docs against source
**Files**:
- `docs/docs/reference/config/docker-compose.md` (doc)
- `docker-compose.yml` (source)
- `docker-compose.override.yml` (source)
- `docker/docker-compose.worker.yml` (source)
- Sub-task 1: Compare every documented service, port, volume, and env var against actual compose files
- Sub-task 2: Verify health check configurations match
- Sub-task 3: Verify network configuration matches

### T018 Verify all cross-reference links
**Files**:
- All docs under `docs/docs/reference/`
- Sub-task 1: Check every internal link resolves to an existing page
- Sub-task 2: Verify link text accurately describes the target
- Sub-task 3: Confirm 0 broken cross-references

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 0 (Research) must complete before all writing phases
- Phases 1–6 depend on Phase 0 research results
- Phase 7 (`.env.example`) is independent of doc writing and can run in parallel with Phases 1–6
- Phase 8 (Cross-references) must run after Phases 1–6 complete (needs all docs to exist)
- Phase 9 (Validation) must run after Phase 8 (needs final docs with cross-references)

**Parallel opportunities within phases**:
- T001, T002, T003, T004 — T003 and T004 can run in parallel with each other (marked [P])
- T005, T006, T007, T008, T009, T010 — all write to different files and can run in parallel once Phase 0 completes, **but** T007 (env vars) benefits from T006 (orchestrator) being done first for cross-reference alignment
- T011 — independent of all doc writes, can run any time after Phase 0
- T013, T014, T015, T016, T017 — all validate different docs and can run in parallel (marked [P])

**Recommended parallel groupings**:
- **Batch A** (Phase 0): T001 + T002 → T003 [P] + T004 [P]
- **Batch B** (Phases 1–6, after Batch A): T005 [P] + T008 [P] + T009 [P] + T010 [P] + T011 [P] → T006 → T007
- **Batch C** (Phase 8, after Batch B): T012
- **Batch D** (Phase 9, after Batch C): T013 [P] + T014 [P] + T015 [P] + T016 [P] + T017 [P] → T018

**Critical path**:
T001 → T005 → T006 → T007 → T012 → T013/T014/T015/T016/T017 → T018

**Estimated file changes**:
- 3 files rewritten: `generacy.md`, `agency.md`, `commands.md`
- 3 new files created: `orchestrator.md`, `environment-variables.md`, `docker-compose.md`
- 1 file edited: `.env.example`
- 0 source code changes
