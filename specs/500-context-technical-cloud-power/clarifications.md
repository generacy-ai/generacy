# Clarifications: CLI deploy ssh://host command (#500)

## Batch 1 — 2026-04-30

### Q1: Activation Client Extraction Strategy
**Context**: FR-004 says to reuse the activation flow from `packages/orchestrator/src/activation/`, but that code lives in the orchestrator package. The CLI (`@generacy-ai/generacy`) doesn't currently depend on `@generacy-ai/orchestrator`, and pulling in the entire orchestrator as a dependency would be heavy.
**Question**: Should the device-flow activation client be extracted into a shared package (e.g., `@generacy-ai/activation`), duplicated into the CLI package, or should the CLI depend on the orchestrator package directly?
**Options**:
- A: Extract into a new shared package (`@generacy-ai/activation`)
- B: Copy/adapt the activation client code into the CLI package
- C: Add `@generacy-ai/orchestrator` as a CLI dependency and import from it

**Answer**: A — Extract a new shared package `@generacy-ai/activation-client`. Specifically the protocol-level device-flow client (init, poll-with-backoff, status decoding) — about ~200 LOC. The orchestrator's activation module (#492) wraps it with file-based key persistence; the CLI's deploy command wraps it with browser-open behavior. Both consume the same protocol client. The package is small enough that adding it is cheap, and avoids both the "depend on the whole orchestrator" weight (option C) and the drift risk of duplication (option B).

### Q2: Pre-Approved Activation Semantics
**Context**: Step 2 of the SSH target flow says "auto-open the activation URL in the user's browser pre-approved with the calling user's session (or, if not signed-in locally, prompt and open the browser to sign in first)." This implies the CLI has some awareness of the user's cloud authentication state, but no existing CLI command establishes or stores cloud credentials locally.
**Question**: What does "pre-approved with the calling user's session" mean concretely? Does the CLI need to authenticate with the Generacy cloud first (e.g., via a stored API token or browser cookie) and pass session context to the device-code endpoint, or does the user authenticate during the device-flow as in the standard activation (#492) and "pre-approved" simply means the browser URL is opened automatically?

**Answer**: "Pre-approved" was loose language in the spec — the CLI does not authenticate to the cloud directly. The CLI runs the device-flow against the cloud's unauthenticated device-code endpoint (same one used by #492's cluster-side flow), opens the `verification_uri` URL in the user's default browser, and the user approves via their existing generacy.ai browser session (cookie-authenticated). Same UX as `npx generacy launch` (#495). No CLI-stored credentials needed; no separate authentication step. Update the spec body to remove the "pre-approved with the calling user's session" phrasing — it implied a CLI-level auth that doesn't exist.

### Q3: Lifecycle Command SSH Routing
**Context**: The existing lifecycle commands (`stop`, `up`, `down`, `update`, `destroy` from #494) resolve clusters by walking up from cwd to find `.generacy/` directories and run `docker compose` locally. For SSH-deployed clusters, there is no local `.generacy/` directory on the remote path — only a registry entry with a `managementEndpoint`.
**Question**: How should lifecycle commands detect and handle SSH-deployed clusters? Should they check the registry's `managementEndpoint` field and transparently forward `docker compose` over SSH, or should there be a separate `--remote` flag? Should the existing `commands/cluster/compose.ts` helper be extended, or should SSH forwarding be a new helper?
**Options**:
- A: Transparently detect SSH clusters from registry `managementEndpoint` — no extra flags needed
- B: Require `--cluster=<id>` flag to route through registry; cwd-based resolution only for local clusters
- C: Add a `--remote` flag that explicitly enables SSH forwarding

**Answer**: A — Transparently detect SSH clusters from the registry's `managementEndpoint` field; no extra flags. The shared `getClusterContext()` helper from #494 reads the registry entry; if `managementEndpoint` starts with `ssh://`, lifecycle commands forward `docker compose` over SSH instead of running locally. Extend `commands/cluster/compose.ts` with an SSH-forwarding branch. Same `up`/`stop`/`down`/`destroy` UX whether local or remote — the user shouldn't have to remember which clusters live where.

### Q4: Compose Template Source and Image Tag
**Context**: The spec says to scaffold a `docker-compose.yml` and SCP it to the remote host, but doesn't specify where the compose template comes from or how the container image tag is determined. The `launch` command (#495) uses a `LaunchConfig` fetched from the cloud that includes `imageTag`, but the `deploy` command flow doesn't fetch a launch config.
**Question**: Where does the `docker-compose.yml` template come from for SSH deploy? Should the CLI fetch it from the cloud (similar to `launch`), bundle a default template, or generate one from the activation response? And how is the image tag determined — latest, channel-based (from `cluster.yaml`), or user-specified via a `--tag` flag?
**Options**:
- A: Fetch compose config from cloud via activation/launch-config endpoint
- B: Bundle a default template in the CLI package, use `latest` tag (or `--tag` override)
- C: Generate from a combination of cloud-fetched config and local `cluster.yaml` channel

**Answer**: A — Fetch compose config from the cloud's launch-config endpoint (the same `GET /api/clusters/launch-config?claim=<code>` endpoint used by `launch` in #495). After device-flow completion, the CLI uses the new cluster's identity to fetch the launch config including `imageTag`, then templates the compose file accordingly. Reuses #495's existing `LaunchConfig` shape.

### Q5: Registration Detection and Timeout
**Context**: FR-008 says to stream remote logs and FR-009 says to detect cluster registration (P2). The CLI needs to know when to stop streaming logs and report success. The `launch` command (#495) watches for a `"Go to:"` pattern in logs, but for SSH deploy the relevant signal is the cluster reaching "connected" status via the relay.
**Question**: What specific log pattern or signal indicates the cluster has successfully registered with the cloud? Is it output from the relay/orchestrator container (e.g., `"relay connected"`, `"handshake complete"`)? And what is the timeout — should the CLI wait indefinitely, or give up after a configurable period (e.g., `--timeout=300`)?

**Answer**: Poll the cloud's cluster status endpoint until `status === 'connected'`, with a 5-minute default timeout (configurable via `--timeout=<seconds>`). The CLI's log streaming continues for visibility, but the authoritative success signal is cloud-side: cluster registration is durable and queryable, while logs may be missed or buffered. After timeout, show an error pointing to `generacy status --cluster=<id>` for diagnosis. 5 minutes is generous enough for image pull (~1-2GB) plus startup on typical VMs.
