# Research: GH_TOKEN Expiry Detection and Refresh Backstop

**Issue**: [generacy-ai/generacy#762](https://github.com/generacy-ai/generacy/issues/762)
**Branch**: `762-summary-when-cluster-s`
**Status**: Complete

This document captures the technology and pattern decisions that drive the plan. Each decision lists the alternatives considered, the rationale, and links to the code or contract that proves the decision is workable.

---

## D1: Source of `expiresAt` for the proactive expiry detector

**Decision**: Read `expiresAt` from `<agencyDir>/credentials.yaml` directly on the orchestrator, with stat-based cache invalidation (same pattern as `wizard-creds-token-provider.ts`).

**Why**:
- `credentials.yaml` is already produced by control-plane (`packages/control-plane/src/services/credential-writer.ts`) and read by `wizard-env-writer.ts` (`packages/control-plane/src/services/wizard-env-writer.ts:78`).
- Both processes share the cluster filesystem; `.agency/` is bind-mounted.
- mtime cache keeps cost flat across 60s ticks (no work unless the cloud just pushed a refresh).

**Alternatives considered**:
- **Query control-plane over Unix socket**: Adds a runtime dependency on control-plane being up; control-plane already crashes-resiliently (see CLAUDE.md "Control-Plane Daemon Crash Resilience (#624)"), so degraded control-plane would silently disable the expiry watcher — exactly the wrong failure mode for a backstop.
- **Parse `expiresAt` from `wizard-credentials.env`**: The env file only carries the token value, not metadata. Would require changing the writer schema and the daemon's mapping (`mapCredentialToEnvEntries` at `packages/control-plane/src/services/wizard-env-writer.ts:39`).

**Reference**: `wizard-env-writer.ts` already reads the same YAML with `YAML.parse(raw)`, validates structure with `parsed.credentials` shape check, and tolerates `ENOENT`. The new watcher uses the same pattern.

---

## D2: Where the orchestrator-process services emit relay events

**Decision**: The new `GitHubAuthHealthService` emits via the orchestrator's existing in-process `ClusterRelayClient` reference (`relayClientRef`) — **not** by POSTing to `/internal/relay-events`.

**Why**:
- `/internal/relay-events` exists to bridge the **control-plane process** to the orchestrator's relay client over HTTP-on-Unix-socket (per CLAUDE.md "Control-Plane Relay Event IPC (#594)"). The orchestrator process itself already holds `relayClientRef` (see `server.ts:326`).
- Direct in-process call avoids an HTTP round-trip and avoids requiring `ORCHESTRATOR_INTERNAL_API_KEY` for an in-process caller.
- The relay event wire shape is identical (`{ type: 'event', event, data, timestamp }`) — see `packages/orchestrator/src/routes/internal-relay-events.ts:44-49`.

**Alternatives considered**:
- **Use `/internal/relay-events`**: Adds latency and a self-loop. Already the wrong pattern for in-process emitters (orchestrator's `relay-bridge.ts` calls `client.send()` directly).
- **Emit through `RelayBridge.sendMetadata()`**: That path is for metadata heartbeat; semantics don't fit (events vs. snapshot).

**Reference**: `packages/orchestrator/src/server.ts:367-388` already shows the in-process callsite pattern for `sendRelayEvent: (channel, payload) => relayClientRef!.send({ type: 'event', event: channel, data: payload, timestamp: ... })`. The new service receives the same function via constructor DI.

---

## D3: Distinguishing `HTTP 401` from other errors in monitor services

**Decision**: Add a `parseGhStatusCode(stderr: string): number | undefined` helper in `packages/workflow-engine/src/actions/github/client/gh-cli.ts` and throw a typed `GhAuthError` (with `statusCode: 401`) from `executeGh()` when stderr matches. Monitors catch by `instanceof GhAuthError`.

**Why**:
- `gh` CLI writes `HTTP 401: Bad credentials` (and similar) to stderr on auth failures, with the status code present as a literal string. Pattern is stable across versions used in this repo (`gh-cli.ts` already calls `executeCommand('gh', ...)` and inspects `stderr`).
- A typed error keeps the monitor's `catch` branch precise and testable; it avoids string-sniffing in `label-monitor-service.ts`.
- `gh-cli.ts` is the single chokepoint — fixing it once covers both monitor services and any future caller.

**Alternatives considered**:
- **String-match stderr inside each monitor**: Duplicates parsing across `LabelMonitorService` and `PrFeedbackMonitorService`, and leaks `gh` CLI quirks into orchestrator code.
- **Add a separate `GitHubAuthClassifier` service**: Extra indirection for a one-line regex; not justified.

**Reference**: `gh-cli.ts:47-50` already centralizes the `executeGh()` call. The new helper attaches to it.

**Open verification item** (from spec.md Assumptions, line 86): the exact stderr format. Action: pre-implementation, run `GH_TOKEN=fake gh repo view ...` once and confirm the stderr substring; add a fixture-based test covering both the modern `HTTP 401` line and the alternate `gh: ... (HTTP 401)` form if present.

---

## D4: State key — per-credential, not per-monitor

**Decision**: `GitHubAuthHealthService` keys all state by `credentialId: string`. Today the only key is the github-app credential ID from `credentials.yaml`, but the service signature is `recordResult(credentialId, ok)` so adding github-pat or future credentials is purely additive.

**Why**: Q4 answer C (per-credential). Auth health is a property of the credential, not of the caller. A success from any monitor proves the token works; one state transition emits one event.

**Alternatives considered**:
- **Cluster-wide single flag**: Won't scale to multiple credentials.
- **Per-monitor flag**: Duplicate state, worst-of-N semantics for `/health`, ambiguous emission rules.

**Reference**: spec.md FR-008.

---

## D5: Resolving `credentialId` from the orchestrator

**Decision**: At startup the orchestrator reads `.agency/credentials.yaml` once to derive a `{ type: 'github-app' } → credentialId` map and caches it. The watcher refreshes this map on YAML mtime change. Monitors call `health.recordResult(githubAppCredentialId, ok)` where `githubAppCredentialId` comes from this map.

**Why**:
- Avoids each monitor learning the credentials layout.
- Tolerates the (current) single-credential case while scaling to N.
- If the YAML lists zero github-app credentials, the watcher and recorder become no-ops — `/health` reports `githubAuth.status = 'unknown'`.

**Alternatives considered**:
- **Pass `credentialId` through `WorkerConfig`**: Couples credential routing into the worker config schema for a single observability concern.
- **Hardcode `'github-app'` as the key**: Conflicts with future multi-credential support.

---

## D6: Rate limiting refresh requests

**Decision**: `GitHubAuthHealthService.maybeRequestRefresh(credentialId, reason)` uses an in-memory `Map<credentialId, lastRequestAtMs>` with a 60 000 ms minimum interval. A short-circuited call returns `false` and emits no event.

**Why**:
- Trivial to test (inject a `now()` clock).
- Survives the only relevant restart case: container restart resets the timer, which is acceptable — a fresh container also implies a fresh `wizard-credentials.env` read; cluster startup already re-runs activation.
- No external state required.

**Alternatives considered**:
- **Redis-backed counter**: Overkill for a per-cluster-process backstop.
- **File-based**: Persistence buys nothing here — restart = clean slate is fine.

**Reference**: SC-004.

---

## D7: `/health` field shape and additivity

**Decision**: Add `githubAuth: { status: 'ok' | 'failing' | 'unknown', lastSuccessAt?: string, consecutiveFailures: number, credentialId?: string }` to the health response. `unknown` is the initial state before any monitor call has resolved (per Q5 answer C). `credentialId` is omitted in `unknown`.

**Why**: Q5 answer C. Mirrors the field shape the cloud UI will render. Aligns with the existing additive pattern (`codeServerReady`, `controlPlaneReady`).

**Schema constraints to add** in `routes/health.ts:50-78`:
- Add `githubAuth` to both the 200 and 503 response schemas.
- Mark all sub-fields optional except `status` and `consecutiveFailures` so the schema validator doesn't reject `unknown` states.

**Reference**: contracts/github-auth-health.schema.json.

---

## D8: Recovery semantics

**Decision**: On any successful `gh` call recorded via `recordResult(credentialId, ok=true)` while the credential's current `status === 'failing'`, the service flips the status to `ok`, emits one `action: 'auth-recovered'` event, resets `consecutiveFailures = 0`, and updates `lastSuccessAt`. Subsequent successes are state-stable (no further emissions).

**Why**: FR-008 + Q4. One event per transition keeps the cluster.credentials channel cheap and unambiguous on the cloud side.

**Alternatives considered**:
- **Edge-triggered with separate "stable" counters** (e.g. emit after N consecutive successes): premature complexity; a single success refutes the auth-failed claim.

---

## D9: Timer cadence and lifecycle

**Decision**: `CredentialExpiryWatcher` uses `setInterval(60_000)` started from `server.ts` after the relay client reference is wired and before `server.listen()` returns. Stops on graceful shutdown alongside other services.

**Why**:
- 60s matches Q3 cadence.
- Independent of monitor polling — a stalled monitor must not stall the watcher.
- `setInterval` is fine here: the watcher's work is bounded (one YAML stat, one parse on mtime change, zero or one event emit).

**Alternatives considered**:
- **Use the existing monitor poll cadence**: Q3 answer A explicitly chose a dedicated timer because monitor stalls are exactly when the backstop must fire.
- **Cron-style scheduler**: Overkill.

---

## D10: Logging at default level

**Decision**: Distinct log lines, all at `warn` level on transition into `failing` and at `info` on transition into `ok`. Body uses structured fields (`credentialId`, `consecutiveFailures`, `lastSuccessAt`) to support SC-002 (operator can identify "auth failure" vs "idle" from default-level logs only).

Emitted lines (canonical):
- transition→failing: `warn { credentialId, consecutiveFailures, statusCode: 401 } "GitHub authentication failing — investigate credential refresh chain"`
- transition→ok: `info { credentialId, lastSuccessAt, recoveredAfterFailures } "GitHub authentication recovered"`
- proactive refresh: `warn { credentialId, expiresAt, secondsRemaining } "GitHub token near expiry — requesting refresh from cloud"`
- rate-limited refresh suppressed: `debug { credentialId, msSinceLastRequest } "Refresh request suppressed by rate limit"`

**Why**: Q5 surface lives in `/health`; logs are the second operator-facing channel. `warn` for fail-state-transitions makes the loud-failure requirement land at default pino level. Steady-state success is *not* logged on every poll — only on transition — to avoid log spam.

---

## Key References

- spec.md (this feature): `/specs/762-summary-when-cluster-s/spec.md`
- clarifications.md (this feature): `/specs/762-summary-when-cluster-s/clarifications.md`
- Existing token provider: `packages/orchestrator/src/services/wizard-creds-token-provider.ts`
- Internal relay event route: `packages/orchestrator/src/routes/internal-relay-events.ts`
- Label monitor 401 callsite: `packages/orchestrator/src/services/label-monitor-service.ts:489`
- Wizard env writer (YAML reader pattern): `packages/control-plane/src/services/wizard-env-writer.ts:78-96`
- gh CLI client: `packages/workflow-engine/src/actions/github/client/gh-cli.ts:29-50`
- Companion cloud-side ticket: `generacy-ai/generacy-cloud#813` (refresh chain) + new ticket to be filed for `action: 'refresh-requested'` handler (per Q2 answer B).
