# Clarifications

## Batch 1 — 2026-05-16

### Q1: FR-003 vs FR-005 Cleanup Sequencing
**Context**: FR-003 says "Delete remote `.docker/config.json` after pull regardless of outcome (try/finally)" and FR-005 says "Delete remote scoped config via SSH after successful credential forward." If FR-003 always deletes after pull, the file is already gone by the time FR-005 executes.
**Question**: Should FR-003 be the sole cleanup point (making FR-005 a belt-and-suspenders check that the file is gone), or should FR-003 only delete on pull success, leaving FR-005 as the true final cleanup after credential forwarding?
**Options**:
- A: FR-003 always deletes after pull (try/finally). FR-005 is a defensive re-check that tolerates file-not-found.
- B: FR-003 only deletes on pull success. On pull failure, the file persists for debugging until FR-005 or manual cleanup.

**Answer**: **A** — FR-003 always deletes the remote scoped config in `try/finally` after pull; FR-005 becomes a defensive recheck that tolerates file-not-found. Option B leaves credentials on the remote VM on pull failure, which is a bad security posture. Idempotent cleanup is the safer pattern.

### Q2: Credential Forward Transport
**Context**: FR-004 says "Forward credentials to credhelper via control-plane after cluster handshake." The deploy CLI has both cloud API access (via activation apiKey) and SSH access to the remote. Two plausible transports exist.
**Question**: Should the CLI forward credentials via: (a) an HTTP call through the cloud API (e.g., `PUT /api/clusters/:id/credentials` which proxies to control-plane via relay), or (b) a direct SSH command to the remote host hitting the control-plane Unix socket?
**Options**:
- A: Cloud API proxy (relay path) — decoupled from SSH, mirrors how the web UI writes credentials
- B: Direct SSH to control-plane socket — avoids cloud dependency, guaranteed reachable since SSH is already verified

**Answer**: **B** — Direct SSH to control-plane socket. SSH is already established; the control-plane is reachable via `docker compose exec orchestrator curl --unix-socket ...` over the same SSH connection. No relay round-trip, no cloud dependency, consistent with the local-launch credhelper-forward path.

### Q3: Credential Forward Timing
**Context**: The current `handleDeploy()` flow ends after `pollClusterStatus()` confirms `connected` and registers the cluster locally. Adding credential forwarding after the poll adds latency to the CLI (the cluster is already running).
**Question**: Should credential forwarding happen inline in `handleDeploy()` after `pollClusterStatus()` succeeds (blocking the CLI until forward completes), or should it be fire-and-forget / delegated to the cloud to handle asynchronously?
**Options**:
- A: Inline/blocking — CLI waits for forward to succeed before printing "deploy successful"
- B: Fire-and-forget — CLI triggers forward but doesn't wait for confirmation
- C: Cloud-delegated — cloud handles forward automatically after first handshake; CLI does nothing extra

**Answer**: **A** — Inline/blocking. The forward is fast (one SSH command wrapping one docker exec), and surfacing failure immediately is more valuable than hiding a quiet credhelper failure. The latency cost is small compared to the deploy time already waited through.

### Q4: Array vs Single Credential Handling
**Context**: `LaunchConfig.registryCredentials` is typed as `z.array(RegistryCredentialSchema).optional()` (an array), but the spec's Out of Scope says "Multi-registry authentication (single registry per deploy for now)." The current schema supports multiple entries.
**Question**: Should the implementation: (a) write all array entries to Docker `config.json` (supporting multiple registries transparently), or (b) assert/use only the first entry and warn if multiple are present?
**Options**:
- A: Write all entries — the Docker config.json `auths` object naturally supports multiple registries, no extra complexity
- B: First-only with warning — enforce the "single registry" constraint explicitly, reject or warn on multiple entries

**Answer**: **A** — Write all entries. Docker config.json's `auths` object natively supports multiple registries; iterating over an array adds no complexity. The "single registry per deploy" constraint is a UI/cloud-side limit, not something the CLI needs to enforce.

### Q5: Forward Failure Behavior
**Context**: If credential forwarding (FR-004) fails after the cluster is already running and healthy, the deploy is otherwise successful. Failing the entire command means the user has to re-deploy or manually intervene on an already-running cluster.
**Question**: If credential forwarding fails (e.g., control-plane rejects the request, relay not yet stable, timeout), should the CLI: (a) exit non-zero (hard fail), (b) warn and exit 0 (soft fail), or (c) retry with backoff and then warn/fail?
**Options**:
- A: Hard fail — exit 1, user must re-run or manually forward
- B: Soft fail — warn with remediation steps, exit 0 since cluster is running
- C: Retry (3 attempts, exponential backoff), then soft-fail if exhausted

**Answer**: **B** — Soft fail with clear remediation message. Cluster is already running and healthy; hard-failing because credhelper-forward failed is overkill. Print a remediation message suggesting `generacy registry-login --remote <host>` or re-entering credentials in generacy.ai. Adding 1-2 auto-retries with brief backoff before soft-failing is acceptable but not essential.
