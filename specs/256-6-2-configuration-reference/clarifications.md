# Clarification Questions

## Status: Resolved

## Questions

### Q1: Output Format and Delivery
**Context**: The spec says this reference "will be published as part of the documentation site (tracked separately)" but doesn't specify what format the actual deliverable is — Markdown files in the repo, a generated docs site, MDX, or something else. The implementation approach depends heavily on this.
**Question**: What is the concrete output format for this configuration reference? Where should the files live in the repository?
**Options**:
- A) Markdown files in `docs/`: Plain Markdown files committed to the generacy repo under a `docs/reference/` directory
- B) MDX files for a docs framework: MDX files designed for a specific docs framework (Docusaurus, Nextra, etc.) with component imports
- C) Single comprehensive Markdown file: One large reference document covering all five sections
- D) Spec-only (no implementation): This spec is purely a content plan; the actual docs site implementation is tracked in a separate issue
**Answer**: A) Markdown files in `docs/`. The buildout plan (6.1) explicitly states docs "Live in `generacy/docs/` (public, accessible to adopters)." There's already an existing structure at `docs/docs/reference/config/` with a (now outdated) `generacy.md` reference file. The docs site framework is tracked separately — this issue should just produce the Markdown content in the existing directory structure.

---

### Q2: Worker Config Schema Coverage
**Context**: The orchestrator config schema (FR-020) references a `WorkerConfigSchema` with fields like `phaseTimeoutMs`, `workspaceDir`, `shutdownGracePeriodMs`, `validateCommand`, `maxTurns`, and `gates`. These fields exist in `packages/orchestrator/src/config/worker/config.ts` but are completely absent from the spec. These are critical for operators tuning worker behavior.
**Question**: Should the worker config schema fields be documented as part of FR-020, or are they intentionally omitted because they are internal/unstable?
**Options**:
- A) Document fully: Add all `WorkerConfigSchema` fields to the orchestrator config reference section
- B) Document partially: Document only stable fields (`phaseTimeoutMs`, `workspaceDir`, `shutdownGracePeriodMs`) and mark others as internal
- C) Omit intentionally: These are internal implementation details not meant for operator configuration
**Answer**: A) Document fully. The buildout plan acceptance criteria for 6.2 is "All configuration options documented with examples." The worker config fields (`phaseTimeoutMs`, `workspaceDir`, `shutdownGracePeriodMs`, `validateCommand`, `maxTurns`, `gates`) are all operator-relevant for tuning worker behavior. Mark any fields that may change with a stability note rather than omitting them.

---

### Q3: Environment Variable Completeness
**Context**: The spec documents ~25 environment variables, but the actual codebase uses significantly more. The orchestrator config loader (`packages/orchestrator/src/config/loader.ts`) reads 20+ additional variables with `ORCHESTRATOR_*` prefixes (e.g., `ORCHESTRATOR_AUTH_ENABLED`, `ORCHESTRATOR_JWT_SECRET`, `ORCHESTRATOR_RATE_LIMIT_MAX`, `PR_MONITOR_ENABLED`, `WEBHOOK_SECRET`). The `.env.example` file only contains 6 variables. The spec's environment variable section has major gaps vs. the actual code.
**Question**: Should the environment variables section document every variable the code reads, or only a curated subset? And should `.env.example` be updated to match?
**Options**:
- A) Document all: Every environment variable read by any service should be listed, grouped by service
- B) Document essential + link to source: Document the most important variables and reference the config loader source for the complete list
- C) Document by audience: Document operator-facing variables fully, mark developer/internal variables as advanced
**Answer**: C) Document by audience. The orchestrator config loader reads ~39 env vars, but `.env.example` only lists 7. Documenting all 39 in equal detail would overwhelm operators. Document operator-facing variables fully (server, Redis, polling, worker config) and group developer/internal variables (auth internals, rate limiting, PR monitor tuning) in an "Advanced" section. Update `.env.example` to include the most common operator-facing ones beyond the current 7.

---

### Q4: Orchestrator Config vs. Environment Variables Overlap
**Context**: The orchestrator has two configuration surfaces: environment variables (Section 3) and the `OrchestratorConfigSchema` (FR-020). Many settings can be configured via either mechanism (e.g., `ORCHESTRATOR_PORT` env var maps to `server.port` in the schema). The spec documents both but doesn't clarify the relationship or precedence between them.
**Question**: How should the documentation handle the overlap between environment variables and the orchestrator config schema? Should it show a mapping table or treat them as separate concerns?
**Options**:
- A) Mapping table: Add an explicit table showing which env vars map to which schema fields, with precedence rules
- B) Unified reference: Merge into a single section that shows each setting with both its env var name and schema path
- C) Keep separate: Document them independently (as the spec currently does) with a brief note about precedence
**Answer**: A) Mapping table. A reference doc needs to be unambiguous. Add an explicit table showing which env vars map to which schema fields, with a clear precedence rule (e.g., "Environment variables override config file values"). This is the most useful format for operators debugging why a setting isn't taking effect.

---

### Q5: `--release-stream` Flag on `generacy init`
**Context**: The `generacy init` command implementation includes a `--release-stream` flag with choices `stable` or `preview` (found in `packages/generacy/src/cli/commands/init/index.ts`). This flag appears in the CLI options table in Section 5 but is missing from the FR-010 requirement. It's unclear whether this is an intentional omission from the functional requirements or an oversight.
**Question**: Is the `--release-stream` flag a stable, documented feature that should be included in FR-010, or is it experimental/internal?
**Options**:
- A) Include in FR-010: It's a stable feature that should be formally documented
- B) Omit from reference: It's experimental and should not be documented yet
**Answer**: A) Include in FR-010. The flag exists in the code (`packages/generacy/src/cli/commands/init/index.ts`, line 48-51) with choices `['stable', 'preview']` defaulting to `'stable'`. Release streams are a core concept in the buildout plan (the entire "Release Streams" section defines the stable/preview dual-stream model). This is clearly intentional and stable.

---

### Q6: Agency Config Schema Depth
**Context**: The `agency.config.json` section (Section 2) documents only top-level fields with generic types like `array` for `plugins`, `modes[].tools`, and `containers`. No detail is given about what a plugin object looks like, what tool definitions contain, or what container configuration options exist. The spec assumption notes the schema "is still evolving," but the current documentation is too shallow to be useful as a reference.
**Question**: How much detail should the Agency config reference provide given the schema is still evolving?
**Options**:
- A) Document current state fully: Document all known fields/sub-schemas as they exist today, with a note that they may change
- B) Document stable fields only: Document top-level structure and only the fields unlikely to change
- C) Placeholder with link: Provide the current example and link to the Agency extension repo for the latest schema
- D) Defer entirely: Remove Agency config from this spec and track it under the Agency extension docs
**Answer**: C) Placeholder with link. The buildout plan lists agency#294 (Agency extension MVP) as a blocking dependency for this issue, and the plan itself notes the schema "is still evolving." Provide the current example structure and link to the Agency repo for the latest schema. This avoids documenting a moving target while still giving users something useful.

---

### Q7: REDIS_HOST/REDIS_PORT vs. REDIS_URL
**Context**: The Docker Compose worker file (`docker/docker-compose.worker.yml`) uses `REDIS_HOST` and `REDIS_PORT` as separate environment variables, while the main documentation and `.env.example` only reference `REDIS_URL`. This creates confusion about which format services actually accept.
**Question**: Do services accept both `REDIS_URL` and separate `REDIS_HOST`/`REDIS_PORT` variables? Which takes precedence?
**Options**:
- A) REDIS_URL only: `REDIS_HOST`/`REDIS_PORT` in docker-compose are composed into a URL at container level; document only `REDIS_URL`
- B) Both supported: Services accept either format; document both with precedence rules
- C) Different per service: Orchestrator uses `REDIS_URL`, workers use `REDIS_HOST`/`REDIS_PORT`; document per-service
**Answer**: C) Different per service. The codebase confirms this: the orchestrator config loader reads `REDIS_URL` / `ORCHESTRATOR_REDIS_URL`, while `docker/docker-compose.worker.yml` sets `REDIS_HOST=redis` and `REDIS_PORT=6379` for workers. Document per-service with a note recommending standardization on `REDIS_URL` in future.

---

### Q8: Validation Scope for Implementation
**Context**: Success criterion SC-005 requires "0 discrepancies between documentation and implementation" and mentions "automated validation or manual audit." The spec doesn't define how this validation will be performed or maintained over time. Given the large surface area (5 config surfaces, 30+ env vars, 8+ CLI commands), manual verification is error-prone.
**Question**: Is there an expectation for automated validation tooling (e.g., a script that compares docs against Zod schemas and Commander.js registrations), or is a one-time manual audit sufficient?
**Options**:
- A) Automated validation: Build a script that extracts fields from Zod schemas and Commander registrations and compares against docs
- B) Manual audit with checklist: One-time manual review with a checklist, re-run when schemas change
- C) CI integration: Add a CI check that fails when docs drift from source schemas
**Answer**: B) Manual audit with checklist. Automated validation is overengineering for the initial documentation pass. A manual checklist comparing docs against Zod schemas and Commander.js registrations is sufficient for v1. Add a note in the issue that CI validation could be a follow-up if docs drift becomes a recurring problem.

---

### Q9: Orchestrator Port Discrepancy
**Context**: There is an inconsistency in the spec regarding the orchestrator's default port. The Docker Compose section (Section 4) says the orchestrator runs on port `3000`, and the environment variables section lists `ORCHESTRATOR_PORT` defaulting to `3000`. However, the CLI reference for `generacy orchestrator` lists the `-p, --port` flag defaulting to `3100`. The actual code should be checked to determine the correct default.
**Question**: What is the canonical default port for the orchestrator? The spec is internally inconsistent (3000 in Docker/env vars, 3100 in CLI).
**Options**:
- A) 3000: The Docker Compose / env var default is correct; fix the CLI section
- B) 3100: The CLI default is correct; the Docker Compose overrides it to 3000
- C) Both are correct: Docker deployments use 3000, local CLI uses 3100 to avoid conflicts
**Answer**: A) 3000. The actual code confirms it: `ServerConfigSchema` in `packages/orchestrator/src/config/schema.ts` defaults to `3000`. Docker-compose also maps to `3000`. The CLI spec's `3100` reference was an error — fix the CLI section to match the code.

---

### Q10: Cross-referencing Between Sections
**Context**: The five reference sections have significant overlap (e.g., `orchestrator.pollIntervalMs` in config.yaml vs. `POLL_INTERVAL_MS` env var vs. `--poll-interval` CLI flag vs. `monitor.pollIntervalMs` in orchestrator schema). The spec doesn't specify how to handle cross-references between sections — should each section be self-contained, or should they link to each other?
**Question**: Should the reference sections be self-contained (with some duplication) or heavily cross-referenced (with links between sections)?
**Options**:
- A) Self-contained: Each section is standalone; duplicate information where needed for readability
- B) Cross-referenced: Minimize duplication by linking between sections (e.g., "See Environment Variables > Worker for details")
- C) Hybrid: Primary definition in one section with brief mentions and links elsewhere
**Answer**: C) Hybrid. Define each setting canonically in one section (e.g., `orchestrator.pollIntervalMs` is primarily documented in the config schema section), with brief mentions and links in related sections (env vars, CLI flags). Avoids duplication drift while keeping sections usable standalone.

---

### Q11: `dispatch.heartbeatCheckIntervalMs` Missing from Spec
**Context**: The orchestrator config schema in the codebase (`packages/orchestrator/src/config/schema.ts`) includes a `dispatch.heartbeatCheckIntervalMs` field (number, min 5000, default 15000) described as "Interval between heartbeat/reaper checks." This field is absent from the spec's orchestrator config table (FR-020), which otherwise documents the dispatch section thoroughly.
**Question**: Is `dispatch.heartbeatCheckIntervalMs` a stable field that should be added to FR-020, or is it an internal implementation detail?
**Options**:
- A) Add to spec: It's a stable, operator-relevant configuration field
- B) Omit: It's an internal detail that operators shouldn't need to tune
**Answer**: A) Add to spec. Confirmed in the codebase: `z.number().int().min(5000).default(15000)` in `DispatchConfigSchema`. It controls heartbeat/reaper check intervals — directly relevant for operators tuning dispatch reliability. The rest of the dispatch section is documented; this field was simply missed.

---

### Q12: Gates Configuration
**Context**: The `WorkerConfigSchema` includes a `gates` field described as "Gate definitions keyed by issue label." This appears to be a significant feature that controls workflow gating behavior, but it's not mentioned anywhere in the spec. If gates are user-facing, they need documentation; if they're internal, the omission is fine.
**Question**: Is the `gates` configuration in WorkerConfig a user-facing feature that needs documentation in this reference?
**Options**:
- A) Document: Gates are user-facing and should be documented with their label-to-gate mappings
- B) Omit: Gates are internal/experimental and not ready for documentation
- C) Brief mention: Add a note about gates existing without full schema documentation
**Answer**: C) Brief mention. Gates control workflow gating behavior keyed by issue label, which aligns with the core "label-driven development" model in the buildout plan. However, the full gate schema (phase definitions, label mappings) appears to still be evolving. Add a brief mention that gates exist with a note that full documentation is forthcoming.

---

### Q13: Docker Compose Network Documentation
**Context**: The Docker Compose files define a `generacy-network` bridge network that connects all services. The spec's Docker Compose section documents services, ports, and volumes but doesn't mention the network configuration. For operators customizing deployments (US4), network topology is relevant.
**Question**: Should the Docker Compose reference document the network configuration?
**Options**:
- A) Document fully: Include network name, driver, and which services are attached
- B) Brief mention: Note that services share a bridge network without detailed config
- C) Omit: Network config is standard Docker Compose behavior and doesn't need documentation
**Answer**: B) Brief mention. Note that services share a `generacy-network` bridge network. Full network topology documentation is unnecessary since it's standard Docker Compose behavior, but mentioning it helps operators who need to integrate with existing infrastructure or customize network settings.

---

### Q14: Source of Truth for Blocked Dependencies
**Context**: The spec lists two blocking dependencies: #248 (config.yaml schema) and agency#294 (Agency extension MVP). However, the codebase exploration shows that the config schema (`packages/generacy/src/config/schema.ts`) and CLI commands already exist and are implemented. If these dependencies are already partially or fully implemented, the blocking status may be incorrect, which affects when this work can begin.
**Question**: Are the blocking dependencies (#248 and agency#294) actually blocking, or can this reference documentation work begin now based on the current codebase state?
**Options**:
- A) Blocked: Wait for both dependencies to be formally completed before starting
- B) Partially unblocked: Start with sections based on existing code (config.yaml, CLI, Docker, env vars); defer Agency config
- C) Fully unblocked: All source material exists in the codebase; begin all sections now
**Answer**: B) Partially unblocked. The codebase confirms: `config.yaml` schema exists and is implemented (`packages/generacy/src/config/schema.ts`), CLI commands exist, Docker Compose files exist, env vars are in active use. The only genuinely blocked section is Agency config (`agency.config.json`), since agency#294 (Agency extension MVP) hasn't shipped. Start all sections except Agency config now.
