# Research: Configuration Reference Documentation

## Current State Analysis

### Existing Documentation (Outdated)

The `docs/docs/reference/` directory contains documentation that was written speculatively and does **not** match the actual codebase. These files need to be rewritten from scratch based on the real Zod schemas and Commander.js command definitions.

| File | Status | Issue |
|------|--------|-------|
| `config/generacy.md` | Outdated | Documents `generacy.config.json` — codebase uses `.generacy/config.yaml` with completely different schema |
| `config/agency.md` | Outdated | Speculative schema that doesn't match Agency's actual config |
| `config/humancy.md` | Outdated | Speculative schema that doesn't match Humancy's actual config |
| `cli/commands.md` | Outdated | Documents commands (`generacy start`, `generacy stop`, etc.) that don't exist; missing real commands (`generacy init`, `generacy worker`, `generacy doctor`, etc.) |

### Actual Configuration Sources in Codebase

| Surface | Source File | Schema Technology |
|---------|------------|-------------------|
| `.generacy/config.yaml` | `packages/generacy/src/config/schema.ts` | Zod (`GeneracyConfig`) |
| Orchestrator config | `packages/orchestrator/src/config/schema.ts` | Zod (`OrchestratorConfigSchema`) |
| Orchestrator env vars | `packages/orchestrator/src/config/loader.ts` | Manual env var mapping |
| Worker config | `packages/orchestrator/src/worker/config.ts` | Zod (`WorkerConfigSchema`) |
| Frontend worker types | `src/worker/types.ts` | Zod (various schemas) |
| CLI commands | `packages/generacy/src/cli/commands/*.ts` | Commander.js |
| Docker Compose | `docker-compose.yml`, `docker/docker-compose.worker.yml` | YAML |
| `.env.example` | `.env.example` | Plain text |

### Environment Variable Inventory

**Total env vars found in codebase:** ~39

**Operator-facing (document fully):** ~20
- Server: `ORCHESTRATOR_PORT`, `ORCHESTRATOR_HOST`
- Redis: `REDIS_URL`, `ORCHESTRATOR_REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`
- Logging: `LOG_LEVEL`, `ORCHESTRATOR_LOG_LEVEL`, `ORCHESTRATOR_LOG_PRETTY`
- Monitor: `POLL_INTERVAL_MS`, `ORCHESTRATOR_POLL_INTERVAL_MS`, `MONITORED_REPOS`
- Worker: `WORKER_CONCURRENCY`, `ORCHESTRATOR_URL`
- GitHub: `GITHUB_TOKEN`, `WEBHOOK_SECRET`
- Authentication: `API_KEY`, `ORCHESTRATOR_TOKEN`

**Advanced/Internal (document in "Advanced" section):** ~19
- Auth internals: `ORCHESTRATOR_AUTH_ENABLED`, `ORCHESTRATOR_JWT_SECRET`, `ORCHESTRATOR_JWT_EXPIRES_IN`
- Rate limiting: `ORCHESTRATOR_RATE_LIMIT_ENABLED`, `ORCHESTRATOR_RATE_LIMIT_MAX`, `ORCHESTRATOR_RATE_LIMIT_WINDOW`
- PR Monitor: `PR_MONITOR_ENABLED`, `PR_MONITOR_POLL_INTERVAL_MS`, `PR_MONITOR_WEBHOOK_SECRET`, `PR_MONITOR_ADAPTIVE_POLLING`, `PR_MONITOR_MAX_CONCURRENT_POLLS`
- GitHub OAuth: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ORCHESTRATOR_GITHUB_CALLBACK_URL`
- CORS: handled via config file only

### CLI Command Inventory

**Actual commands implemented (12 total):**

| Command | File | Status |
|---------|------|--------|
| `generacy init` | `commands/init/index.ts` | Implemented |
| `generacy doctor` | `commands/doctor.ts` | Implemented |
| `generacy validate` | `commands/validate.ts` | Implemented |
| `generacy run` | `commands/run.ts` | Implemented |
| `generacy worker` | `commands/worker.ts` | Implemented |
| `generacy agent` | `commands/agent.ts` | Implemented |
| `generacy orchestrator` | `commands/orchestrator.ts` | Implemented |
| `generacy setup auth` | `commands/setup/auth.ts` | Implemented |
| `generacy setup workspace` | `commands/setup/workspace.ts` | Implemented |
| `generacy setup build` | `commands/setup/build.ts` | Implemented |
| `generacy setup services` | `commands/setup/services.ts` | Implemented |

**Commands in existing docs that DON'T exist:** `generacy start`, `generacy stop`, `generacy status`, `generacy job`, `generacy workflow`, `generacy integration`, `generacy config`, `generacy deploy`, `generacy logs`

### Docker Compose Files

| File | Purpose | Services |
|------|---------|----------|
| `docker-compose.yml` | Main stack | orchestrator, worker (2 replicas), redis |
| `docker-compose.override.yml` | Dev overrides | Hot reload for orchestrator + worker |
| `docker/docker-compose.worker.yml` | Standalone worker | worker, redis |

### Key Decisions from Clarifications

1. **Output format:** Markdown files in `docs/docs/reference/` (Q1)
2. **Worker config:** Document all fields with stability notes (Q2)
3. **Env vars:** Document by audience — operator vs advanced (Q3)
4. **Config overlap:** Add env var → schema field mapping table (Q4)
5. **`--release-stream`:** Include in CLI docs (Q5)
6. **Agency config:** Placeholder with link to Agency repo (Q6)
7. **Redis vars:** Document per-service (Q7)
8. **Validation:** Manual audit with checklist (Q8)
9. **Orchestrator port:** Default is 3000 (fix CLI section) (Q9)
10. **Cross-references:** Hybrid — canonical definition + links (Q10)
11. **`dispatch.heartbeatCheckIntervalMs`:** Add to docs (Q11)
12. **Gates:** Brief mention only (Q12)
13. **Docker network:** Brief mention (Q13)
14. **Blocking deps:** Start all except Agency config (Q14)

### Redis Variable Discrepancy

- **Orchestrator:** reads `REDIS_URL` / `ORCHESTRATOR_REDIS_URL`
- **Worker (Docker):** reads `REDIS_HOST` + `REDIS_PORT` separately
- **Documentation approach:** Document per-service with standardization note
