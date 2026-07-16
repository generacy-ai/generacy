# Feature Specification: Orchestrator auto-provisions a smee.io channel when none is configured

**Branch**: `952-summary-no-automated-cluster` | **Date**: 2026-07-16 | **Status**: Draft
**Issue**: [#952](https://github.com/generacy-ai/generacy/issues/952)

## Summary

No automated cluster provisioning path (local CLI launch, cloud onboarding, cloud deploy) ever creates a smee.io channel, so every freshly-provisioned cluster silently runs webhook-less and degrades to polling — up to a 90s delay to notice `completed:*` resume labels. The one script that does mint a channel (`cluster-base/.generacy/setup.sh`) is interactive and never invoked by any automated path; the fact that this went unnoticed is only because "working" clusters have been coasting on a single hand-created channel URL from 2026-02.

The orchestrator (`packages/orchestrator`) should self-provision a smee.io channel on startup when none is configured through env or config, persist it under cluster-local state, and let the existing `SmeeWebhookReceiver` + `WebhookSetupService` flow wire it up. Because a fresh channel would cause `ensureWebhooks` to accumulate orphaned GitHub webhooks on every restart, persistence is a hard requirement, not an optimisation.

Shipping this in the orchestrator (rather than in each of the three provisioning paths) covers all current and future paths from a single implementation, and ships to existing clusters on the next npm pull without an image rebuild.

## Evidence

Observed on a fresh local cluster (`snappoll`, `ghcr.io/generacy-ai/cluster-base:preview`): the orchestrator was slow to react to labels added to issues, and its logs contained **zero** smee lines.

```
$ docker exec snappoll-orchestrator-1 sh -c 'env | grep -i smee'
SMEE_CHANNEL_URL=

$ docker logs snappoll-orchestrator-1 2>&1 | grep -ci smee
0
```

Contrast with the long-lived `tetrad-development` cluster:

```
SMEE_CHANNEL_URL=https://smee.io/mNhnxyK56d9qkZo
{"msg":"Connected to smee.io channel","channelUrl":"https://smee.io/mNhnxyK56d9qkZo"}
```

That channel ID is the same one hardcoded in `specs/235-summary-when-smee-channel/run-test-t029.sh` (2026-02). It was created by hand once and every "working" cluster since has been coasting on it.

## Root cause

Channel-creation logic exists only in `cluster-base/.generacy/setup.sh` (and `setup.ps1`):

```bash
# cluster-base/.generacy/setup.sh:165
SMEE_CHANNEL_URL=$(curl -s https://smee.io/new -o /dev/null -w '%{redirect_url}')
```

That script is interactive (prompts via `read -r`) and human-run. Nothing invokes it automatically. All automated provisioning paths bypass it and hand-write an empty `SMEE_CHANNEL_URL=`:

| Path | File | Result |
|---|---|---|
| Local CLI launch | `packages/generacy/src/cli/commands/cluster/scaffolder.ts:360` | `.env` with `SMEE_CHANNEL_URL=` |
| Cloud onboarding | `generacy-cloud` → `services/worker/src/lib/templates.ts` | `config.yaml`, no smee key |
| Cloud deploy | `generacy-cloud` → `services/api/src/services/cloud-deploy/compose-template.ts:255` | `.env` with `SMEE_CHANNEL_URL=` |

## Downstream effect

An empty URL is falsy, so `config.smee.channelUrl` stays undefined and two things are skipped silently:

- `packages/orchestrator/src/server.ts:487` — `SmeeWebhookReceiver` is never constructed
- `packages/orchestrator/src/server.ts:824` — `webhookSetupService.ensureWebhooks()` never runs, so no GitHub webhook is created on the repo either

The cluster falls back to polling. With a 30s poll interval and `COMPLETED_CHECK_INTERVAL = 3` (`label-monitor-service.ts:83`), `completed:*` labels are only checked every third cycle — **up to 90s to notice a resume label**, versus near-instant with smee.

## User Stories

### US1: Fresh cluster auto-provisions a smee channel on first boot

**As a** developer bringing up a new Generacy cluster via any automated path (local CLI `generacy launch`, cloud onboarding, cloud deploy),
**I want** the orchestrator to mint a smee.io channel automatically on first startup when none is configured,
**So that** webhook-driven label events reach the orchestrator near-instantly instead of via 30–90s polling, without me having to run an interactive setup script.

**Acceptance Criteria**:
- [ ] Booting the orchestrator against an env/config with no `SMEE_CHANNEL_URL` and no persisted channel results in a `POST https://smee.io/new` request whose 302 `Location` is captured, persisted, and used to construct `SmeeWebhookReceiver`.
- [ ] The orchestrator log contains a "Connected to smee.io channel" line with the newly-minted URL within the normal startup window.
- [ ] `webhookSetupService.ensureWebhooks(url, repositories)` runs with the new channel URL and creates the GitHub webhook on the configured repositories.

### US2: Restart reuses the persisted channel

**As a** cluster operator restarting the orchestrator (routine, upgrade, or crash),
**I want** the orchestrator to reuse the previously-provisioned smee channel,
**So that** the GitHub repo does not accumulate orphaned webhooks (one per restart), and existing webhooks continue to deliver events.

**Acceptance Criteria**:
- [ ] Second and subsequent boots read `/var/lib/generacy/smee-channel` and use its contents, making zero `POST https://smee.io/new` requests.
- [ ] Restarting the orchestrator N times produces exactly one webhook on the GitHub repo (not N).

### US3: Air-gapped / smee.io-unreachable boot degrades gracefully

**As a** cluster operator running in an offline or restricted network,
**I want** the orchestrator to start successfully even when smee.io is unreachable,
**So that** cluster boot is never blocked or crashed by an external dependency, and the cluster falls back to polling.

**Acceptance Criteria**:
- [ ] With smee.io unreachable (network unreachable, DNS failure, HTTP timeout), the orchestrator logs a warning identifying the failure and continues startup.
- [ ] The orchestrator does not construct `SmeeWebhookReceiver`, does not call `ensureWebhooks`, does not persist a partial file, and completes startup in the same wall-clock budget as a normally-provisioned boot (bounded by the request timeout).
- [ ] A subsequent restart, once smee.io is reachable, provisions and persists a channel normally.

### US4: Explicit configuration still wins

**As a** cluster operator who has intentionally configured a specific smee channel (via `SMEE_CHANNEL_URL` env or `orchestrator.smeeChannelUrl` in `.generacy/config.yaml`),
**I want** my configured value to take precedence over any persisted or auto-provisioned channel,
**So that** provisioning stays predictable and I can point a cluster at a specific channel deliberately (e.g. for debugging, sharing between clusters, or pinning to a known URL).

**Acceptance Criteria**:
- [ ] With `SMEE_CHANNEL_URL` set to a non-empty value, the orchestrator uses that value and does not read from `/var/lib/generacy/smee-channel` or call `POST https://smee.io/new`.
- [ ] With `orchestrator.smeeChannelUrl` set in `.generacy/config.yaml` (and no env override), the orchestrator uses the config value and does not read from or write to the persistence file.
- [ ] The persistence file, if it exists from a prior provisioning boot, is not modified when an explicit config takes precedence.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Orchestrator startup resolves smee channel URL by precedence: (1) `SMEE_CHANNEL_URL` / `ORCHESTRATOR_SMEE_CHANNEL_URL` env, (2) `orchestrator.smeeChannelUrl` from `.generacy/config.yaml`, (3) persisted channel file, (4) newly-provisioned channel via `POST https://smee.io/new`. | P1 | Existing tiers (1–2) unchanged. New tiers (3–4). |
| FR-002 | Provisioning issues `POST https://smee.io/new` and captures the 302 `Location` response header as the channel URL. | P1 | No request body needed. |
| FR-003 | The provisioning HTTP request has a bounded timeout so startup cannot hang on smee.io unavailability. | P1 | Concrete timeout value: see clarification round. |
| FR-004 | Successful provisioning persists the channel URL to `/var/lib/generacy/smee-channel`, mode `0600`, node-owned, via atomic write (temp + rename). | P1 | Same pattern as `cluster-api-key`, `master.key`. |
| FR-005 | On restart, if the persisted file exists and contains a non-empty URL, it is used as the channel URL and no `POST https://smee.io/new` is issued. | P1 | Idempotency. |
| FR-006 | Provisioning failure (network error, non-302 response, missing `Location` header, timeout) is logged at warn level with a descriptive reason, and startup continues without constructing `SmeeWebhookReceiver` or calling `ensureWebhooks`. | P1 | Non-fatal. |
| FR-007 | The persistence file path is exposed via the existing path-constant convention in `packages/orchestrator/src/config/schema.ts` (near lines 216–218), overridable via env var for testing. | P1 | Matches sibling constants. |
| FR-008 | Provisioning does NOT write the channel URL into `.generacy/config.yaml` under any circumstance. | P1 | Security: config.yaml is committed; smee URLs are unauthenticated capability URLs. |
| FR-009 | When an explicit env/config value is present, the persistence file is not read from and not written to. | P2 | Explicit configuration is authoritative. |
| FR-010 | The channel URL used (whether from env, config, persistence, or freshly provisioned) is logged once at startup so operators can identify which tier resolved it. | P2 | Diagnostic — matches "Connected to smee.io channel" pattern. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Fresh cluster boot with no smee configuration reaches "Connected to smee.io channel" | Yes, on first boot | Bring up a fresh cluster with `generacy launch` (empty `SMEE_CHANNEL_URL=`), inspect orchestrator logs. |
| SC-002 | Restart of a cluster that auto-provisioned reuses the same channel URL | Same URL as prior boot; zero `POST /new` requests | Restart the cluster from SC-001, compare log-reported channel URL and count new webhooks on the GitHub repo. |
| SC-003 | Restart does not accumulate orphaned GitHub webhooks | 1 webhook after N restarts | `gh api /repos/{owner}/{repo}/hooks` after 3 restarts. |
| SC-004 | Boot with smee.io unreachable completes within startup budget | Startup completes; warn line logged; no crash | Simulate unreachability (block egress or point env var at unreachable host), boot orchestrator, confirm exit code and log line. |
| SC-005 | Explicit `SMEE_CHANNEL_URL` env takes precedence over persisted file | Configured URL wins; persistence file unchanged | Boot with persisted file present AND env var set to a different URL; compare which URL the log reports and inspect file mtime. |
| SC-006 | Existing clusters pick up the fix on `@channel` npm pull + restart | Auto-provisions on next boot after update | Update a cluster running an older orchestrator to the fixed version, restart, observe auto-provisioning. |

## Assumptions

- `smee.io` continues to expose `POST https://smee.io/new` returning a 302 whose `Location` header is a new channel URL. (This is the same endpoint the current `setup.sh` uses and has been stable for the life of the project.)
- The `/var/lib/generacy/` volume is mounted read-write and persists across container restarts in all deployment shapes (local CLI, cloud deploy). This holds today for sibling files (`cluster-api-key`, `master.key`, `credentials.dat`) and any deviation is a pre-existing infrastructure bug, not something this feature must handle.
- `SmeeWebhookReceiver` and `WebhookSetupService.ensureWebhooks(url, repositories)` are unchanged and continue to work when handed a freshly-provisioned URL.
- A repo that ends up with a stale webhook from a pre-fix cluster whose channel URL is now unreachable is out of scope — this feature prevents new orphans but does not garbage-collect existing ones.

## Out of Scope

- Cleaning up orphaned GitHub webhooks left by prior clusters or by pre-fix restart loops.
- Changes to `generacy-cloud`'s onboarding or cloud-deploy templates. This feature intentionally centralises provisioning in the orchestrator so cloud paths do not need to change.
- Deleting or modifying `cluster-base/.generacy/setup.sh` / `setup.ps1`. The interactive scripts can remain for manual-fork users; whether to remove them is a follow-up.
- Rotation of smee channel URLs after provisioning (e.g. periodic re-mint, admin-triggered rotation). Persistence is intentionally write-once.
- Multi-tenant provisioning where a single orchestrator manages multiple smee channels.
- Adaptive polling behaviour when webhook-less (tracked in #953).
- Logging that the orchestrator is running webhook-less (tracked in #954).
- Fixing `cluster-base/.generacy/setup.sh`'s `.env`-write path mismatch with CLI-provisioned compose (tracked in cluster-base#81).

## Related

- #953 — Adaptive polling never engages for clusters that never had a webhook
- #954 — Orchestrator does not log that it is running webhook-less
- generacy-ai/cluster-base#81 — `setup.sh` writes `.env` to a path CLI-provisioned compose does not read
- #356 — Prior work adding `orchestrator.smeeChannelUrl` to `.generacy/config.yaml` (precedence tier 2 above)
- #235 — Original smee integration (source of the 2026-02 hardcoded channel URL still coasting through the fleet)

---

*Generated by speckit*
