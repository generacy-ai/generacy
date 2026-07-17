# Clarifications

## Batch 1 — 2026-07-17

### Q1: Loud-failure relay channel and event shape
**Context**: FR-002 / FR-006 require a "distinct structured log line AND a relay event on a bootstrap/health channel visible to the cloud UI" when `WebhookSetupService.ensureWebhooks()` gets HTTP 403 for `admin:repo_hook`. The concrete channel and payload shape are undefined. This blocks the emit call site and the cloud-side listener wiring.
**Question**: Which existing relay channel should carry the webhook-registration-failure event, and what should the payload shape look like?
**Options**:
- A: Emit on `cluster.bootstrap` with `{ status: 'failed', reason: 'webhook-registration-forbidden', repo, installationId, missingScope: 'admin:repo_hook' }` — reuses the channel already carrying peer-repo/vscode-tunnel bootstrap failures.
- B: Emit on `cluster.credentials` with `{ action: 'auth-failed', credentialId: '<github-app-id>', kind: 'insufficient-scope', missingScope: 'admin:repo_hook' }` — treats it as a credential-permission problem, consistent with #762's `refresh-requested`/`auth-failed` events.
- C: Emit on a new `cluster.webhooks` channel with a webhook-specific payload — keeps webhook lifecycle events isolated from bootstrap/credentials.
- D: Emit on **both** `cluster.bootstrap` (for wizard/dashboard visibility) and `cluster.credentials` (so the App-permission fix path picks it up) — belt-and-suspenders.

**Answer**: A — Emit on the existing `cluster.bootstrap` relay channel with `{ status: 'failed', reason: 'webhook-registration-forbidden', repo, installationId, missingScope: 'admin:repo_hook' }`. Rationale: this is a boot-time provisioning failure, and FR-006 names cluster.bootstrap — the channel already carrying post-activation / boot-resume failures the cloud UI renders (post-activation-retry.ts, boot-resume-service.ts). Do NOT route it onto `cluster.credentials` (options B/D): that channel drives #762's token refresh / auth-failed path, and refreshing a token cannot add a statically-missing GitHub App permission, so it would risk a useless refresh loop. Keep it a bootstrap lifecycle event.

### Q2: "Looks like a previous Generacy webhook" — detection heuristic
**Context**: FR-004 says when a webhook already exists on the target repo, orchestrator should either (a) update it if it "looks like a previous Generacy webhook" or (b) log-and-skip. The detection heuristic for "previous Generacy webhook" is not defined, and mis-detection can either clobber a third-party webhook or leave stale ones pointing at dead smee channels.
**Question**: How should `ensureWebhooks()` decide that an existing webhook is a prior Generacy webhook eligible for URL-update vs. a foreign webhook that must be left alone?
**Options**:
- A: URL heuristic — any hook whose `config.url` matches `https://smee.io/*` is treated as Generacy-owned (update to current channel; log the swap).
- B: Exact-URL match only — update if `config.url` equals the previous persisted channel URL (from `.agency/` or a cluster-local marker); otherwise log-and-skip. Never touch a hook we didn't previously create.
- C: Explicit marker — Generacy webhooks carry a distinctive events set or a naming convention (e.g., include a specific header via `config.secret` prefix); only hooks matching the marker are updateable.
- D: Never update an existing hook — if any webhook exists on the repo, always log-and-skip; the operator resolves conflicts by hand. Prioritizes safety over convergence.

**Answer**: B — Update an existing hook only when its `config.url` exactly matches a previously-persisted Generacy channel URL (the one recorded in `.agency/` / cluster-local state); otherwise log-and-skip and never touch a hook we did not create. This extends the current `ensureWebhooks()` behavior (which already skips when a hook for the CURRENT channel URL exists) to also heal the rare stale-channel-rotation case, without the clobber risk of the broad 'any smee.io URL' heuristic (A). An explicit marker (option C, e.g. a distinctive events-set / secret convention) is worth adopting later as URL-independent provenance, but is not required for this fix and does not help already-created hooks.

### Q3: Fail-loud behavior — halt boot or continue degraded?
**Context**: FR-002 mandates the failure is "loud" but the spec's Assumptions and Out of Scope sections say polling stays as a "webhook dropped / never lived" fallback (i.e., the orchestrator keeps running). This creates ambiguity about the cluster's post-boot state and dashboard indicator: does a 403 on webhook registration push the cluster to `error` / `degraded` / stays `ready`?
**Question**: On a webhook-registration 403 at startup, what is the observable cluster status the operator sees in the dashboard?
**Options**:
- A: Cluster stays `ready` — polling fallback works, so the cluster is functional. The failure surfaces as a warning event + dashboard banner only. No status transition.
- B: Cluster transitions to `degraded` with `statusReason: 'webhook-registration-forbidden'` — reflects that a required subsystem is not functioning as designed, but the cluster keeps running.
- C: Cluster transitions to `error` — the whole point is that polling exhausts the token budget within hours, so the cluster is not viable long-term; force operator action.
- D: Configurable via env var (e.g., `WEBHOOK_REGISTRATION_FAILURE_MODE=warn|degrade|error`, default `degrade`) — lets operators tune per environment.

**Answer**: B — Transition the cluster to `degraded` with `statusReason: 'webhook-registration-forbidden'`. The cluster keeps running (polling stays as the safety-net fallback per the spec's Out of Scope), so it is NOT `error`; but a required subsystem (the event-driven webhook path) is not functioning as designed and the operator must see it, so it is NOT a silent `ready` (silent poll-fallback is the exact bug this issue fixes). `degraded` is the honest functional-but-impaired state, operator-visible in the dashboard, without halting boot. Not env-configurable (D) — premature flexibility for a v1 fix.

### Q4: Existing pre-fix clusters — auto-repair on next boot or manual only?
**Context**: FR-005 pins the observable outcome on smee-live clusters. But existing clusters that already booted without `admin:repo_hook` have persisted state (smee channel URL in `.agency/`, no repo webhook). After the App gains the permission, do these clusters need explicit intervention?
**Question**: How should already-provisioned clusters (booted before the permission was granted) get their webhook registered after the fix ships?
**Options**:
- A: Automatic on next boot — `ensureWebhooks()` already runs at every start; once the App has the permission, the next `generacy up` heals the cluster with no operator action.
- B: Automatic + one-time nudge — orchestrator additionally re-runs `ensureWebhooks()` on receipt of a specific relay message (`cluster.webhooks refresh-requested`) so the cloud UI can trigger repair without a full restart.
- C: Manual only — operators must restart clusters explicitly; the fix is documented in release notes. No code path for in-place repair.
- D: Not applicable — pre-fix clusters are re-provisioned from scratch; state migration is out of scope for this issue.

**Answer**: A — Automatic on next boot. `ensureWebhooks()` already runs at every orchestrator start, so once the GitHub App is granted `admin:repo_hook`, the next `generacy up` / restart heals the cluster with no operator action or state migration. Document the restart as the repair step in release notes. Option B (a `cluster.webhooks refresh-requested` relay message for zero-restart in-place repair) is a reasonable enhancement but requires a new relay channel + handler — defer to a follow-up unless zero-restart repair is explicitly wanted.

### Q5: FR-007 diagnosis — artifact location and diagnosis method
**Context**: FR-007 requires diagnosing whether the `admin:repo_hook` gap is snappoll-specific or systemic, with "findings recorded in the plan/notes." The concrete artifact and the diagnosis method (inspect App config? survey other clusters? test-provision?) are unspecified.
**Question**: Where does the FR-007 finding land, and how is the diagnosis performed?
**Options**:
- A: Written finding under a `## Diagnosis` section in `plan.md`; diagnosis method = inspect the Generacy GitHub App's declared permissions (single source of truth — if `admin:repo_hook` isn't in the App manifest, every install is affected).
- B: Written finding under a `## Diagnosis` section in `plan.md`; diagnosis method = check `.github` App installation permissions on ≥2 recently-provisioned clusters (empirical: covers the case where install-time consent skipped scopes).
- C: Separate `research.md` in the spec dir; diagnosis method = both A+B (manifest inspection AND spot-check installs), plus attempting a test webhook registration on a scratch repo.
- D: Comment thread on issue #972; no code artifact — findings live only in the issue for permanent traceability.

**Answer**: A — Written finding under a `## Diagnosis` section in `plan.md`; diagnosis method = inspect the Generacy GitHub App's declared permissions (the App manifest is the single source of truth: if `admin:repo_hook` / repository `Webhooks: write` is not declared, every installation is affected → systemic, not snappoll-specific). The 403 'Resource not accessible by integration' is manifest-level, so the answer is almost certainly systemic. Also add a scratch-repo test webhook registration (from option C) as an end-to-end validation that granting the scope actually fixes it — this doubles as the SC-003 check.
