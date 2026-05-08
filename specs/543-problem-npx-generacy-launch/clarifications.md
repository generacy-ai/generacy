# Clarifications for #543 — Fix launch CLI scaffolder

## Batch 1 — 2026-05-08

### Q1: Environment variable strategy (.env vs inline)
**Context**: FR-016 (P2) proposes generating a `.env` file alongside the compose. The current scaffolder inlines all 5 vars into the compose `environment:` block. The cluster-base compose references both `env_file: .env` and `env_file: .env.local` (optional). The choice affects whether users can easily override values and whether the scaffolder needs a second file writer.
**Question**: Should the scaffolder (a) generate a `.env` file for cloud-provided values and inline static ones into the compose, (b) inline all values in the compose `environment:` block with no `.env` file, or (c) generate a `.env` for all non-secret values and reference it via `env_file:`?
**Options**:
- A: Generate `.env` for cloud values, inline static values (spec proposal)
- B: Inline everything into compose `environment:` block (simplest, no extra file)
- C: Generate `.env` for all values, compose references it via `env_file:`

**Answer**: A — generate `.env` for cloud values, inline static values

This matches the existing cluster-base devcontainer compose pattern exactly:

- **`.env`** holds the values that vary per-project or per-environment and that users may want to override (REPO_URL, REPO_BRANCH, WORKER_COUNT, GENERACY_CHANNEL, the four GENERACY_* identity vars from LaunchConfig, etc.).
- **`environment:` inline in compose** holds derived/literal defaults (REDIS_URL, REDIS_HOST, HEALTH_PORT for worker, DEPLOYMENT_MODE, CLUSTER_VARIANT).

Option B (inline everything) breaks the override story — the user can't tweak WORKER_COUNT or GENERACY_CHANNEL without re-running `launch` or hand-editing the compose file. Option C (everything in .env) invites users to edit identity values like `GENERACY_CLUSTER_ID` that are not meant to be edited.

The pattern of `env_file: .env` + `env_file: .env.local` (optional) from the cluster-base compose carries over cleanly; the scaffolder writes `.env`, the user can layer `.env.local` for secrets (Anthropic key, etc.) without source-controlled values colliding.

---

### Q2: Complete environment variable inventory
**Context**: The current scaffolder emits 5 env vars (GENERACY_CLOUD_URL, GENERACY_CLUSTER_ID, GENERACY_PROJECT_ID, DEPLOYMENT_MODE, CLUSTER_VARIANT). The cluster-base compose uses 8+ vars. Missing variables may cause silent failures or degraded behavior at boot. The spec (Q3) flags this as unknown.
**Question**: What is the complete set of environment variables the orchestrator and worker services need at boot? Specifically, are the following required: `WORKER_COUNT`, `ORCHESTRATOR_PORT`, `REDIS_URL`, `GENERACY_ORG_ID`, `GENERACY_RELAY_URL`? Or should the scaffolder simply mirror whatever the cluster-base `.env.example` declares?

**Answer**: Mirror cluster-base's `.env.template` plus the four GENERACY_* identity vars from LaunchConfig

The canonical list is in [cluster-base/.devcontainer/generacy/.env.template](https://github.com/generacy-ai/cluster-base/blob/develop/.devcontainer/generacy/.env.template). Generated `.env` from the scaffolder should be:

```
# Identity (from cloud LaunchConfig, do not edit)
GENERACY_CLUSTER_ID=<from LaunchConfig.clusterId>
GENERACY_PROJECT_ID=<from LaunchConfig.projectId>
GENERACY_ORG_ID=<from LaunchConfig.orgId>
GENERACY_CLOUD_URL=<wss URL derived from LaunchConfig.cloudUrl — see note below>

# Project (from cloud, user may override)
PROJECT_NAME=<sanitized projectName>
REPO_URL=<from LaunchConfig.repos.primary>
REPO_BRANCH=main
GENERACY_CHANNEL=<from LaunchConfig.channel, default 'preview'>
WORKER_COUNT=1

# Cluster runtime
ORCHESTRATOR_PORT=3100
LABEL_MONITOR_ENABLED=true
WEBHOOK_SETUP_ENABLED=true
SKIP_PACKAGE_UPDATE=false
SMEE_CHANNEL_URL=
```

Inline in `environment:`:

- `REDIS_URL=redis://redis:6379`
- `REDIS_HOST=redis`
- `HEALTH_PORT=9001` (worker only)
- `DEPLOYMENT_MODE=local` (or `cloud` for deploy)
- `CLUSTER_VARIANT=cluster-base` (or other)

**Important name-collision note**: `GENERACY_CLOUD_URL` in the cluster's `.env` is a **relay WebSocket URL** (`wss://api-staging.generacy.ai/relay?projectId=<id>`), per the cluster-base `.env.template`. That's *not* the same value as `LaunchConfig.cloudUrl` (an HTTP base URL) or the `GENERACY_CLOUD_URL` env var the launch CLI itself reads (also an HTTP API base URL). The scaffolder needs to derive the wss URL from the cloud-provided base URL; the cloud should probably either send both or the cluster-relay package should derive it deterministically. Worth flagging this overload during plan phase — it's a footgun.

The vars I'd explicitly **drop** from the current scaffolder output that didn't make it to the new list: nothing — the four current ones (CLOUD_URL, CLUSTER_ID, PROJECT_ID, CLUSTER_VARIANT, DEPLOYMENT_MODE) all map onto the new list (with CLOUD_URL meaning shifting to relay WS URL).

---

### Q3: Worker count sourcing
**Context**: FR-015 says `ScaffoldComposeInput` gains a `workers` field and the compose uses `WORKER_COUNT`. Currently both launch and deploy scaffolders hardcode `workers: 1` in cluster.yaml. The cluster-base compose defaults to `${WORKER_COUNT:-3}`. The LaunchConfig schema has no workers field. This creates ambiguity about who owns the worker count.
**Question**: Should the worker count (a) always default to 1 for launch/deploy (user scales later via cluster.yaml), (b) default to the cluster-base image default of 3, or (c) be sourced from the cloud LaunchConfig if provided?
**Options**:
- A: Default to 1 (conservative, user scales up manually)
- B: Default to 3 (matches cluster-base image default)
- C: Source from cloud LaunchConfig (requires schema change)

**Answer**: A — default to 1

Local `launch` is a single-developer-on-one-task workflow. 3 worker containers eats >1GB of RAM and starts 3 idle Claude Code processes that the user almost certainly doesn't need. Conservative-by-default + user-scales-up matches the rest of the launch flow's "small footprint" posture. The cluster-base default of 3 is appropriate when people run the cluster as their *primary* dev environment via the devcontainer flow — `launch` is the lighter-weight first-run path.

Option C (source from cloud) is interesting future work — a paid-tier project might be entitled to default-3 workers — but the LaunchConfig schema doesn't carry it today, and adding it just to choose between 1 and 3 is over-engineered for now. Add it later if there's a reason.

`cluster.yaml`'s `workers: 1` already records the launch-time default; the scaffolder writes `WORKER_COUNT=1` into `.env` to keep the two in sync. Users who want more edit `.env` (or both, for consistency).

---

### Q4: Workspace volume mount path
**Context**: FR-010 lists `workspace` as a named volume but does not specify the container mount path. The cluster-base devcontainer uses a workspace volume, but the current scaffolder has no workspace volume at all — only `cluster-data:/var/lib/generacy`. The orchestrator/worker likely needs a shared workspace for repo cloning and agent work.
**Question**: What is the exact container mount path for the workspace volume? Is it `/workspaces` (standard devcontainer convention), `/workspaces/<project-name>`, or something else?

**Answer**: `/workspaces`

Standard devcontainer convention, matches cluster-base's compose 1:1, matches the image's `WORKINGDIR /workspaces` from the Dockerfile. The orchestrator's `resolve-workspace.sh` already handles picking a subdirectory under `/workspaces` based on what got cloned — no need for the scaffolder to compute `/workspaces/<project>` upfront.

If multi-repo cloning lands later (the LaunchConfig schema already has `repos.dev[]` and `repos.clone[]`), the convention naturally extends to `/workspaces/<repo-name>` per cloned repo, still inside the same volume mount.

---

### Q5: ~/.claude.json handling on remote deploys
**Context**: FR-017 says "pre-create `~/.claude.json` if missing" to prevent bind-mount failures. This works for `launch` (local), but `deploy` runs compose on a remote host via SSH where the host home directory is different. The spec's Q2 asks whether a named volume should replace the bind mount.
**Question**: For `launch` (local), should the scaffolder pre-create `~/.claude.json` on the host? For `deploy` (remote SSH), should the bind mount be replaced with a named volume, or should the remote `~/.claude.json` be created via SSH before compose up?
**Options**:
- A: Pre-create locally for launch; create via SSH for deploy (keeps bind mount)
- B: Use a named volume instead of bind mount for both launch and deploy (avoids the problem entirely)
- C: Pre-create for launch only; deploy uses a named volume (different strategies per command)

**Answer**: C — pre-create for launch only; deploy uses a named volume

Launch (local): pre-create `~/.claude.json` if missing. Reasons:
- Lets users with an existing local Claude Code install have their credentials/settings auto-flow into the cluster (the whole point of bind-mounting it).
- "If missing" guard avoids stomping on what's already there.
- Empty file is enough — Claude Code populates it on first auth.

Deploy (remote SSH): named volume.
- The remote VM doesn't have the user's local Claude config. Bind-mounting the *remote* user's `~/.claude.json` mounts the wrong file (the VM operator's, if anyone's).
- SCP'ing the local config to the remote before compose-up adds complexity, leaks credentials onto the remote filesystem in a known location, and is an ergonomic regression compared to the existing wizard flow.
- Named volume + onboarding-wizard-driven Claude auth = same UX as Flow A (cloud-deploy), which is what `deploy` is closest to philosophically.

Option B (named volume for both) loses the local-credentials-just-work property of launch; the user would always have to re-auth Claude inside the cluster. Worse UX for the more common case.
