# Implementation Plan: Snappoll Preview — Fail Loud on Webhook-Registration 403

**Feature**: Register the GitHub repo webhook against the provisioned smee channel on every orchestrator start; on a 403 (`admin:repo_hook` missing), fail loud (structured warn + `cluster.bootstrap` relay event + cluster status → `degraded`) instead of silently falling back to polling and exhausting the installation-token budget.
**Branch**: `972-summary-snappoll-preview`
**Status**: Complete

## Summary

The snappoll preview cluster reproduces a systemic failure mode: the orchestrator provisions and connects a smee channel, but `WebhookSetupService.ensureWebhooks()` gets HTTP 403 (`Resource not accessible by integration`) because the Generacy GitHub App is missing the repository `admin:repo_hook` (Webhooks: write) scope. The 403 is swallowed as a `warn` log line, no relay event fires, and the cluster stays `ready` while its monitors poll GitHub every 30 s and exhaust the installation-token rate limit.

This plan implements the P1 fix agreed in the spec + clarifications: keep the per-start `ensureWebhooks()` call site untouched, tighten webhook registration to use the four events the spec locks (`issues`, `pull_request`, `check_run`, `check_suite`), tighten the "existing-hook" branch to only update hooks whose `config.url` exactly matches a previously-persisted Generacy channel URL, and — on any 403 from list-or-create-or-update — emit the mandated triple: structured warn log, `cluster.bootstrap` relay event `{ status: 'failed', reason: 'webhook-registration-forbidden', ... }`, and cluster status transition to `degraded` via the existing `StatusReporter → POST /internal/status` path. Polling stays as the safety-net fallback per the spec's Out of Scope.

P2 (extending `SmeeWebhookReceiver` to `pull_request` / `check_run` / `check_suite` and wiring the pr-feedback + merge-conflict monitors off polling) is deferred to a follow-on and is not implemented here.

## Diagnosis

**FR-007 finding: the `admin:repo_hook` gap is systemic to every Generacy GitHub App installation, not snappoll-specific.**

**Method (per clarifications Q5 → A):** the GitHub App permission manifest is the single source of truth. GitHub returns `Resource not accessible by integration (HTTP 403)` when an App attempts an API call that its declared installation permissions do not cover — this is enforced at the App level, not the installation level. If a scope is present in the manifest, GitHub prompts the operator to re-consent on install and any pre-existing installation can be updated in-place with no per-install code change. If the scope is not present in the manifest, every installation is affected identically, and no per-install remediation is possible.

**Evidence recorded in spec.md ("Evidence — snappoll cluster")** shows:
- `gh: Resource not accessible by integration (HTTP 403)` on `GET /repos/christrudelpw/snappoll/hooks` and (implied) on `POST` to the same endpoint.
- Installation ID `113597939`.
- The orchestrator's own diagnostic log line: `"Insufficient permissions to manage webhooks (admin:repo_hook required)"` (see `packages/orchestrator/src/services/webhook-setup-service.ts:384`) — the code path that would have already logged a scope-specific error if the App had the scope but the operator had somehow de-scoped it, which is not possible for repository webhook permissions.

**Consequence:** the fix requires updating the Generacy GitHub App manifest (a manual GitHub App settings change in `github.com/settings/apps/<generacy-app>` → Permissions → Repository → Webhooks: Read & write). Once that ships, every existing installation gets the scope automatically (App-level permissions propagate; the operator sees a "New permissions requested" banner but does not need to re-install). Every cluster then heals on next orchestrator restart via the existing `ensureWebhooks()` call site — no per-cluster state migration (FR-008 / Q4 → A).

**Scratch-repo end-to-end validation (also required by FR-007, SC-003):** install a scratch App with `admin:repo_hook` granted on a throwaway repo, boot a cluster pointed at it, and verify (a) `ensureWebhooks()` reports `created`, (b) the resulting hook's `config.url` equals the provisioned smee channel, (c) the initial `ping` event is delivered through smee to the orchestrator's `SmeeWebhookReceiver`. Steps in `quickstart.md`.

**Out of scope for this diagnosis:** whether the App manifest change itself lands in this repo, or in the Generacy Cloud/App settings repo. This plan documents the finding; the manifest edit is an operator action.

## Technical Context

**Language / runtime:** TypeScript, Node.js ≥ 22, ESM.
**Framework:** Fastify (orchestrator HTTP server), Pino (logging), Zod (payload validation).
**Package boundary:** all changes land in `packages/orchestrator/`. No changes to `packages/control-plane/`, `packages/cluster-relay/`, `packages/workflow-engine/`, or `packages/generacy/` (CLI).
**Relay wire path:** in-process — `WebhookSetupService` runs inside the orchestrator, so it emits `cluster.bootstrap` events by invoking a `sendRelayEvent(channel, payload)` callback wired to `ClusterRelayClient.send({ type: 'event', event, data, timestamp })`, exactly the pattern already used by `PostActivationRetryService` and `BootResumeService` (see `packages/orchestrator/src/server.ts:723-727, 738-742, 1135-1138, 1149-1152`). The `/internal/relay-events` HTTP IPC endpoint (`packages/orchestrator/src/routes/internal-relay-events.ts`) is for cross-process emitters (control-plane); the orchestrator's in-process emitters bypass it. FR-006 is satisfied by the same wire-format `EventMessage` reaching the cloud UI — the transport hop (HTTP → relay-client.send vs. direct relay-client.send) is not observable at the cloud.
**Cluster status transition path:** `StatusReporter.pushStatus('degraded', 'webhook-registration-forbidden')` → `POST /internal/status` on the control-plane control socket (`packages/orchestrator/src/services/status-reporter.ts`). Existing pattern; no new code, only a new call site.
**Persisted channel URL source of truth for FR-004:** the smee channel file at `config.smee.channelFilePath` (default `/var/lib/generacy/smee-channel`, resolved by `SmeeChannelResolver`, see `packages/orchestrator/src/services/smee-channel-resolver.ts:170-181`). Contains a single validated channel URL. `WebhookSetupService` reads this file to answer "did we previously create a Generacy hook with this exact URL?" It only ever holds one URL at a time — the current or most-recent Generacy channel. That is sufficient for the FR-004 rule (exact-URL match on a prior persisted URL) because the resolver overwrites the file only when it successfully provisions a new channel, so the file's content lags one restart behind the current channel exactly when the hook needs healing.
**Dependencies added:** none. All required primitives (Pino logger, `StatusReporter`, `sendRelayEvent` callback shape, `SmeeChannelResolver`, `executeCommand` for `gh api`) already exist in the orchestrator.

## Project Structure

```
packages/orchestrator/src/
├── server.ts                                    # MODIFIED: pass sendRelayEvent + StatusReporter into WebhookSetupService
├── services/
│   ├── webhook-setup-service.ts                 # MODIFIED: FR-001..FR-004 + FR-006 + status transition
│   ├── smee-channel-resolver.ts                 # UNCHANGED: source of persisted URL
│   ├── status-reporter.ts                       # UNCHANGED: existing degraded-status transport
│   ├── post-activation-retry.ts                 # UNCHANGED: pattern reference for sendRelayEvent callback
│   └── __tests__/
│       └── webhook-setup-service.test.ts        # MODIFIED: new fail-loud coverage
└── __tests__/
    └── server-webhook-setup-loud-failure.test.ts  # NEW: server-level wiring regression test

specs/972-summary-snappoll-preview/
├── spec.md                                      # UNCHANGED (read-only per /plan constraint)
├── clarifications.md                            # UNCHANGED
├── plan.md                                      # THIS FILE
├── research.md                                  # NEW
├── data-model.md                                # NEW
├── quickstart.md                                # NEW
└── contracts/
    ├── webhook-registration-forbidden-event.md  # NEW: cluster.bootstrap payload shape
    ├── ensure-webhooks-behavior.md              # NEW: per-repo decision matrix
    └── degraded-status-transition.md            # NEW: /internal/status body + trigger conditions
```

Line-of-effect summary:

| File | Change | Requirement |
|------|--------|-------------|
| `webhook-setup-service.ts` (`_createRepoWebhook`) | Add `events[]=pull_request`, `events[]=check_run`, `events[]=check_suite` to the four `-F events[]=…` args (currently only `issues`). | FR-001 |
| `webhook-setup-service.ts` (`_findMatchingWebhook` → new `_selectExistingHookForUpdate`) | Replace "any URL match" with two-branch decision: (a) exact match on current channel URL → skip; (b) exact match on previously-persisted URL (read from `channelFilePath`) → update to current URL; (c) otherwise → log-and-skip (do not touch). | FR-004 |
| `webhook-setup-service.ts` (`_ensureWebhookForRepo` catch branch) | On 403 from list-or-create-or-update: emit `sendRelayEvent('cluster.bootstrap', { status: 'failed', reason: 'webhook-registration-forbidden', repo: 'owner/name', installationId, missingScope: 'admin:repo_hook' })`, call `statusReporter.pushStatus('degraded', 'webhook-registration-forbidden')`, and keep the existing structured warn log (FR-002 log-half already exists at line 384; refine to also include `installationId` and `missingScope`). | FR-002, FR-003, FR-006 |
| `server.ts` (WebhookSetupService construction at line 508) | Pass `sendRelayEvent` (same closure already built for `PostActivationRetryService` at lines 723-727) and `StatusReporter` (or its `pushStatus` bound method) as constructor args. | Wiring |
| `webhook-setup-service.ts` constructor | Accept optional `sendRelayEvent?: (channel: string, payload: unknown) => void`, optional `statusReporter?: { pushStatus(status, reason): Promise<void> }`, optional `channelFilePath?: string` (default `/var/lib/generacy/smee-channel`), optional `installationIdProvider?: () => Promise<number \| null>` (or read once from `.agency/credentials.yaml`). All optional → existing test suite keeps working; defaults keep the current no-op behavior when callbacks are absent. | DI, testability |
| `webhook-setup-service.test.ts` | New tests: (1) 403 on list emits event+status+log; (2) 403 on create same; (3) 200 on create → no event, no status change; (4) exact-URL match to current channel → skipped; (5) exact-URL match to persisted (rotated-channel) → PATCH to current URL; (6) URL not in {current, persisted} → log-and-skip, no PATCH; (7) events emitted at create time include all four locked events. | FR-001..FR-004 + FR-006 |
| `server-webhook-setup-loud-failure.test.ts` | Server-level integration: boot orchestrator with fake `gh` returning 403 → assert exactly one `cluster.bootstrap` event with the locked payload reaches the relay client's `send()` and one `POST /internal/status` with `{ status: 'degraded', statusReason: 'webhook-registration-forbidden' }` reaches the control-plane socket. Guards against a future refactor that drops one of the two loud-failure signals. | SC-002 |
| `.changeset/972-webhook-registration-fail-loud.md` | NEW: `patch` bump for `@generacy-ai/orchestrator` (no new public API; internal observability + wire event, no schema on the public export surface). | CI gate (CLAUDE.md changeset rule) |

## Constitution Check

No `.specify/memory/constitution.md` present in the repository. Applied project-level guardrails from `CLAUDE.md`:

- **Changeset:** required (`.changeset/972-webhook-registration-fail-loud.md`, `patch` for `@generacy-ai/orchestrator`) — this is not test-only.
- **Package boundary:** all edits in `packages/orchestrator/`; no cross-package additions, no re-exports.
- **No feature-flag / no env-var-configurable failure mode:** honored per clarifications Q3 → B (rejected D — "premature flexibility").
- **In-scope observability only:** the fix extends observable behavior on failure per FR-002/FR-003/FR-006; it does not add transports, new relay channels, or new IPC paths.
- **No `SmeeWebhookReceiver` extension:** P2 (FR-009) explicitly deferred.
- **Fail-loud, not fail-halt:** orchestrator keeps running; polling stays as safety net per spec Out of Scope. `degraded` is the correct status; `error` is rejected (Q3 → B).

## Key Technical Decisions

1. **Reuse `cluster.bootstrap`, do not add a new relay channel.** Locked by clarifications Q1 → A. `cluster.bootstrap` already carries `post-activation` and `boot-resume` failures the cloud UI renders; a webhook-registration 403 is a boot-time provisioning failure. Rejected `cluster.credentials` (Q1 option B) because refreshing a token cannot add a statically-missing App-level permission — would risk a useless refresh loop.
2. **Exact-URL match on persisted channel, not a URL heuristic.** Locked by Q2 → B. A broad `https://smee.io/*` heuristic (Q2 option A) risks clobbering a third-party smee webhook; a marker convention (Q2 option C) does not help pre-existing hooks. Exact-URL against a persisted file gives correct behavior for the stale-channel-rotation case and refuses to touch any hook we did not create.
3. **`degraded`, not `ready` (silent) and not `error` (halt).** Locked by Q3 → B. Polling stays as safety net so `error` (halt) is wrong; silent poll-fallback is the exact bug this fixes so `ready` is wrong; `degraded` is the honest functional-but-impaired state and matches the dashboard's existing status vocabulary.
4. **In-process `sendRelayEvent` callback, not HTTP round-trip through `/internal/relay-events`.** The orchestrator emits directly via `ClusterRelayClient.send()` (same pattern as `PostActivationRetryService.sendRelayEvent`). FR-006's "existing `/internal/relay-events` IPC path" wording is honored in spirit — the cloud sees the same `EventMessage` wire shape — without an unnecessary internal HTTP hop from the process that owns the relay client to its own HTTP endpoint back to the same relay client.
5. **Per-start `ensureWebhooks()` call site stays exactly as-is.** FR-008 / Q4 → A: no state migration, no zero-restart `refresh-requested` path (deferred). Pre-fix clusters heal on the next `generacy up` cycle once the App manifest gains the scope.
6. **`installationId` provenance:** read once at startup from `.agency/credentials.yaml` (the same file `github-auth-health.ts` and `credential-expiry-watcher.ts` read for the default `github-app` credential id). If not resolvable, emit the event with `installationId: null` — the payload's diagnostic value comes from `reason` + `missingScope` + `repo`, not the numeric id.

## Suggested Next Step

Run `/speckit:tasks` to generate the ordered task list for this plan.
