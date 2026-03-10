# Implementation Plan: 6.2 — Configuration Reference

## Summary

Rewrite the existing (outdated) reference documentation under `docs/docs/reference/` to accurately reflect the actual codebase. The current docs were written speculatively and document schemas, commands, and config surfaces that don't exist, while missing those that do. This plan replaces all existing reference files with accurate documentation derived directly from Zod schemas, Commander.js definitions, and Docker Compose files in the codebase.

New documentation will also be added for surfaces not currently covered: environment variables reference, Docker Compose configuration, and orchestrator config schema. Agency config will be a placeholder pending the Agency extension MVP (agency#294).

## Technical Context

- **Language:** Markdown (plain `.md` files)
- **Framework:** Docusaurus 3.7.0 (docs site framework — tracked separately)
- **Location:** `docs/docs/reference/` directory
- **Source of truth:** Zod schemas in `packages/*/src/config/`, Commander.js in `packages/generacy/src/cli/commands/`, Docker Compose YAML files
- **Dependencies:** None for implementation. Agency config section deferred until agency#294 ships.

## Architecture Overview

### File Structure (Final State)

```
docs/docs/reference/
├── _category_.json                          # (exists, no change)
├── api/
│   └── index.md                             # (exists, no change)
├── cli/
│   └── commands.md                          # REWRITE — replace with actual CLI commands
├── config/
│   ├── generacy.md                          # REWRITE — .generacy/config.yaml schema
│   ├── orchestrator.md                      # NEW — orchestrator config schema + env var mapping
│   ├── agency.md                            # REWRITE — placeholder with link to Agency repo
│   ├── humancy.md                           # (exists, keep as-is for now — out of scope)
│   ├── environment-variables.md             # NEW — consolidated env var reference
│   └── docker-compose.md                    # NEW — Docker Compose configuration
```

### Documentation Style

Follow the existing pattern established in the current reference docs:
- Frontmatter with `sidebar_position`
- Property-by-property breakdown: `**Type**:`, `**Required**: `, `**Default**: `
- Code blocks with `title=` attribute showing file paths
- Markdown tables for option reference (Property | Type | Default | Description)
- Complete working examples at end of each file
- Cross-references using `[text](/docs/reference/config/file)` format

## Implementation Phases

### Phase 1: `.generacy/config.yaml` Full Schema Reference
**File:** `docs/docs/reference/config/generacy.md` (rewrite)
**Source:** `packages/generacy/src/config/schema.ts`

**Tasks:**
1. Read the existing `generacy.md` to understand current structure
2. Replace all content with documentation derived from the actual `GeneracyConfig` Zod schema
3. Document all sections:
   - `schemaVersion` (string, default `"1"`)
   - `project` (required): `id` (format: `proj_{alphanumeric}`, min 12 chars), `name` (max 255 chars)
   - `repos` (required): `primary` (github.com/owner/repo format), `dev[]`, `clone[]`
   - `defaults` (optional): `agent` (kebab-case), `baseBranch`
   - `orchestrator` (optional): `pollIntervalMs` (min 5000), `workerCount` (1-20)
4. Include minimal and full YAML examples
5. Add cross-reference links to orchestrator config and env vars docs

**Validation:** Compare every field in the doc against `GeneracyConfig` Zod schema — 0 discrepancies.

---

### Phase 2: Orchestrator Config Schema + Env Var Mapping Table
**File:** `docs/docs/reference/config/orchestrator.md` (new)
**Sources:** `packages/orchestrator/src/config/schema.ts`, `packages/orchestrator/src/config/loader.ts`, `packages/orchestrator/src/worker/config.ts`

**Tasks:**
1. Create new file with sidebar_position after generacy.md
2. Document the `OrchestratorConfigSchema` with all sections:
   - `server`: `port` (default 3000), `host` (default 0.0.0.0)
   - `redis`: `url` (default redis://localhost:6379)
   - `auth`: `enabled`, `providers[]`, `github.{clientId,clientSecret,callbackUrl}`, `jwt.{secret,expiresIn}`
   - `rateLimit`: `enabled`, `max`, `timeWindow`
   - `cors`: `origin`, `credentials`
   - `logging`: `level`, `pretty`
   - `repositories[]`: `owner`, `repo`
   - `monitor`: `pollIntervalMs`, `webhookSecret`, `maxConcurrentPolls`, `adaptivePolling`
   - `prMonitor`: `enabled`, `pollIntervalMs`, `webhookSecret`, `adaptivePolling`, `maxConcurrentPolls`
   - `epicMonitor`: `enabled`, `pollIntervalMs`
   - `dispatch`: `pollIntervalMs`, `maxConcurrentWorkers`, `heartbeatTtlMs`, `heartbeatCheckIntervalMs` (**Q11: add**), `shutdownTimeoutMs`, `maxRetries`
   - `worker`: `phaseTimeoutMs`, `workspaceDir`, `shutdownGracePeriodMs`, `validateCommand`, `maxTurns`, `gates` (**Q12: brief mention**)
3. Add **env var → config field mapping table** (Q4):
   ```
   | Environment Variable | Config Path | Default | Precedence |
   ```
   With clear note: "Environment variables override config file values."
4. Document config file discovery: `orchestrator.yaml` → `orchestrator.yml` → `config/orchestrator.yaml` → `config/orchestrator.yml`
5. Document merge behavior: env vars > file > defaults
6. Include minimal and production YAML examples

**Validation:** Compare every field against `OrchestratorConfigSchema` Zod schema.

---

### Phase 3: Environment Variables Reference
**File:** `docs/docs/reference/config/environment-variables.md` (new)
**Source:** `packages/orchestrator/src/config/loader.ts`, `.env.example`, CLI command files

**Tasks:**
1. Create new file organized by audience (Q3):
   - **Operator Variables** (documented fully with examples):
     - Server: `ORCHESTRATOR_PORT`, `ORCHESTRATOR_HOST`
     - Redis: `REDIS_URL`, `ORCHESTRATOR_REDIS_URL`
     - Logging: `LOG_LEVEL`, `ORCHESTRATOR_LOG_LEVEL`
     - Monitor: `POLL_INTERVAL_MS`, `MONITORED_REPOS`, `WEBHOOK_SECRET`
     - Worker: `ORCHESTRATOR_URL`, `WORKER_CONCURRENCY`
     - Auth: `API_KEY`, `ORCHESTRATOR_TOKEN`, `GITHUB_TOKEN`
   - **Advanced Variables** (documented with brief descriptions):
     - Auth internals: `ORCHESTRATOR_AUTH_ENABLED`, `ORCHESTRATOR_JWT_SECRET`, `ORCHESTRATOR_JWT_EXPIRES_IN`
     - Rate limiting: `ORCHESTRATOR_RATE_LIMIT_*`
     - PR Monitor: `PR_MONITOR_*`
     - GitHub OAuth: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
2. Document per-service Redis variable handling (Q7):
   - Orchestrator uses `REDIS_URL` / `ORCHESTRATOR_REDIS_URL`
   - Worker (Docker) uses `REDIS_HOST` + `REDIS_PORT`
   - Note recommending standardization on `REDIS_URL`
3. Add `.env.example` reference with recommended additions beyond current 7 vars
4. Cross-reference to orchestrator config mapping table (Q10: hybrid)

**Validation:** Compare against `loader.ts` env var reads — ensure all ~39 vars are accounted for.

---

### Phase 4: Docker Compose Configuration
**File:** `docs/docs/reference/config/docker-compose.md` (new)
**Sources:** `docker-compose.yml`, `docker-compose.override.yml`, `docker/docker-compose.worker.yml`

**Tasks:**
1. Create new file documenting all three compose files
2. Document each service:
   - **orchestrator**: build context, ports (3000), env vars, health check, volumes
   - **worker**: build context, env vars, Docker socket mount, replicas (2), health check
   - **redis**: image (redis:7-alpine), port (6379), persistent volume, health check
3. Document the development override (hot reload, dev build target)
4. Document the standalone worker compose file with its differences:
   - Uses `REDIS_HOST`/`REDIS_PORT` instead of `REDIS_URL` (Q7)
   - Different health check endpoint (`/health/live` via wget)
5. Brief mention of `generacy-network` bridge network (Q13)
6. Document startup order and inter-service communication
7. Include a customization guide for operators (US4 from spec)

**Validation:** Compare against actual Docker Compose files.

---

### Phase 5: CLI Command Reference
**File:** `docs/docs/reference/cli/commands.md` (rewrite)
**Source:** `packages/generacy/src/cli/commands/*.ts`

**Tasks:**
1. Replace all content — existing docs reference commands that don't exist
2. Document the actual command hierarchy:
   ```
   generacy
   ├── init              # Initialize project
   ├── doctor            # Validate environment
   ├── validate          # Validate config file
   ├── run               # Execute workflow
   ├── worker            # Start job worker
   ├── agent             # Start AI agent worker
   ├── orchestrator      # Start orchestrator server
   └── setup
       ├── auth          # Configure credentials
       ├── workspace     # Clone repos & install deps
       ├── build         # Build packages
       └── services      # Start cloud services
   ```
3. For each command, document:
   - Description
   - Usage syntax
   - All flags/options with types, defaults, descriptions
   - Required vs optional
   - Related environment variables
   - Examples
4. Include `--release-stream` flag on `generacy init` (Q5)
5. Fix orchestrator default port to 3000 (Q9 — not 3100)
6. Document global options: `-l, --log-level`, `--no-pretty`

**Validation:** Compare every flag against Commander.js definitions in source.

---

### Phase 6: Agency Config Placeholder
**File:** `docs/docs/reference/config/agency.md` (rewrite)
**Approach:** Placeholder with link (Q6)

**Tasks:**
1. Replace speculative schema with honest placeholder
2. Provide the current known structure (top-level fields only)
3. Link to Agency extension repo for the latest schema
4. Note that the full schema reference will be added when agency#294 ships

---

### Phase 7: Update `.env.example`
**File:** `.env.example` (edit)

**Tasks:**
1. Add the most common operator-facing env vars beyond the current 7:
   - `ORCHESTRATOR_HOST`
   - `MONITORED_REPOS`
   - `WEBHOOK_SECRET`
   - `POLL_INTERVAL_MS`
   - `ORCHESTRATOR_URL` (for workers)
2. Add inline comments for each variable
3. Keep it concise — don't add all ~39 vars (Q3)

---

### Phase 8: Validation Audit
**No file output** — manual verification step.

**Tasks:**
1. Create a verification checklist comparing each doc against source:
   - `.generacy/config.yaml` fields vs `GeneracyConfig` Zod schema
   - Orchestrator config fields vs `OrchestratorConfigSchema`
   - Worker config fields vs `WorkerConfigSchema`
   - Env vars vs `loader.ts` reads
   - CLI flags vs Commander.js definitions
   - Docker services vs compose files
2. Verify all defaults, types, and constraints match
3. Verify all cross-references link to correct targets
4. Confirm 0 discrepancies (SC-005)

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Rewrite vs patch existing docs | Rewrite | Existing docs are entirely speculative and don't match any real code. Patching would be more work than rewriting. |
| Orchestrator config as separate file | New file (`orchestrator.md`) | The orchestrator has its own extensive schema that deserves dedicated documentation rather than being crammed into generacy.md |
| Env vars as separate file | New file (`environment-variables.md`) | ~39 env vars across multiple services is too much to embed in other files. Dedicated file with audience-based organization (Q3) |
| Docker compose as separate file | New file (`docker-compose.md`) | Three compose files with service definitions, volumes, networks needs its own page |
| Agency config approach | Placeholder + link | Schema is evolving, agency#294 hasn't shipped (Q6, Q14) |
| Humancy config | Leave as-is | Out of scope for this issue — separate tracking |
| Config precedence documentation | Mapping table in orchestrator.md | Most useful format for operators debugging settings (Q4) |
| Cross-referencing style | Hybrid | Canonical definition in one section, brief mentions with links elsewhere (Q10) |

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Schema changes during documentation | Docs immediately outdated | Document from Zod schemas (single source of truth). Note in issue that CI validation could follow. |
| Orchestrator port discrepancy (3000 vs 3100) | User confusion | Verified in source: default is 3000. Fix CLI docs to match (Q9). |
| Redis variable confusion | Failed connections | Document per-service behavior with clear callout (Q7). |
| Agency schema instability | Docs become wrong | Placeholder approach avoids documenting moving target (Q6). |
| Missing env vars | Incomplete reference | Systematic comparison against `loader.ts` in Phase 8 audit (Q8). |
| Existing docs links break | 404s from other pages | Check for internal links to current reference pages and update targets. |

## Dependencies

| Dependency | Status | Impact |
|------------|--------|--------|
| `.generacy/config.yaml` schema (`packages/generacy/src/config/schema.ts`) | Implemented | Unblocked — document from existing code |
| CLI commands (`packages/generacy/src/cli/commands/`) | Implemented | Unblocked — document from existing code |
| Orchestrator config (`packages/orchestrator/src/config/`) | Implemented | Unblocked — document from existing code |
| Docker Compose files | Exist | Unblocked — document from existing files |
| Agency extension MVP (agency#294) | Not shipped | Blocked — use placeholder approach |

## Out of Scope

- Humancy config reference update (separate tracking)
- Docs site framework changes (Docusaurus config, sidebars, etc.)
- Automated CI validation of docs vs schemas (potential follow-up)
- API endpoint reference (`docs/docs/reference/api/`)
- Agency config full schema (deferred to agency#294)
