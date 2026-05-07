# Clarifications

## Batch 1 — 2026-05-07

### Q1: Port Allocation Strategy
**Context**: The scaffolder currently emits hardcoded `HOST:CONTAINER` port bindings (`3100:3100`, `3101:3101`, `3102:3102`). The strategy choice determines how much work every CLI command needs for port discovery, and whether collisions are still possible.
**Question**: Should the scaffolder use ephemeral Docker-assigned ports (drop `HOST:` prefix, let Docker pick random host ports) or deterministic per-project offset ports (e.g. `3100 + N*10`)?
**Options**:
- A: Ephemeral — simpler scaffolder, but every CLI command must query Docker for live port mappings
- B: Deterministic offset — predictable ports, but collision risk grows with many clusters and requires a slot/counter mechanism
- C: Hybrid — ephemeral by default, with optional `--port-base` flag for users who want fixed ports

**Answer**: A — Ephemeral. Smallest scaffolder, no collision possible, pairs naturally with `generacy status` querying live Docker state. Deterministic offsets need a slot/counter mechanism that adds state for marginal benefit; the hybrid is easy to layer on later as `--port-base` if users actually ask for it.

### Q2: Port-to-Service Mapping
**Context**: The spec references ports 3100, 3101, and 3102, but doesn't document which in-cluster service is bound to each. Knowing this is prerequisite to deciding which ports actually need host-accessible mappings (e.g. a service only accessed via the relay WebSocket doesn't need a host port at all). This also subsumes the spec's Q2 about whether in-cluster services need to know their externally-mapped port.
**Question**: What service runs on each of the three exposed ports (3100, 3101, 3102), and which of them actually require host-accessible port bindings for the local developer workflow vs. being reachable only through the relay?

**Answer**: Only port 3100 (orchestrator) needs a host binding — local CLI/IDE extension hits this directly. Port 3101 (relay) is an outbound-only WebSocket client with no inbound listener. Port 3102 (control plane) is a Unix socket, never bound to TCP. Code-server is reached via the relay tunnel. The 3101 and 3102 host-port mappings in the current scaffolder are dead code and should be deleted.

### Q3: `generacy open` — Cloud URL vs Local URL
**Context**: The current `generacy open` implementation (`packages/generacy/src/cli/commands/open/index.ts:16`) opens `${context.cloudUrl}/clusters/${context.clusterId}` — a cloud-hosted URL. The spec says `generacy open` should "discover the cluster's UI port instead of assuming `3100`." These seem contradictory.
**Question**: Should `generacy open` change from opening the cloud URL to opening a local `http://localhost:<port>` URL, should it support both via a flag (e.g. `--local`), or is the spec referring to a different command/flow?
**Options**:
- A: Switch `open` to local URL only — the cloud dashboard is accessed through the browser directly
- B: Add `--local` flag — `open` defaults to cloud URL, `open --local` opens the local port
- C: Spec is stale — `open` keeps cloud URL behavior; port discovery is only needed for `status` output

**Answer**: C — Spec is stale. `generacy open` opens the cloud dashboard at `${cloudUrl}/clusters/${clusterId}`, which is the correct destination. Local-port discovery is only relevant for `generacy status` output. Keep `open` cloud-only.

### Q4: Migration Path for Existing Clusters
**Context**: Clusters scaffolded under the current code have hardcoded port bindings and may have colliding volume names. The companion PR fixes the `name:` field (and therefore volume namespacing), but existing `docker-compose.yml` files still contain `3100:3100` etc.
**Question**: Should existing clusters be auto-migrated (rewrite the compose file on next `generacy up`) or should migration be a documented manual step?
**Options**:
- A: Auto-rewrite — `generacy up` detects hardcoded ports in the compose file and regenerates it with the new strategy
- B: Manual migration — document the steps, warn on `generacy up` if legacy format detected but don't modify
- C: `generacy update` — add a `--migrate` flag to the existing update command that regenerates the compose file

**Answer**: B — Manual migration with a warning. v1.5 hasn't reached `@latest` yet, so the population of existing clusters with hardcoded ports is tiny. A `generacy up` warning when it detects legacy `3100:3100` bindings is enough — point users at a doc snippet to delete `.generacy/docker-compose.yml` and re-run.

### Q5: Deploy Command Port Behavior
**Context**: The shared `scaffoldDockerCompose` function (`packages/generacy/src/cli/commands/cluster/scaffolder.ts`) is called by both the `launch` command (local clusters) and the `deploy` command (remote SSH targets). The spec puts remote/SSH port management out of scope, but changing the shared scaffolder would affect both paths.
**Question**: Should the dynamic port change apply only when `deploymentMode` is `'local'`, or uniformly to all scaffolded compose files? If local-only, should the deploy path keep hardcoded ports (since remote VMs typically run a single cluster)?
**Options**:
- A: Local-only — gate the port change on `deploymentMode === 'local'`; deploy keeps fixed `3100:3100` bindings
- B: Uniform — all scaffolded compose files use dynamic ports regardless of deployment mode
- C: Split — extract port strategy into a scaffolder parameter so each caller controls its own behavior

**Answer**: A — Local-only, gate on `deploymentMode === 'local'`. Remote SSH-deployed clusters are single-cluster per VM by assumption; predictable host ports help with firewall/security-group config. The shared scaffolder already receives `deploymentMode`; one extra branch is sufficient.
