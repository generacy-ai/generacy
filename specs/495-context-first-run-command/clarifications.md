# Clarifications: CLI Launch Command (Claim-Code First-Run Flow)

## Batch 1 — 2026-04-29

### Q1: CLI Package Location
**Context**: The spec states `packages/cli/src/commands/launch.ts`, but the existing CLI lives at `packages/generacy/src/cli/` using Commander.js. The `init`, `run`, `worker`, `orchestrator`, `doctor`, and other commands all live there. Creating a separate `packages/cli` would split the CLI surface across two packages.
**Question**: Should the `launch` command be added to the existing CLI at `packages/generacy/src/cli/commands/launch/` (consistent with how `init` and other commands are structured), or should a new `packages/cli` package be created as the spec states?
**Options**:
- A: Add to existing `packages/generacy/src/cli/commands/launch/` — consistent with current codebase
- B: Create new `packages/cli` — as spec states, separate package for cloud-flow commands

**Answer**: A — Add to existing `packages/generacy/src/cli/commands/launch/`. Cross-cutting decision applied to all four Phase 5 issues. Single CLI binary; `launch` follows the existing `init` directory pattern. See #494 for the full rationale.

### Q2: Cluster Registry Definition
**Context**: FR-011 requires "Register cluster in the local cluster registry" and the spec assumes "A local cluster registry mechanism exists or will be defined." No host-side cluster registry exists today. Inside the container, activation stores metadata at `/var/lib/generacy/cluster.json`, but that's container-internal. The `launch` command runs on the host and needs somewhere to track clusters so `generacy status` can list them.
**Question**: What is the host-side cluster registry? Should it be a JSON file (e.g., `~/.generacy/clusters.json`) mapping cluster IDs to project directories and Docker Compose locations? Or should `generacy status` simply scan for `.generacy/` directories?
**Options**:
- A: Central JSON file at `~/.generacy/clusters.json` — explicit registry of all known clusters
- B: Convention-based discovery — `generacy status` scans known paths (e.g., `~/Generacy/*/`) for `.generacy/` directories
- C: Define the registry format as part of this issue — provide the schema now

**Answer**: A — Central JSON file at `~/.generacy/clusters.json`. The schema is defined in #494's answers (rich shape with `{clusterId, name, path, composePath, variant, channel, cloudUrl, lastSeen, createdAt}`). This issue consumes the registry — `launch` adds entries to it on successful boot. `generacy status` (also #494) reads from it.

### Q3: Launch Config Response Schema
**Context**: FR-004 calls `GET /api/clusters/launch-config?claim=<code>` which returns "the project's chosen variant, peer repos list, default cluster ID, and cloud URL." The exact response shape is needed both for the stub implementation and for type-safe consumption. The existing `init` command uses fields like `project.id`, `project.name`, `repos.primary`, `repos.dev`, `cluster.variant` in `.generacy/config.yaml`.
**Question**: What is the exact JSON schema for the launch-config response? Specifically: does it include a `projectName` (needed for the default directory `~/Generacy/<project-name>`)? Does it include a full repos list (primary + dev + clone)? Does `clusterId` come from the cloud or is it generated locally?
**Options**:
- A: Minimal — `{ variant, cloudUrl, clusterId, claimStatus }` only; repos and project details fetched separately
- B: Full — `{ projectId, projectName, variant, cloudUrl, clusterId, repos: { primary, dev?, clone? }, imageTag }` — everything needed to scaffold in one call
- C: Align with `.generacy/config.yaml` shape — response mirrors the config schema so it can be written directly

**Answer**: B — Full response. `GET /api/clusters/launch-config?claim=<code>` returns `{ projectId, projectName, variant, cloudUrl, clusterId, imageTag, repos: { primary, dev?, clone? } }`. Single round-trip; the launch flow has everything it needs to scaffold without follow-up calls. The `clusterId` is generated cloud-side at this call so it's globally unique within the org. The `imageTag` is the specific GHCR tag (e.g., `ghcr.io/generacy-ai/cluster-base:1.5.0`) — keeps the CLI from pinning a version itself.

### Q4: Relationship with Init Command
**Context**: The existing `init` command already scaffolds `.generacy/config.yaml`, `.generacy/generacy.env.template`, and `.generacy/.gitignore` via a 12-step flow with interactive prompts, template fetching from GitHub, and conflict resolution. The `launch` command also writes `.generacy/cluster.yaml` and `docker-compose.yml`. There is significant overlap in file generation and project scaffolding.
**Question**: Should `launch` internally invoke or reuse the `init` command's file generation logic (treating launch as "init + docker compose up"), or should `launch` be a fully independent flow that writes only the files it needs (cluster.yaml, docker-compose.yml) and expects `init` to have been run separately?
**Options**:
- A: `launch` is standalone — writes its own minimal config files; `init` is for repo-based setup only
- B: `launch` calls `init` internally — reuses scaffolding logic, then adds Docker Compose + cluster start
- C: `launch` replaces `init` for cloud-claimed projects — new single entry point for cloud onboarding

**Answer**: A — `launch` is standalone — writes its own minimal config files; `init` remains for repo-based / interactive setups. Convergence between `launch` and `init` can come in a later release once both flows mature. For v1.5, `launch` writes only the cloud-flow files: `.generacy/cluster.yaml`, `.generacy/cluster.json`, `.generacy/docker-compose.yml`. `init`'s interactive prompts (template selection, conflict resolution) don't fit the cloud flow where everything is already chosen by the project's cloud-side configuration.

### Q5: Activation URL Log Pattern
**Context**: FR-009 requires streaming container logs until the activation URL appears. The existing activation flow (in `packages/orchestrator/src/activation/`) outputs a formatted box with `"Go to: {verification_uri}"` and `"Enter code: {user_code}"`. This is a device-code flow (RFC 8628), not a single clickable URL. The launch command needs to know what to match.
**Question**: Should the launch command match the `"Go to:"` line and extract the `verification_uri` to auto-open? Should it also display the `user_code` to the user? Or does the claim-code flow use a different activation mechanism (e.g., a direct URL with the claim code baked in, bypassing device-code)?
**Options**:
- A: Match `"Go to:"` pattern — extract verification_uri, display user_code, open verification_uri in browser
- B: Claim-code flow skips device-code — the claim code itself is the activation; watch for a different "ready" signal
- C: The launch command constructs the activation URL from the launch-config response — no log parsing needed

**Answer**: A — Match the `"Go to:"` line pattern, extract `verification_uri`, display the `user_code` prominently in the CLI output, auto-open the URL in the user's default browser on macOS/Windows. On Linux, print the URL with clear "Open this in your browser" instructions (per dev-cluster-architecture.md Open question #3). Note: the claim-code passed to `npx generacy launch` identifies the project to the cloud's launch-config endpoint, not the cluster activation itself. The cluster still runs the device-flow on first boot. A future enhancement (out of v1.5 scope) could pre-approve the device-code server-side using the claim — similar to cloud deploys' auto-bootstrap — to skip the browser prompt entirely.
