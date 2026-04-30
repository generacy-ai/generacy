# Clarifications: CLI deploy ssh://host command (#500)

## Batch 1 — 2026-04-30

### Q1: Activation Client Extraction Strategy
**Context**: FR-004 says to reuse the activation flow from `packages/orchestrator/src/activation/`, but that code lives in the orchestrator package. The CLI (`@generacy-ai/generacy`) doesn't currently depend on `@generacy-ai/orchestrator`, and pulling in the entire orchestrator as a dependency would be heavy.
**Question**: Should the device-flow activation client be extracted into a shared package (e.g., `@generacy-ai/activation`), duplicated into the CLI package, or should the CLI depend on the orchestrator package directly?
**Options**:
- A: Extract into a new shared package (`@generacy-ai/activation`)
- B: Copy/adapt the activation client code into the CLI package
- C: Add `@generacy-ai/orchestrator` as a CLI dependency and import from it

**Answer**: *Pending*

### Q2: Pre-Approved Activation Semantics
**Context**: Step 2 of the SSH target flow says "auto-open the activation URL in the user's browser pre-approved with the calling user's session (or, if not signed-in locally, prompt and open the browser to sign in first)." This implies the CLI has some awareness of the user's cloud authentication state, but no existing CLI command establishes or stores cloud credentials locally.
**Question**: What does "pre-approved with the calling user's session" mean concretely? Does the CLI need to authenticate with the Generacy cloud first (e.g., via a stored API token or browser cookie) and pass session context to the device-code endpoint, or does the user authenticate during the device-flow as in the standard activation (#492) and "pre-approved" simply means the browser URL is opened automatically?

**Answer**: *Pending*

### Q3: Lifecycle Command SSH Routing
**Context**: The existing lifecycle commands (`stop`, `up`, `down`, `update`, `destroy` from #494) resolve clusters by walking up from cwd to find `.generacy/` directories and run `docker compose` locally. For SSH-deployed clusters, there is no local `.generacy/` directory on the remote path — only a registry entry with a `managementEndpoint`.
**Question**: How should lifecycle commands detect and handle SSH-deployed clusters? Should they check the registry's `managementEndpoint` field and transparently forward `docker compose` over SSH, or should there be a separate `--remote` flag? Should the existing `commands/cluster/compose.ts` helper be extended, or should SSH forwarding be a new helper?
**Options**:
- A: Transparently detect SSH clusters from registry `managementEndpoint` — no extra flags needed
- B: Require `--cluster=<id>` flag to route through registry; cwd-based resolution only for local clusters
- C: Add a `--remote` flag that explicitly enables SSH forwarding

**Answer**: *Pending*

### Q4: Compose Template Source and Image Tag
**Context**: The spec says to scaffold a `docker-compose.yml` and SCP it to the remote host, but doesn't specify where the compose template comes from or how the container image tag is determined. The `launch` command (#495) uses a `LaunchConfig` fetched from the cloud that includes `imageTag`, but the `deploy` command flow doesn't fetch a launch config.
**Question**: Where does the `docker-compose.yml` template come from for SSH deploy? Should the CLI fetch it from the cloud (similar to `launch`), bundle a default template, or generate one from the activation response? And how is the image tag determined — latest, channel-based (from `cluster.yaml`), or user-specified via a `--tag` flag?
**Options**:
- A: Fetch compose config from cloud via activation/launch-config endpoint
- B: Bundle a default template in the CLI package, use `latest` tag (or `--tag` override)
- C: Generate from a combination of cloud-fetched config and local `cluster.yaml` channel

**Answer**: *Pending*

### Q5: Registration Detection and Timeout
**Context**: FR-008 says to stream remote logs and FR-009 says to detect cluster registration (P2). The CLI needs to know when to stop streaming logs and report success. The `launch` command (#495) watches for a `"Go to:"` pattern in logs, but for SSH deploy the relevant signal is the cluster reaching "connected" status via the relay.
**Question**: What specific log pattern or signal indicates the cluster has successfully registered with the cloud? Is it output from the relay/orchestrator container (e.g., `"relay connected"`, `"handshake complete"`)? And what is the timeout — should the CLI wait indefinitely, or give up after a configurable period (e.g., `--timeout=300`)?

**Answer**: *Pending*
