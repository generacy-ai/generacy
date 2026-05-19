# Clarifications: 652-repro-1-launch-cluster

## Batch 1 — 2026-05-19

### Q1: Cross-Repo Scope
**Context**: The spec states "Changes span both generacy (orchestrator) and cluster-base (shell scripts) repos." The post-activation watcher (`post-activation-watcher.sh`) and post-activation script (`entrypoint-post-activation.sh`) live in cluster-base, while orchestrator/control-plane TypeScript lives in this repo. This determines what to implement in this branch vs a companion cluster-base PR.
**Question**: Which changes go in this generacy branch vs a companion cluster-base PR? Specifically: does cluster-base get a companion PR for (a) writing the completion flag at the end of post-activation, and (b) the defensive cleanup logic (FR-005/FR-006)?
**Options**:
- A: Generacy-only — orchestrator detects state and creates the `/tmp` trigger file; completion flag written by new TypeScript code that monitors post-activation exit; no cluster-base changes needed
- B: Split — generacy branch handles startup detection + retry trigger; cluster-base companion PR handles completion flag write + defensive cleanup inside the shell scripts
- C: Generacy-only with shell script inline — embed any needed shell changes in the scaffolded docker-compose or entrypoint override, avoiding a cluster-base PR

**Answer**: B** — split. Generacy branch handles startup detection + retry trigger; cluster-base companion PR handles completion flag write + defensive cleanup inside the shell scripts.

The post-activation script lives in cluster-base — it owns that lifecycle. The natural place to write "I completed" is at the end of the script that completed. The orchestrator's job is to know whether to skip vs retry on next startup. Option A (generacy-only) requires the TypeScript orchestrator to track shell-process exit codes from another container/process — awkward inter-process plumbing for state the script itself already knows. Option C (embed shell in docker-compose / entrypoint override) puts image-shaped logic outside the image — wrong layer, and creates a maintenance trap where cluster-base changes can quiet override or conflict with the scaffolded logic.

---

### Q2: Retry Trigger Mechanism
**Context**: When the orchestrator detects "activated but post-activation incomplete" on startup, it needs to trigger the retry. The current first-boot flow is: cloud sends `bootstrap-complete` lifecycle action → control-plane writes `/tmp/generacy-bootstrap-complete` → watcher detects file → runs post-activation script. The lifecycle action also re-unseals credentials and starts code-server/VS Code tunnel.
**Question**: Should the retry path replay the full `bootstrap-complete` lifecycle action (which also re-unseals credentials and starts code-server), or should it just create the `/tmp` trigger file directly (reusing only the watcher, skipping credential unsealing)?
**Options**:
- A: Replay full lifecycle action — orchestrator sends `POST /lifecycle/bootstrap-complete` to control-plane on startup, getting credential re-unsealing and code-server start for free
- B: Touch trigger file only — orchestrator/control-plane creates `/tmp/generacy-bootstrap-complete` directly, relying on persisted `wizard-credentials.env` from the first attempt
- C: Direct invocation — bypass the watcher entirely; orchestrator spawns the post-activation script directly

**Answer**: A** — replay the full `bootstrap-complete` lifecycle action.

Matches the first-boot path exactly, gets credential re-unsealing (Q4) and code-server start for free, and uses the same control-plane mechanism rather than inventing a parallel one. The orchestrator's startup code can call `POST /lifecycle/bootstrap-complete` against its own local control-plane (or invoke the underlying handler function directly — same code path). Option B (touch trigger file only) relies on the persisted `wizard-credentials.env` being fresh, which conflicts with Q4's freshness concern. Option C (direct invocation, bypass watcher) loses the existing control point and risks missing side effects when the lifecycle flow grows.

---

### Q3: Completion Flag Writer
**Context**: FR-001 requires persisting a completion flag at `/var/lib/generacy/post-activation-complete` "only after post-activation succeeds." The post-activation script is a shell script in cluster-base that exits 0 on success. The orchestrator/control-plane is TypeScript in this repo. The writer determines which repo owns the flag and whether the flag can capture structured data (e.g., timestamp, script version).
**Question**: Which component should write the completion flag — the post-activation shell script (last line of successful execution) or the orchestrator/control-plane (after detecting post-activation completed)?
**Options**:
- A: Shell script writes it — add `touch /var/lib/generacy/post-activation-complete` at the end of `entrypoint-post-activation.sh` (cluster-base change, simplest, most reliable)
- B: Orchestrator writes it — orchestrator monitors the post-activation process/watcher for success, then writes the flag (generacy-only, but harder to detect success reliably)
- C: Both — shell script writes it, orchestrator reads it on next startup (split responsibility)

**Answer**: A** — shell script writes the flag.

Add `touch /var/lib/generacy/post-activation-complete` as the last command in `entrypoint-post-activation.sh` after all setup steps succeed. The script knows definitively when it succeeded (it reached the end). Single bit of state, single writer, no inter-process monitoring required. Option B (orchestrator writes after detecting completion) requires reliable cross-process exit-code monitoring and inter-container coordination; option C (both) is over-engineering for a single bit and creates two sources of truth.

Consistent with Q1: B — cluster-base owns the script and the flag it writes.

---

### Q4: Credential Refresh on Retry
**Context**: The first `bootstrap-complete` call unseals encrypted credentials from `credentials.dat` and writes them to `/var/lib/generacy/wizard-credentials.env` (mode 0600, on the data volume). On restart, this env file may still be present from the failed first attempt. However, if a user updated credentials via the cloud dashboard between the failure and restart, the env file would be stale.
**Question**: When retrying post-activation after restart, should credentials always be re-unsealed from the encrypted store (ensuring freshness), or can we rely on the persisted env file from the first attempt?
**Options**:
- A: Always re-unseal — call `writeWizardEnvFile()` before every retry to pick up any credential changes (safer, handles the "user fixed creds then restarted" scenario)
- B: Reuse if present — skip re-unsealing if `wizard-credentials.env` exists (faster, avoids crypto overhead, but stale if creds changed)

**Answer**: A** — always re-unseal.

The "user fixed credentials in the dashboard then restarted the cluster expecting it to pick up the new creds" scenario is real and exactly the case where retry needs to be correct. Re-unsealing is cheap (crypto on a small blob — microseconds); the cost of getting it wrong is the user's restart silently using stale creds with no signal as to why the retry still failed. Always re-unsealing also aligns with Q2: A — replaying the full lifecycle action includes credential re-unsealing as a natural side effect.

---

### Q5: Error Propagation Mechanism
**Context**: FR-007 requires surfacing structured errors to cluster status if post-activation fails on retry. The codebase has two existing patterns: (1) `POST /internal/status` pushes `ClusterStatus` (bootstrapping/ready/degraded/error) with a `statusReason` string, and (2) relay events on `cluster.bootstrap` channel emit structured payloads. The cloud dashboard currently reads cluster status to show readiness.
**Question**: How should a post-activation retry failure be surfaced — via cluster status transition (visible in dashboard health), relay event (visible in real-time event stream), or both?
**Options**:
- A: Status transition only — push `degraded` or `error` status with descriptive `statusReason` via existing `POST /internal/status` pattern
- B: Both status + relay event — push status transition AND emit a `cluster.bootstrap` relay event with failure details (matches existing bootstrap event patterns)

**Answer**: B** — both status transition + relay event.

Match the existing `cluster.bootstrap` event patterns so the dashboard's existing event-stream UI surfaces retry failures automatically, AND the status field gives a sticky persistent indicator on the cluster health card. The cost is one additional event emission; the visibility win covers both real-time observers (live dashboard during retry) and users who land on the dashboard after the failure window. Status-only (A) would leave the live event stream silent during a failure — a missed opportunity given the event infrastructure already exists.
