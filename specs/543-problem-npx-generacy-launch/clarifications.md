# Clarifications for #543 — Fix launch CLI scaffolder

## Batch 1 — 2026-05-08

### Q1: Environment variable strategy (.env vs inline)
**Context**: FR-016 (P2) proposes generating a `.env` file alongside the compose. The current scaffolder inlines all 5 vars into the compose `environment:` block. The cluster-base compose references both `env_file: .env` and `env_file: .env.local` (optional). The choice affects whether users can easily override values and whether the scaffolder needs a second file writer.
**Question**: Should the scaffolder (a) generate a `.env` file for cloud-provided values and inline static ones into the compose, (b) inline all values in the compose `environment:` block with no `.env` file, or (c) generate a `.env` for all non-secret values and reference it via `env_file:`?
**Options**:
- A: Generate `.env` for cloud values, inline static values (spec proposal)
- B: Inline everything into compose `environment:` block (simplest, no extra file)
- C: Generate `.env` for all values, compose references it via `env_file:`

**Answer**: *Pending*

### Q2: Complete environment variable inventory
**Context**: The current scaffolder emits 5 env vars (GENERACY_CLOUD_URL, GENERACY_CLUSTER_ID, GENERACY_PROJECT_ID, DEPLOYMENT_MODE, CLUSTER_VARIANT). The cluster-base compose uses 8+ vars. Missing variables may cause silent failures or degraded behavior at boot. The spec (Q3) flags this as unknown.
**Question**: What is the complete set of environment variables the orchestrator and worker services need at boot? Specifically, are the following required: `WORKER_COUNT`, `ORCHESTRATOR_PORT`, `REDIS_URL`, `GENERACY_ORG_ID`, `GENERACY_RELAY_URL`? Or should the scaffolder simply mirror whatever the cluster-base `.env.example` declares?

**Answer**: *Pending*

### Q3: Worker count sourcing
**Context**: FR-015 says `ScaffoldComposeInput` gains a `workers` field and the compose uses `WORKER_COUNT`. Currently both launch and deploy scaffolders hardcode `workers: 1` in cluster.yaml. The cluster-base compose defaults to `${WORKER_COUNT:-3}`. The LaunchConfig schema has no workers field. This creates ambiguity about who owns the worker count.
**Question**: Should the worker count (a) always default to 1 for launch/deploy (user scales later via cluster.yaml), (b) default to the cluster-base image default of 3, or (c) be sourced from the cloud LaunchConfig if provided?
**Options**:
- A: Default to 1 (conservative, user scales up manually)
- B: Default to 3 (matches cluster-base image default)
- C: Source from cloud LaunchConfig (requires schema change)

**Answer**: *Pending*

### Q4: Workspace volume mount path
**Context**: FR-010 lists `workspace` as a named volume but does not specify the container mount path. The cluster-base devcontainer uses a workspace volume, but the current scaffolder has no workspace volume at all — only `cluster-data:/var/lib/generacy`. The orchestrator/worker likely needs a shared workspace for repo cloning and agent work.
**Question**: What is the exact container mount path for the workspace volume? Is it `/workspaces` (standard devcontainer convention), `/workspaces/<project-name>`, or something else?

**Answer**: *Pending*

### Q5: ~/.claude.json handling on remote deploys
**Context**: FR-017 says "pre-create `~/.claude.json` if missing" to prevent bind-mount failures. This works for `launch` (local), but `deploy` runs compose on a remote host via SSH where the host home directory is different. The spec's Q2 asks whether a named volume should replace the bind mount.
**Question**: For `launch` (local), should the scaffolder pre-create `~/.claude.json` on the host? For `deploy` (remote SSH), should the bind mount be replaced with a named volume, or should the remote `~/.claude.json` be created via SSH before compose up?
**Options**:
- A: Pre-create locally for launch; create via SSH for deploy (keeps bind mount)
- B: Use a named volume instead of bind mount for both launch and deploy (avoids the problem entirely)
- C: Pre-create for launch only; deploy uses a named volume (different strategies per command)

**Answer**: *Pending*
