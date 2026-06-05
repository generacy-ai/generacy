# Clarifications

**Issue**: [generacy-ai/generacy#762](https://github.com/generacy-ai/generacy/issues/762)
**Branch**: `762-summary-when-cluster-s`

## Batch 1 — 2026-06-05

### Q1: Refresh-request relay event contract
**Context**: FR-002, FR-005, and US1's third acceptance criterion all reference emitting a relay event for refresh-request and auth-failed notifications, but the channel name is marked "TBD" and the payload shape is unspecified. The cloud side needs a stable contract to implement the consumer half. Without locking this contract here, planning will block.
**Question**: What channel name and payload shape should the cluster emit for (a) a refresh-request and (b) an auth-failed notification? Should both use `cluster.credentials` with different `status`/`action` fields, or two distinct channels?
**Options**:
- A: Single `cluster.credentials` channel; payloads discriminated by `action: 'refresh-requested' | 'auth-failed' | 'auth-recovered'`; include `credentialId`, `type: 'github-app'`, optional `expiresAt`, `reason`.
- B: Two channels — `cluster.credentials` for status (auth-failed/recovered) and a new `cluster.credential-refresh-request` for the refresh ask.
- C: Reuse an existing channel already consumed by the cloud (specify which).
- D: Other / propose during planning.

**Answer**: *Pending*

### Q2: Cloud-side consumer scope
**Context**: "Out of Scope" explicitly excludes the cloud refresh-chain fix (`generacy-cloud#813`), but the new cluster→cloud refresh-request event introduced here needs a cloud-side handler to actually trigger a fresh installation token mint. If the cloud doesn't consume the new event, the cluster's refresh-request is a no-op and SC-003 ("cluster recovers automatically") cannot be met.
**Question**: Is the cloud-side handler for the new refresh-request event in scope for this issue, tracked under `generacy-cloud#813`, or does it need a separate cloud ticket created as part of planning?
**Options**:
- A: Folded into `generacy-cloud#813` — that issue already mints fresh tokens; only the trigger source changes.
- B: Create a new companion cloud ticket during planning; do not block 762 on it.
- C: In scope for 762 — also implement the cloud handler under this issue.
- D: Cluster emits the event regardless; cloud consumer is best-effort future work and SC-003 is downgraded.

**Answer**: *Pending*

### Q3: Proactive expiry threshold and check cadence
**Context**: US2's first acceptance criterion gives `<5 min remaining` as an example threshold but does not lock it. The spec also doesn't say how often the orchestrator should check `expiresAt` — once per monitor poll, on a dedicated timer, or only at startup. Both values affect FR-006's rate-limit interaction and SC-001 (<2 min to detect).
**Question**: What near-expiry threshold and check cadence should the proactive detector use?
**Options**:
- A: Threshold 5 minutes before `expiresAt`; check every 60 seconds on a dedicated timer.
- B: Threshold 10 minutes; piggyback on existing monitor poll cycles (30s/60s) — no new timer.
- C: Threshold 5 minutes; check on every monitor poll AND on a 60s fallback timer.
- D: Other / propose during planning.

**Answer**: *Pending*

### Q4: Auth-failed → healthy state semantics
**Context**: FR-008 says "auth-failed state automatically clears when the next GitHub call succeeds," but the cluster runs at least two independent monitors (`LabelMonitorService`, `PrFeedbackMonitorService`) and may have multiple polled repos. It's ambiguous whether (a) the auth-failed state is a single cluster-wide flag flipped by any successful call, or (b) each monitor maintains its own auth-failed state. This affects the `/health` field semantics (FR-007) and the relay event emission pattern.
**Question**: Is the auth-failed state cluster-wide (single flag, any successful gh call clears it) or per-monitor/per-repo (independent state, only same-source success clears)?
**Options**:
- A: Cluster-wide single flag — any successful `gh` call from any monitor clears it; one auth-failed/recovered event emitted per transition.
- B: Per-monitor flag — each service tracks its own state; `/health` exposes worst-of-N; multiple events possible.
- C: Per-credential flag (currently equivalent to cluster-wide since only one github-app credential exists); designed to scale if multiple credentials added later.
- D: Other / propose during planning.

**Answer**: *Pending*

### Q5: `/health` endpoint field shape
**Context**: FR-007 specifies `githubAuthHealthy: boolean` but US1's second AC says "boolean or status field." A pure boolean cannot distinguish "never authenticated yet" from "transient failure" from "sustained auth failure." This matters for operator triage and for the cloud UI rendering in US1's third AC.
**Question**: Should `/health` expose a single boolean, an enum status, or a richer object with last-auth-success timestamp and consecutive-failure count?
**Options**:
- A: `githubAuthHealthy: boolean` only (matches FR-007 as written).
- B: `githubAuth: 'ok' | 'failing' | 'unknown'` (unknown = before first attempt).
- C: `githubAuth: { status: 'ok'|'failing'|'unknown', lastSuccessAt?: ISO, consecutiveFailures: number, credentialId?: string }`.
- D: Other / propose during planning.

**Answer**: *Pending*
