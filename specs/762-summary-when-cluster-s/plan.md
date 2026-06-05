# Implementation Plan: Cluster-Side GH_TOKEN Expiry Detection and Refresh Backstop

**Feature**: Cluster-side detection of GitHub App token expiry, distinct 401 handling in label/PR-feedback monitors, proactive refresh-request emission to the cloud, and an operator-visible `githubAuth` field on `/health`.
**Branch**: `762-summary-when-cluster-s`
**Status**: Complete
**Date**: 2026-06-05
**Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `/specs/762-summary-when-cluster-s/spec.md`

## Summary

Today the orchestrator silently retries `HTTP 401: Bad credentials` from GitHub at the label/PR-feedback monitor poll cadence (30s/60s) with no recovery path and no operator signal. This work adds the cluster-side backstop:

1. **Detection** — a new `GitHubAuthHealthService` tracks per-credential auth state (last success time, consecutive failures, expiry) and exposes it via `/health` as a rich object.
2. **Classification** — `LabelMonitorService.pollRepo()` and `PrFeedbackMonitorService` distinguish `HTTP 401` from generic poll errors and route to a distinct auth-failure path (log + state update + event).
3. **Proactive expiry** — a dedicated 60s timer reads `.agency/credentials.yaml`'s `expiresAt`; when <5 min remaining it asks the cloud for a refresh.
4. **Cloud signaling** — the orchestrator emits `cluster.credentials` relay events keyed on `action` (`refresh-requested` / `auth-failed` / `auth-recovered`), rate-limited to at most one refresh request per credential per 60s.
5. **Token-error parsing** — `gh-cli.ts` surfaces HTTP status from `gh` CLI stderr so callers can branch on auth-failure reliably.

The cloud-side consumer for `action: 'refresh-requested'` is a separate companion ticket (per Q2). The detection/observability ACs ship independently of that consumer.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >=22 (ESM modules, `node:` builtins).
**Primary Dependencies**: `fastify` (HTTP server), `pino` (logging), `zod` (schemas), `yaml` (read `.agency/credentials.yaml`), `@generacy-ai/workflow-engine` (`GhCliGitHubClient`, `executeCommand`), `@generacy-ai/cluster-relay` (`ClusterRelayClient`, `EventMessage`).
**Storage**: None added. Reads `/var/lib/generacy/wizard-credentials.env` (existing) and `<agencyDir>/credentials.yaml` (existing, written by control-plane). All state in memory on the orchestrator process.
**Testing**: `vitest` (orchestrator package, `tests/unit/services/**`). New tests for `GitHubAuthHealthService`, 401-vs-other classification in monitor services, `parseGhStatusCode` helper, and event-emission shape.
**Target Platform**: Linux orchestrator container (cluster-base / cluster-microservices). Node-only — no browser surface.
**Project Type**: single — orchestrator service in a monorepo.
**Performance Goals**:
- SC-001: time-to-detect expired token < 2 min (60s timer + first failed monitor poll ≤ 60s).
- SC-004: ≤1 refresh-request emit per credential per 60s during sustained 401.
**Constraints**:
- No new persistent storage on the cluster side.
- No new dependencies on the cluster image — must work inside the existing orchestrator process.
- Cloud-side consumer is **not** required to ship for FR-001…FR-004, FR-007…FR-009. Only SC-003 (auto-recovery via refresh-request) depends on the companion cloud ticket.
- Behavior must remain backwards compatible: when `.agency/credentials.yaml` is missing (e.g. wizard never sealed a credential) the proactive timer is a no-op and monitors retain today's behavior.
**Scale/Scope**: Single orchestrator process per cluster, ≤10 watched repos in steady state, single `github-app` credential today (designed for N).

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. No gates to evaluate. Constitution check **PASS** (vacuously).

## Project Structure

### Documentation (this feature)

```text
specs/762-summary-when-cluster-s/
├── spec.md                           # already authored
├── clarifications.md                 # already authored (Batch 1)
├── plan.md                           # THIS FILE
├── research.md                       # technology + pattern decisions
├── data-model.md                     # types/interfaces for new state + events
├── quickstart.md                     # how to validate locally
├── contracts/
│   ├── cluster-credentials-event.schema.json   # Zod-equivalent JSON Schema for the relay event payload
│   ├── github-auth-health.schema.json          # /health.githubAuth field shape
│   └── (existing speckit template files remain)
└── tasks.md                          # produced by /speckit:tasks, not this command
```

### Source Code (orchestrator package — repository monorepo)

```text
packages/orchestrator/
├── src/
│   ├── services/
│   │   ├── wizard-creds-token-provider.ts            # UNCHANGED — keep mtime-cache read path
│   │   ├── github-auth-health.ts                     # NEW — per-credential state machine + event emit + rate limit
│   │   ├── credential-expiry-watcher.ts              # NEW — 60s timer, reads .agency/credentials.yaml, calls GitHubAuthHealthService.checkExpiry()
│   │   ├── label-monitor-service.ts                  # MODIFIED — pollRepo() distinguishes 401, calls health.recordResult()
│   │   └── pr-feedback-monitor-service.ts            # MODIFIED — same 401 classification + recordResult()
│   ├── routes/
│   │   └── health.ts                                 # MODIFIED — adds githubAuth from GitHubAuthHealthService.snapshot()
│   ├── types/
│   │   └── github-auth.ts                            # NEW — GitHubAuthSnapshot, CredentialsEventPayload union, AuthRecordResult
│   └── server.ts                                     # MODIFIED — wire GitHubAuthHealthService + CredentialExpiryWatcher into startup
├── tests/
│   └── unit/services/
│       ├── github-auth-health.test.ts                # NEW
│       ├── credential-expiry-watcher.test.ts         # NEW
│       ├── label-monitor-service.401.test.ts         # NEW — focused on 401 branch
│       └── pr-feedback-monitor-service.401.test.ts   # NEW — focused on 401 branch
packages/workflow-engine/
└── src/actions/github/client/
    ├── gh-cli.ts                                     # MODIFIED — surface http status from `gh` stderr (parseGhStatusCode)
    └── __tests__/gh-cli.401-parsing.test.ts          # NEW (or co-located equivalent)
```

**Structure Decision**: Single-project structure within the monorepo. All net-new code lives in `packages/orchestrator/src/services/` (the natural home for monitor-adjacent runtime concerns) plus a small, surgical change to `packages/workflow-engine/src/actions/github/client/gh-cli.ts` to expose HTTP status codes. No new packages. No cross-package contracts beyond the existing `ClusterRelayClient.send({ type: 'event', event, data, timestamp })` shape and the existing `/internal/relay-events` route.

The `GitHubAuthHealthService` is the single owner of `githubAuth` state (keyed by `credentialId`, per Q4 answer C). The `/health` route, the relay-event emit, and the rate-limit counter all read/write through this service so semantics stay consistent across consumers.

The new code does **not** replace `wizard-creds-token-provider.ts` — that file still owns the `GH_TOKEN` read path. The new health service is a separate, additive observer.

## Complexity Tracking

> No constitution violations. Table omitted.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _none_ | _n/a_ | _n/a_ |
