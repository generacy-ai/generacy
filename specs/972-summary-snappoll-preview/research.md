# Research — #972 Snappoll Webhook-Registration 403 Fail-Loud

## Scope

Narrow research to the four decisions the plan makes: (1) which relay channel carries the loud-failure event, (2) how to detect a "prior Generacy webhook" without clobbering foreign hooks, (3) which cluster status to transition to, (4) whether existing clusters need a migration path. All four are locked by clarifications; this file records the rationale + alternatives + sources so the tasks phase (and any future contributor) can trace them.

## Decision 1 — Relay channel & payload for webhook-registration 403

**Decision:** Emit on the existing `cluster.bootstrap` channel with payload
```json
{
  "status": "failed",
  "reason": "webhook-registration-forbidden",
  "repo": "<owner>/<name>",
  "installationId": <number|null>,
  "missingScope": "admin:repo_hook"
}
```

**Rationale:**
- Boot-time provisioning failure that must reach the cloud UI dashboard banner, exactly the surface `cluster.bootstrap` already renders for `post-activation` and `boot-resume` failures (see `packages/orchestrator/src/services/post-activation-retry.ts:97, 135` and `packages/orchestrator/src/services/boot-resume-service.ts`).
- `cluster.bootstrap` is already in the `ALLOWED_CHANNELS` allowlist at `packages/orchestrator/src/routes/internal-relay-events.ts:9-15` — no route-level change needed.
- Wire-shape parity with the existing `EventMessage` — cloud does not need a new listener path.

**Alternatives considered and rejected:**
- `cluster.credentials` (clarifications Q1 option B) — would tie into #762's `refresh-requested` / `auth-failed` path. Rejected: refreshing an installation token cannot add a statically-missing GitHub App permission, so the cloud would risk a useless refresh loop against a scope-gap that only a manual App-manifest edit can fix. Wrong semantic channel.
- New `cluster.webhooks` channel (Q1 option C) — cleaner separation but requires a new allowlist entry, a new cloud listener, and a new dashboard component. Overkill for a fix that reuses the existing banner surface.
- Both `cluster.bootstrap` + `cluster.credentials` (Q1 option D) — belt-and-suspenders, but the "belt" (cluster.bootstrap) is load-bearing and the "suspenders" (cluster.credentials) is misleading (see above). Rejected.

**Sources:**
- `packages/orchestrator/src/services/post-activation-retry.ts:80-101, 131-140` — established `cluster.bootstrap` `{ status, reason, ... }` payload pattern.
- `packages/orchestrator/src/routes/internal-relay-events.ts:9-15` — allowlist confirms `cluster.bootstrap` is a routable channel.
- Spec `## Fix` and `## User Stories → US1` — dashboard banner is the target surface.
- Clarifications Q1 → A (locks the decision).

## Decision 2 — "Prior Generacy webhook" detection heuristic

**Decision:** Only touch a hook whose `config.url` exactly matches the current provisioned channel URL (skip — already correct) or a previously-persisted Generacy channel URL (update to current). Read the persisted URL from `config.smee.channelFilePath` (`/var/lib/generacy/smee-channel`). If the existing hook's URL is neither, log-and-skip; never touch a foreign hook.

**Rationale:**
- The persisted file is written by `SmeeChannelResolver.writePersistedFile()` (`packages/orchestrator/src/services/smee-channel-resolver.ts:170-181`) after successful provisioning, and read at tier-2 of every resolve (line 78-88). Its lifecycle — one URL at a time, overwritten only when a new one is provisioned — is exactly the right shape for FR-004's "previously-persisted Generacy channel URL" concept.
- Exact-URL match is the strongest signal we own that we created a given hook, without introducing a new marker (which would only help hooks we create after the marker ships — no back-fill for stale hooks).
- The current implementation of `_findMatchingWebhook` (line 428-438) already does case-insensitive URL matching on the current channel URL; extending it to also consult the persisted file is a small, well-scoped change.

**Alternatives considered and rejected:**
- URL-family heuristic — treat any `https://smee.io/*` hook as Generacy-owned (Q2 option A). Rejected: risks clobbering third-party smee webhooks (many teams use smee for other purposes) — the exact scenario FR-004 is trying to prevent.
- Explicit marker — Generacy hooks carry a distinctive `config.secret` or an unusual event set (Q2 option C). Rejected for this fix as it does not help already-created hooks; worth adopting as a future URL-independent provenance signal but out of scope. Recorded as a follow-up in spec's `## Out of Scope`.
- Never update — always log-and-skip on any existing hook (Q2 option D). Rejected: leaves the stale-channel-rotation case unhealed (new provisioned URL, old hook still points at dead channel, cluster still gets 0 events).

**Sources:**
- `packages/orchestrator/src/services/webhook-setup-service.ts:428-438` — current URL-match implementation to extend.
- `packages/orchestrator/src/services/smee-channel-resolver.ts:105-181` — persisted-file read + write path.
- Clarifications Q2 → B (locks the decision).

## Decision 3 — Cluster status transition on webhook-registration 403

**Decision:** Transition to `degraded` with `statusReason: 'webhook-registration-forbidden'`. Cluster keeps running (polling stays as the safety-net fallback). Not env-configurable.

**Rationale:**
- `degraded` accurately describes the state: a required subsystem (event-driven webhook path) is not functioning as designed, but the cluster is still processing work.
- `ready` is the status that produced the original bug — silent poll-fallback with no operator signal. Rejected.
- `error` implies the cluster halts / is unusable, but the polling fallback keeps the cluster viable long enough for the operator to see the banner and grant the App permission. Rejected.
- Matches the status vocabulary the control-plane already accepts (see `ClusterStatus` in `packages/orchestrator/src/services/status-reporter.ts:3`): `'bootstrapping' | 'ready' | 'degraded' | 'error'`.

**Alternatives considered and rejected:**
- Env-var-configurable failure mode (Q3 option D — `WEBHOOK_REGISTRATION_FAILURE_MODE=warn|degrade|error`). Rejected as premature flexibility for a v1 fix — the choice is not ambiguous once the fix exists.

**Sources:**
- `packages/orchestrator/src/services/status-reporter.ts` — existing transport.
- Spec Assumptions ("Polling remains a safety net…") — confirms cluster should keep running.
- Clarifications Q3 → B (locks the decision).

## Decision 4 — Existing pre-fix clusters — auto-heal on restart

**Decision:** Existing clusters heal automatically on the next `generacy up` / orchestrator restart. No state migration. No zero-restart in-place repair path. Restart is the documented remediation.

**Rationale:**
- `ensureWebhooks()` already runs unconditionally at every orchestrator start (see `packages/orchestrator/src/server.ts:509`). Once the App manifest gains `admin:repo_hook`, the next start of every cluster gets a 200 instead of a 403 and creates the missing hook — no per-cluster state migration required.
- The persisted channel URL is preserved across restarts by `SmeeChannelResolver` tier-2 (`source: 'persisted'`), so the healed hook targets the same channel the cluster is already listening on.
- Zero-restart repair (Q4 option B — a `cluster.webhooks refresh-requested` relay message) would require a new relay channel + a new lifecycle action + a new handler. Reasonable follow-up if operator feedback shows the restart step is disruptive; out of scope for the P1 fix.

**Alternatives considered and rejected:**
- Zero-restart repair (Q4 option B). Deferred to a follow-up.
- Manual only, no auto-heal (Q4 option C). Rejected: `ensureWebhooks()` at every start already auto-heals for free.
- N/A — pre-fix clusters are re-provisioned (Q4 option D). Rejected: existing clusters are the whole population we're fixing for.

**Sources:**
- `packages/orchestrator/src/server.ts:509` — per-start `ensureWebhooks()` call.
- Spec US2 acceptance criteria — locks restart-to-repair as the documented remediation.
- Clarifications Q4 → A (locks the decision).

## Implementation Patterns Referenced

- **`sendRelayEvent` callback signature and wiring** — `packages/orchestrator/src/services/post-activation-retry.ts:21, 80, 97, 135` shows the exact `(channel: string, payload: unknown) => void` shape and the three canonical emit sites. Reuse verbatim.
- **`StatusReporter.pushStatus` call pattern** — same file at line 133 shows the async fire-and-forget pattern (`await this.statusReporter.pushStatus('degraded', statusReason)`). Reuse verbatim.
- **In-process relay-client injection into orchestrator services** — `packages/orchestrator/src/server.ts:723-727, 738-742` shows the `relayClientRef` closure that binds a relay client (post-async-activation) into a `sendRelayEvent` callback. Extend the same pattern to `WebhookSetupService`.
- **Persisted-file read for provenance** — `packages/orchestrator/src/services/smee-channel-resolver.ts:105-131` shows the `readFile` + validation-regex pattern. Reuse for reading `channelFilePath` from `WebhookSetupService`.

## Key Sources / References

- **Spec:** `specs/972-summary-snappoll-preview/spec.md`
- **Clarifications:** `specs/972-summary-snappoll-preview/clarifications.md` — Batch 1, Q1–Q5.
- **Live evidence:** spec `## Evidence (snappoll cluster, cluster-base:preview, 2026-07-17)`.
- **Related CLAUDE.md entries:** #952 (smee channel auto-provisioning), #953 (adaptive polling for smee-less clusters), #762 (GH_TOKEN expiry detection — analogous `cluster.credentials` pattern deliberately not reused per Decision 1), #630/#634 (cluster.bootstrap relay-event pattern for boot lifecycle).
- **GitHub REST API — webhooks:**
  - `GET /repos/{owner}/{repo}/hooks` — https://docs.github.com/en/rest/webhooks/repos#list-repository-webhooks
  - `POST /repos/{owner}/{repo}/hooks` — https://docs.github.com/en/rest/webhooks/repos#create-a-repository-webhook
  - `PATCH /repos/{owner}/{repo}/hooks/{hook_id}` — https://docs.github.com/en/rest/webhooks/repos#update-a-repository-webhook
- **GitHub App permissions — webhooks scope:** repository `Webhooks: Read & write` (declared in App manifest at `github.com/settings/apps/<generacy-app>/permissions`).
- **Related issues:** #970 (cockpit auto GraphQL exhaustion — operator-PAT side; this issue unblocks its FR-011 doorbell).
