# Clarifications: CLI Launch Command (Claim-Code First-Run Flow)

## Batch 1 — 2026-04-29

### Q1: CLI Package Location
**Context**: The spec states `packages/cli/src/commands/launch.ts`, but the existing CLI lives at `packages/generacy/src/cli/` using Commander.js. The `init`, `run`, `worker`, `orchestrator`, `doctor`, and other commands all live there. Creating a separate `packages/cli` would split the CLI surface across two packages.
**Question**: Should the `launch` command be added to the existing CLI at `packages/generacy/src/cli/commands/launch/` (consistent with how `init` and other commands are structured), or should a new `packages/cli` package be created as the spec states?
**Options**:
- A: Add to existing `packages/generacy/src/cli/commands/launch/` — consistent with current codebase
- B: Create new `packages/cli` — as spec states, separate package for cloud-flow commands

**Answer**: *Pending*

### Q2: Cluster Registry Definition
**Context**: FR-011 requires "Register cluster in the local cluster registry" and the spec assumes "A local cluster registry mechanism exists or will be defined." No host-side cluster registry exists today. Inside the container, activation stores metadata at `/var/lib/generacy/cluster.json`, but that's container-internal. The `launch` command runs on the host and needs somewhere to track clusters so `generacy status` can list them.
**Question**: What is the host-side cluster registry? Should it be a JSON file (e.g., `~/.generacy/clusters.json`) mapping cluster IDs to project directories and Docker Compose locations? Or should `generacy status` simply scan for `.generacy/` directories?
**Options**:
- A: Central JSON file at `~/.generacy/clusters.json` — explicit registry of all known clusters
- B: Convention-based discovery — `generacy status` scans known paths (e.g., `~/Generacy/*/`) for `.generacy/` directories
- C: Define the registry format as part of this issue — provide the schema now

**Answer**: *Pending*

### Q3: Launch Config Response Schema
**Context**: FR-004 calls `GET /api/clusters/launch-config?claim=<code>` which returns "the project's chosen variant, peer repos list, default cluster ID, and cloud URL." The exact response shape is needed both for the stub implementation and for type-safe consumption. The existing `init` command uses fields like `project.id`, `project.name`, `repos.primary`, `repos.dev`, `cluster.variant` in `.generacy/config.yaml`.
**Question**: What is the exact JSON schema for the launch-config response? Specifically: does it include a `projectName` (needed for the default directory `~/Generacy/<project-name>`)? Does it include a full repos list (primary + dev + clone)? Does `clusterId` come from the cloud or is it generated locally?
**Options**:
- A: Minimal — `{ variant, cloudUrl, clusterId, claimStatus }` only; repos and project details fetched separately
- B: Full — `{ projectId, projectName, variant, cloudUrl, clusterId, repos: { primary, dev?, clone? }, imageTag }` — everything needed to scaffold in one call
- C: Align with `.generacy/config.yaml` shape — response mirrors the config schema so it can be written directly

**Answer**: *Pending*

### Q4: Relationship with Init Command
**Context**: The existing `init` command already scaffolds `.generacy/config.yaml`, `.generacy/generacy.env.template`, and `.generacy/.gitignore` via a 12-step flow with interactive prompts, template fetching from GitHub, and conflict resolution. The `launch` command also writes `.generacy/cluster.yaml` and `docker-compose.yml`. There is significant overlap in file generation and project scaffolding.
**Question**: Should `launch` internally invoke or reuse the `init` command's file generation logic (treating launch as "init + docker compose up"), or should `launch` be a fully independent flow that writes only the files it needs (cluster.yaml, docker-compose.yml) and expects `init` to have been run separately?
**Options**:
- A: `launch` is standalone — writes its own minimal config files; `init` is for repo-based setup only
- B: `launch` calls `init` internally — reuses scaffolding logic, then adds Docker Compose + cluster start
- C: `launch` replaces `init` for cloud-claimed projects — new single entry point for cloud onboarding

**Answer**: *Pending*

### Q5: Activation URL Log Pattern
**Context**: FR-009 requires streaming container logs until the activation URL appears. The existing activation flow (in `packages/orchestrator/src/activation/`) outputs a formatted box with `"Go to: {verification_uri}"` and `"Enter code: {user_code}"`. This is a device-code flow (RFC 8628), not a single clickable URL. The launch command needs to know what to match.
**Question**: Should the launch command match the `"Go to:"` line and extract the `verification_uri` to auto-open? Should it also display the `user_code` to the user? Or does the claim-code flow use a different activation mechanism (e.g., a direct URL with the claim code baked in, bypassing device-code)?
**Options**:
- A: Match `"Go to:"` pattern — extract verification_uri, display user_code, open verification_uri in browser
- B: Claim-code flow skips device-code — the claim code itself is the activation; watch for a different "ready" signal
- C: The launch command constructs the activation URL from the launch-config response — no log parsing needed

**Answer**: *Pending*
