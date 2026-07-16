# Feature Specification: ## Summary

No automated cluster provisioning path ever creates a smee

**Branch**: `952-summary-no-automated-cluster` | **Date**: 2026-07-16 | **Status**: Draft

## Summary

## Summary

No automated cluster provisioning path ever creates a smee.io channel, so every new cluster silently runs webhook-less and degrades to polling. The orchestrator should self-provision a channel on startup when none is configured, persist it, and let the existing `WebhookSetupService` wire up the GitHub webhook.

## Evidence

Observed on a fresh local cluster (`snappoll`, `ghcr.io/generacy-ai/cluster-base:preview`): the orchestrator was slow to react to labels added to issues, and its logs contained **zero** smee lines.

```
$ docker exec snappoll-orchestrator-1 sh -c 'env | grep -i smee'
SMEE_CHANNEL_URL=

$ docker logs snappoll-orchestrator-1 2>&1 | grep -ci smee
0
```

Contrast with the long-lived `tetrad-development` cluster, which works:

```
SMEE_CHANNEL_URL=https://smee.io/mNhnxyK56d9qkZo
{"msg":"Connected to smee.io channel","channelUrl":"https://smee.io/mNhnxyK56d9qkZo"}
```

That channel ID is the same one hardcoded in `specs/235-summary-when-smee-channel/run-test-t029.sh` (2026-02). It was created by hand once and every "working" cluster since has been coasting on it. This is why the gap went unnoticed until a genuinely fresh cluster was launched.

## Root cause

Channel-creation logic **exists**, but only in `cluster-base/.generacy/setup.sh` (and its `setup.ps1` twin):

```bash
# cluster-base/.generacy/setup.sh:165
SMEE_CHANNEL_URL=$(curl -s https://smee.io/new -o /dev/null -w '%{redirect_url}')
```

That script is interactive and human-run — its header says *"Run this script after cloning/forking"*, and it prompts via `read -r`. **Nothing invokes it automatically**: no entrypoint, no compose file, no CI. It is referenced only by its own usage text and `README.md`.

Every automated provisioning path bypasses it and hand-writes an empty value:

| Path | File | Result |
|---|---|---|
| Local CLI launch | `generacy` → `packages/generacy/src/cli/commands/cluster/scaffolder.ts:360` | `.env` with `SMEE_CHANNEL_URL=` |
| Cloud onboarding | `generacy-cloud` → `services/worker/src/lib/templates.ts` | `config.yaml`, no smee key |
| Cloud deploy | `generacy-cloud` → `services/api/src/services/cloud-deploy/compose-template.ts:255` | `.env` with `SMEE_CHANNEL_URL=` |

`snappoll` demonstrates the disconnect directly: it **has** `.generacy/setup.sh` shipped into it from the template, but its `config.yaml` header reads `TODO: finalize content per generacy#247` — generacy-cloud's onboarding template output, not setup.sh's. The script was delivered and never run.

## Downstream effect

An empty URL is falsy, so `config.smee.channelUrl` stays undefined and two things are skipped silently:

- `packages/orchestrator/src/server.ts:487` — `SmeeWebhookReceiver` is never constructed
- `packages/orchestrator/src/server.ts:824` — `webhookSetupService.ensureWebhooks()` never runs, so no GitHub webhook is created on the repo either

The cluster falls back to polling. With a 30s poll interval and `COMPLETED_CHECK_INTERVAL = 3` (`label-monitor-service.ts:83`), `completed:*` labels are only checked every third cycle — **up to 90s to notice a resume label**, versus near-instant with smee.

## Proposed behaviour

In `packages/orchestrator`, on startup, resolve the channel URL with this precedence:

1. `SMEE_CHANNEL_URL` / `ORCHESTRATOR_SMEE_CHANNEL_URL` env var (existing)
2. `orchestrator.smeeChannelUrl` in `.generacy/config.yaml` (existing, per #356)
3. **Persisted channel from a previous boot** (new)
4. **Provision a new channel** via `POST https://smee.io/new`, which returns a 302 whose `Location` header is the channel URL (new)

Then persist the result and proceed into the existing `SmeeWebhookReceiver` + `ensureWebhooks(url, repositories)` flow unchanged.

### Persistence

Write to `/var/lib/generacy/smee-channel`, mode `0600`, node-owned — alongside existing cluster-local state (`cluster-api-key`, `cluster.json`, `master.key`, `credentials.dat`). This volume is mounted rw and survives restarts. Follow the existing path-constant convention in `config/schema.ts:216-218` so it stays overridable.

**Persistence is mandatory, not an optimisation.** `ensureWebhooks` creates a GitHub webhook per channel URL, so provisioning a fresh channel on every restart would accumulate orphaned dead webhooks on the repo.

The cluster `.env` is **not** a viable persistence target: it lives on the host outside the container (e.g. `C:\Users\ChrisTrudel\Generacy\snappoll\.generacy\.env`) and is not mounted into the orchestrator — confirmed via `docker inspect` mounts.

### Requirements

- **Idempotent across restarts** — a restart must reuse the persisted channel, never mint a new one.
- **Non-fatal on failure** — if smee.io is unreachable (offline/air-gapped), log a warning and degrade to polling. Never block or crash startup.
- **Timeout the request** — do not hang startup waiting on smee.io.
- **Do not write the URL into `.generacy/config.yaml`.** That file is committed to the project repo. Smee channel URLs are unauthenticated capability URLs — anyone holding one can read the event stream and inject forged webhook payloads. Committing one to a public repo (e.g. `christrudelpw/snappoll`) leaks it. Cluster-local state only.

## Why the orchestrator, and not each provisioning path

A single implementation here covers **all** paths — local CLI, cloud onboarding, cloud deploy, and manual fork — instead of triplicating the same `curl` across `generacy` and `generacy-cloud`. That hand-duplication between the scaffolder and cloud-deploy has already been a recurring source of divergence bugs.

It also ships via npm on the `@channel` package pull, so **existing clusters pick it up on restart with no image rebuild**.

## Related

- #953 — Adaptive polling never engages for clusters that never had a webhook
- #954 — Orchestrator does not log that it is running webhook-less
- generacy-ai/cluster-base#81 — `setup.sh` writes `.env` to a path CLI-provisioned compose does not read

## Clarifications

Resolved 2026-07-16 — see `clarifications.md` for full context.

- **Provisioning HTTP timeout (Q1)**: connect+response timeout is **5 seconds** for `POST https://smee.io/new`. Runs once per cluster lifetime; a generous bound is nearly free. Note: the "10s existing convention" cited by option C does not exist in the orchestrator (only 500 ms localhost probes in `services/control-plane-probe.ts:4` and `services/code-server-probe.ts:4`).
- **Startup ordering (Q2)**: provisioning runs **fully async / fire-and-forget**, but is **gated on the same condition** that constructs `SmeeWebhookReceiver` at `server.ts:464` — `!isWorkerMode && config.labelMonitor && config.repositories.length > 0`. Never blocks `server.listen()`. Skipped in worker processes and on the pre-activation wizard boot (no repos, no credentials — first boot of a wizard cluster logs `Label monitor requested but no repositories configured — disabling.`). The persisted file makes the guaranteed post-activation restart pick this up seamlessly on boot 2. Provisioning lives on the same code path as the existing `server.ts:814–826` receiver-start / `ensureWebhooks` call.
- **Corrupt or invalid persisted content (Q3)**: **re-provision** on malformed content, overwrite the file, log warn. **Validation shape**: strictly `https://smee.io/<id>` — not merely non-empty. **Do NOT prune "foreign" smee webhooks** on the repo to compensate for orphan risk; a single repo may be legitimately monitored by multiple clusters, each with its own channel (spec `284-problem-when-multiple`). Accept the rare orphan.
- **Retry policy within a single boot (Q4)**: **2 attempts with a 1 s fixed delay**. Because Q2 is fully async, the retry budget never touches startup. One retry covers the most common failure mode (container DNS not yet warm in the first seconds of boot); a third attempt adds little because the guaranteed post-activation restart is the real recovery path.
- **Provisioning succeeds but persistence write fails (Q5)**: **do not use the channel**. Log at warn, drop the in-memory URL, skip `SmeeWebhookReceiver` and `ensureWebhooks`, continue webhook-less. Option B (use receiver, skip `ensureWebhooks`) is dropped as incoherent: a channel just minted by us has no GitHub webhook pointing at it yet, so a connected receiver can never deliver an event — it would just produce a misleading `Connected to smee.io channel` log line. If `/var/lib/generacy` is unwritable, `master.key`, `credentials.dat`, and `cluster-api-key` are already broken; the smee channel is not the top concern.


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit — clarifications integrated 2026-07-16 (see `clarifications.md`)*
