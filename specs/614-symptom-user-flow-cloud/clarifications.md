# Clarifications — #614 Stale credential surface after cluster re-add

## Batch 1 — 2026-05-14

### Q1: Fix B scope — FR-004 vs FR-005
**Context**: The spec lists two approaches for Fix B. FR-004 (activation checks credential health, not just key-file presence) is a health-check approach. FR-005 (CLI `--claim` signals force-reactivation) is described as a "simpler variant." These serve different scenarios: FR-004 catches unexpected stale state; FR-005 handles intentional re-adds. Implementing both adds complexity; one may suffice for the immediate bug.
**Question**: Should we implement both FR-004 and FR-005 for this issue, or is one sufficient? If one, which?
**Options**:
- A: FR-004 only — activation checks for `credentials.yaml` alongside key file (catches all stale-state cases)
- B: FR-005 only — CLI signals force-reactivation on `--claim` (explicit intent, simpler)
- C: Both — FR-004 as the runtime guard, FR-005 as the CLI-level belt-and-suspenders

**Answer**: *Pending*

### Q2: Fix B signal propagation mechanism
**Context**: FR-005 requires the CLI's `--claim` intent to reach the orchestrator running inside a Docker container. The CLI (`npx generacy launch`) runs on the host; the orchestrator runs in a container started by `docker compose up`. The scaffolder writes `.generacy/.env` which is bind-mounted into the container. The `generacy-data` named volume persists `/var/lib/generacy/` (including the stale `cluster-api-key` file) across `docker compose down` + re-up when the compose project name stays the same.
**Question**: How should the CLI propagate the "force re-activate" signal to the orchestrator container?
**Options**:
- A: CLI writes `FORCE_REACTIVATION=true` to `.generacy/.env`; orchestrator reads it on boot and deletes the stale key file
- B: CLI runs `docker volume rm <project>_generacy-data` before `docker compose up` (wipes all persisted cluster state)
- C: CLI writes a sentinel file to the volume via `docker run --rm -v ...` that the orchestrator checks

**Answer**: *Pending*

### Q3: Env file regeneration necessity (FR-001)
**Context**: `wizard-credentials.env` is sourced then **deleted** by `entrypoint-post-activation.sh` during initial bootstrap. After bootstrap, no process reads this file. The issue body confirms: "After startup, the orchestrator's process environment is frozen." The load-bearing change for credential refresh is `gh auth login --with-token` (FR-002), which updates `~/.config/gh/hosts.yml` — the file `gh` actually reads on every invocation. Regenerating the env file on every `PUT /credentials` would write to a file with no consumer.
**Question**: Is FR-001 (regenerate `wizard-credentials.env` on credential PUT) still required, or can we skip it and rely solely on FR-002 (`gh auth login --with-token`)?
**Options**:
- A: Keep FR-001 — defense-in-depth; the env file serves as an audit trail and future entrypoint restarts could re-source it
- B: Drop FR-001 — no consumer exists after bootstrap; implement FR-002 only to keep the change minimal
- C: Keep FR-001 but demote to P3 — implement after FR-002 if time permits

**Answer**: *Pending*
