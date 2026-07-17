# Feature Specification: ## Summary

#978 shipped a working smee-mode doorbell, but it is **not wired end-to-end** in the real deployment topology, so `/cockpit:auto` still falls back to polling and — worse — the doorbell **exits** and strands the run on the 5-minute heartbeat

**Branch**: `980-summary-978-shipped-working` | **Date**: 2026-07-17 | **Status**: Draft

## Summary

## Summary

#978 shipped a working smee-mode doorbell, but it is **not wired end-to-end** in the real deployment topology, so `/cockpit:auto` still falls back to polling and — worse — the doorbell **exits** and strands the run on the 5-minute heartbeat. Two engine-side gaps: (1) the smee channel URL is never delivered to the environment where the doorbell actually runs (the operator session), and (2) the doorbell `exit(2)`s on a transient startup failure instead of retrying, which the passive skill (#431) never recovers from.

This is a post-merge follow-up to **#978** (verified by direct investigation of a running `snappoll` preview cluster).

## Evidence (running snappoll cluster, `cluster-base:preview`, 2026-07-17)

**The engine doorbell works when it can find the channel.** Running the shipped command inside the orchestrator container (where `/var/lib/generacy/smee-channel` exists):
```
$ generacy cockpit doorbell christrudelpw/snappoll#1
armed
cockpit doorbell: source=smee reason=startup-smee-selected      # ← smee mode engages, process stays alive
```

**But the channel URL is only on a cluster-internal volume.** `channel-discovery.js` reads `COCKPIT_DOORBELL_SMEE_URL` (env) then `/var/lib/generacy/smee-channel` (default path):
- The file exists at `/var/lib/generacy/smee-channel` (mode `0600`, on the `*_generacy-data` volume — mounted into orchestrator + workers).
- It is **NOT** in the shared `*_workspace` volume's `.generacy/` — which is where the auto ledger *is* written (`/workspaces/<repo>/.generacy/cockpit/auto-runs/…`), proving the operator session shares that surface.
- The operator `/cockpit:auto` session runs in a **separate devcontainer/tunnel** that does not mount the cluster's `generacy-data` volume. So discovery returns `null` → **poll-fallback**.
- The agency skill (#431) `auto.md` sets no `COCKPIT_DOORBELL_SMEE_URL` and still spawns a bare `generacy cockpit doorbell <epic-ref>` (still described as "attaches to the shared event-bus poll loop").

**Poll-fallback then exits, and the passive skill never recovers.** On a poll-fallback `acquireEpicBus` failure (a `gh` error — e.g. the operator PAT being rate-limited, which has happened repeatedly), `doorbell.js` runs the all-sources-failed branch → `exit(2)`. Per #431 (Q3=A) the skill stays passive with no re-spawn, so the run degrades to the 300s `ScheduleWakeup` heartbeat for its remainder. The ledger confirms heartbeat-only operation:
```
christrudelpw/snappoll#1 · phase-complete · phase-queue-gate · queued P2 (2 issues)
christrudelpw/snappoll#1 · heartbeat · schedule-wakeup · fired · drain complete (2 events)   # ← P2 surfaced on the heartbeat, not a doorbell wake
```
(A secondary dependency: smee mode itself calls `resolveEpic` for the ref-set filter, so it also needs a healthy `gh`; a `gh` failure makes `SmeeDoorbellSource.start()` fail → poll → exit.)

## Net effect

Real-time notification still doesn't work on smee-live clusters, and a single transient `gh` blip at doorbell startup silently downgrades the entire run to ~5-minute latency. #978's engine work is correct in isolation; it just isn't connected to where the doorbell process lives, and isn't resilient enough to survive startup turbulence.

## Proposed fix

**FR-A (P1) — deliver the channel URL to the operator session via the shared workspace.**
At channel-provision time (`SmeeChannelResolver` / orchestrator boot), also write the resolved channel URL to a **workspace-relative** path — e.g. `/workspaces/<repo>/.generacy/cockpit/smee-channel` — the same already-shared `*_workspace` volume the auto ledger uses. Point the doorbell's default `channelFilePath` at that shared location (keep the `COCKPIT_DOORBELL_SMEE_URL` env override and the `/var/lib/generacy/smee-channel` path as fallbacks). No new volume mounts required; works across the operator↔cluster boundary because the workspace is already shared.
- Alternative considered: discover the channel from the repo's registered webhook (`gh api repos/<owner>/<repo>/hooks` → the `smee.io` `config.url`). Rejected as primary because it needs `Webhooks: read` on the operator token, which the operator PAT lacks (404 observed).

**FR-B (P1) — make the doorbell resilient to transient startup failures.**
When poll-fallback `acquireEpicBus` (or smee `resolveEpic`) throws a transient `gh`/rate-limit error, **retry with backoff** (the `rateLimitScheduler` is already wired into the doorbell's `GhCliWrapper`) instead of `exit(2)`. #431 deliberately put transport resilience "behind the doorbell surface, not in the skill" (Q3=A) — this makes the doorbell surface actually live up to that contract, rather than dying on the first hiccup and relying on the heartbeat.

## Success criteria

- [ ] On a smee-live cluster, `/cockpit:auto`'s doorbell selects `source=smee` from the operator session (channel URL discoverable via the shared path) and delivers wakes in ≤ ~3s.
- [ ] A transient `gh`/rate-limit error at doorbell startup results in a retry, not process exit; the run does not silently fall to heartbeat-only.
- [ ] No regression on clusters without a smee channel (poll-fallback still works).

## Related

- **#978** — the smee doorbell this wires up (engine implementation; merged but inert in the real topology). My "no agency change needed" note on #978 was the integration miss this issue corrects.
- **#970** — parent (poll-cost reductions + original poll doorbell).
- **#972** — webhook registration (fixed; smee now delivers to the orchestrator). This issue is about delivering the *channel URL* to the doorbell, a distinct gap.
- **agency#431** — the skill that spawns the doorbell and stays passive on its death (Q3=A). No skill change required if FR-A uses the shared-path discovery; the passive-recovery contract is satisfied by FR-B making the doorbell resilient.

## Workaround (interim)

Export `COCKPIT_DOORBELL_SMEE_URL=<current smee channel URL>` in the operator session before running `/cockpit:auto` — the spawned doorbell inherits it and selects smee mode. Stopgap only (breaks on channel re-provision), which is why FR-A auto-discovery is the real fix.


## User Stories

### US1: Operator gets real-time doorbell wakes from a smee-live cluster

**As an** operator running `/cockpit:auto` from my own devcontainer/tunnel session,
**I want** the spawned `generacy cockpit doorbell` to discover the cluster's smee channel URL from the shared workspace,
**So that** doorbell wakes arrive in ~3s (smee mode) instead of waiting for the 30s poll fallback or the passive skill's 300s heartbeat.

**Acceptance Criteria**:
- [ ] From an operator session that does **not** mount the cluster's `generacy-data` volume, `generacy cockpit doorbell <epic-ref>` selects `source=smee` and stays running.
- [ ] The smee channel URL is discoverable at a **single cluster-scoped path on the shared workspace volume** (`/workspaces/.generacy/cockpit/smee-channel` — sibling of the per-repo dirs). The reader walks up from `cwd` to the nearest `.generacy/cockpit/smee-channel` and falls back to the absolute path.
- [ ] Existing `COCKPIT_DOORBELL_SMEE_URL` env override and `/var/lib/generacy/smee-channel` cluster-internal path continue to work as fallback lookups.

### US2: Doorbell survives a transient `gh` blip at startup

**As an** operator whose PAT is occasionally rate-limited by GitHub,
**I want** the doorbell to retry with backoff when startup `gh` calls fail transiently, and self-heal if the transient outlasts the initial window,
**So that** a single hiccup does not silently downgrade the entire auto run to heartbeat-only latency (~5 min), and the run recovers automatically when the transient clears.

**Acceptance Criteria**:
- [ ] A **transient** `gh` error (429 / network-level ECONNRESET/ETIMEDOUT/ENOTFOUND/ECONNREFUSED/socket hang up / 5xx 500/502/503/504) during `acquireEpicBus` (poll-fallback path) or `resolveEpic` (smee ref-filter path) triggers backoff-retry, not `exit(2)`.
- [ ] Retry policy: bounded initial window (~2 min, exponential backoff via the already-wired `rateLimitScheduler`); on exhaustion, transition to a periodic late-startup retry (~every 5 min) while the process **stays alive**. Never `exit(2)` from a transient failure.
- [ ] **Permanent** errors (401 "Bad credentials", 403 SSO/scope, 404 epic-not-found, malformed `gh` output) are surfaced immediately on stderr with a distinct diagnostic and exit code `3` (distinguishable from today's silent `exit(2)`).
- [ ] After transient failures resolve within the late-startup retry window, the doorbell reaches its normal steady state (smee-selected on smee-live clusters, poll on others).
- [ ] The passive skill (#431) does not need to re-spawn the doorbell after a transient blip — the doorbell surface owns transport resilience.

### US3: No regression on clusters without smee

**As an** operator on a cluster with no reachable smee channel,
**I want** the doorbell to fall back to the existing poll-loop behavior,
**So that** `/cockpit:auto` still functions with today's poll-driven notification cadence.

**Acceptance Criteria**:
- [ ] When neither the env var, the shared workspace path, nor the cluster-internal path yields a channel URL, the doorbell selects `source=poll` and runs the existing event-bus poll loop.
- [ ] #970's poll-cost reductions are preserved on the fallback path.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | At smee channel provision time (`SmeeChannelResolver` / orchestrator boot), write the resolved channel URL to a **single cluster-scoped path on the shared workspace volume**: `/workspaces/.generacy/cockpit/smee-channel` (sibling of the per-repo dirs), in addition to `/var/lib/generacy/smee-channel`. | P1 | One write per re-provision (not N). Verify the volume root is writable by the orchestrator uid. See Q1=C. |
| FR-002 | Extend `channel-discovery.js`'s lookup order to include the workspace-relative path: `COCKPIT_DOORBELL_SMEE_URL` env → nearest `.generacy/cockpit/smee-channel` (walk up from `cwd`) → `/workspaces/.generacy/cockpit/smee-channel` absolute default → `/var/lib/generacy/smee-channel` cluster-internal fallback. | P1 | Preserves existing overrides and cluster-internal fallback. |
| FR-003 | On a **transient** `gh` error during `SmeeDoorbellSource.start()`'s `resolveEpic` call, retry with backoff via the already-wired `rateLimitScheduler` for a bounded ~2 min initial window; on exhaustion, transition to a periodic late-startup retry (~every 5 min) while keeping the process alive. Never `exit(2)` on transient failures. | P1 | Symmetric with #978 Q3=D demotion-with-retry. See Q2=D. |
| FR-004 | On a **transient** `gh` error during poll-fallback `acquireEpicBus`, apply the same bounded-initial + periodic-late-startup retry policy as FR-003. Never take the all-sources-failed → `exit(2)` branch on a transient failure. | P1 | Aligns doorbell surface with #431 Q3=A "resilience behind the doorbell, not in the skill". |
| FR-005 | Classify errors: **retriable** = HTTP 429, network-level (ECONNRESET/ETIMEDOUT/ENOTFOUND/ECONNREFUSED/socket hang up), 5xx (500/502/503/504). **Permanent** = 401 "Bad credentials", 403 SSO/scope, 404 not-found, malformed `gh` output. Permanent errors surface a distinct diagnostic on stderr and exit with code `3` (not today's silent `exit(2)`). | P1 | See Q3=B. Prevents masking real misconfiguration behind an eternally-retrying silent doorbell. |
| FR-006 | Preserve poll-fallback behavior when neither smee nor env override yields a channel URL; do not remove the poll loop. | P1 | smee.io is best-effort; poll stays as safety net (matches #978 design). |
| FR-007 | Preserve `#970` poll-cost reductions on the fallback path — no regression to poll cadence or API-call count. | P1 | |
| FR-008 | Workspace-relative channel file is written with mode `0644`, bare-URL content (no metadata). | P1 | `0644` because writer/reader may run under different uids across the container/tunnel boundary. Bare URL keeps the reader symmetric with the cluster-internal fallback. See Q5=B. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | End-to-end doorbell wake latency on a smee-live cluster, from operator session | ≤ ~3s p95 (smee mode) | Time from `waiting-for:*` label applied to doorbell stdout line, measured on `snappoll` preview cluster from the operator devcontainer |
| SC-002 | Doorbell process survival across a transient startup failure | 0 unexpected `exit(2)` under a simulated single `gh` rate-limit (429) response | Inject a 429 for the first `gh` call at doorbell startup; assert the process reaches steady state instead of exiting |
| SC-003 | Doorbell process survival across an extended transient outage | Process stays alive for ≥ 10 min while `gh` returns 429/5xx/network errors; recovers to normal steady state within one late-startup retry cycle (~5 min) once transient clears | Inject sustained 429 for 6 min, then clear; assert doorbell reaches steady state within 11 min end-to-end |
| SC-004 | Permanent errors are diagnosable, not silent | Under 401/403/404/malformed `gh` output, doorbell exits with code `3` and a distinct stderr diagnostic within the first ~2 min | Inject each permanent-error class; assert exit code `3` and matching stderr line |
| SC-005 | No poll-cost regression on smee-less clusters | Poll cadence and API-call count unchanged vs. #970 baseline | Compare `runOnePoll` invocation count over a fixed window on a smee-less cluster before/after |
| SC-006 | Auto ledger no longer shows heartbeat-only phase surfacing on smee-live clusters | Zero `heartbeat · schedule-wakeup · fired · drain complete` lines for phase-transition wakes | Grep the auto-runs ledger over a full multi-phase run on the `snappoll` cluster |

## Assumptions

- The `*_workspace` volume is mounted into both the orchestrator container (for the writer) and the operator devcontainer/tunnel (for the reader). Evidenced by the shared auto ledger under `/workspaces/<repo>/.generacy/cockpit/auto-runs/`.
- The workspace-volume **root** (`/workspaces/.generacy/`) is writable by the orchestrator uid — same volume the orchestrator already writes ledgers into under `/workspaces/<repo>/.generacy/`. This must be verified at implementation time; if the root is not writable, fall back to writing under each per-repo `.generacy/cockpit/` (option A) as a mitigation, though this is not the chosen design.
- The doorbell's `GhCliWrapper` already has `rateLimitScheduler` wired, so FR-003/FR-004 are a matter of *using* it at the two startup call sites plus adding the late-startup periodic retry, not adding new infrastructure.
- `SmeeChannelResolver` and orchestrator-boot are the correct write points; the writer overwrites the file at every boot, so a stale wrong-cluster file at the shared path cannot outlast a cluster restart.
- The smee channel URL is persisted and stable across restarts (verified `source=persisted` in orchestrator logs), so a **mid-run** channel URL change is rare and normally restart-coupled. See Out of Scope: mid-run re-read.
- No agency skill (#431) change is required. The passive-recovery contract is satisfied by FR-B making the doorbell resilient; discovery works because the shared workspace path is reachable from the operator session.

## Out of Scope

- **Mid-run channel re-provision without operator restart.** The doorbell reads the channel file once at startup; if the orchestrator provisions a new smee URL mid-run, the running doorbell continues attached to the old (dead) URL until the operator restarts `/cockpit:auto`. Rare in practice (channel is persisted/stable) and benign (heartbeat still advances the run). If this becomes painful later, add a cheap ~5-min periodic file re-read — explicitly **not** `fs.watch` (semantics are unreliable across Docker / bind-mount volumes). See Q4=A.
- **Webhook-based channel discovery** (`gh api repos/<owner>/<repo>/hooks` → `smee.io` `config.url`). Rejected as primary because the operator PAT typically lacks `Webhooks: read` (404 observed).
- **Skill-side changes** to `agency#431` `auto.md` — no re-spawn logic, no capability-probe changes, no environment injection from the skill.
- **Lossless smee delivery.** smee.io is a best-effort free relay; gaps remain covered by the auto skill's `ScheduleWakeup` heartbeat. This spec does not add gap-detection or replay.
- **Removing the poll fallback.** The 30s poll loop stays as the safety net; this spec only reorders discovery so smee wins when reachable.
- **Cluster identity / bot-vs-human distinction** (that's #976's surface). This spec is purely about channel URL delivery + transport resilience.
- **JSON channel-file content with metadata** (`{url, writtenAt, clusterId}`). Rejected for this fix (Q5=B — bare URL is symmetric with the cluster-internal fallback and the writer overwrites at every boot). Reconsider if wrong-cluster detection becomes a real problem.

## Related

- **#978** — the engine implementation of smee-mode doorbell (merged, works when the channel URL is reachable). This spec wires it end-to-end.
- **#970** — parent (poll-cost reductions + original poll-loop doorbell). The fallback path preserved by FR-006/FR-007.
- **#972** — webhook registration (fixed; smee now delivers to the orchestrator). This spec is about delivering the *channel URL* to the doorbell process.
- **agency#431** — the skill that spawns the doorbell and stays passive on its death (Q3=A). No skill-side change required.

## Workaround (interim)

Export `COCKPIT_DOORBELL_SMEE_URL=<current smee channel URL>` in the operator session before `/cockpit:auto`. Stopgap only — breaks on channel re-provision, which is why FR-001/FR-002 auto-discovery is the real fix.

---

*Generated by speckit*
