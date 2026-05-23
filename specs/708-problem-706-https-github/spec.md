# Feature Specification: ## Problem

[#706](https://github

**Branch**: `708-problem-706-https-github` | **Date**: 2026-05-23 | **Status**: Draft

## Summary

## Problem

[#706](https://github.com/generacy-ai/generacy/issues/706) intentionally dropped \`.env\` writes from \`worker-scaler.ts\` on the reasoning that the orchestrator now owns replica lifecycle and \`WORKER_COUNT\` in \`.env\` is dead state. **That reasoning was wrong.** \`.env\` is read by the host's compose CLI every time \`docker compose up -d\` runs, which the user-facing \`npx generacy up\` and \`npx generacy update\` both invoke.

[packages/generacy/src/cli/commands/update/index.ts:114-124](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/update/index.ts#L114-L124):
\`\`\`ts
const pullResult = runCompose(ctx, ['pull'], …);
…
const upResult = runCompose(ctx, ['up', '-d']);
\`\`\`

The scaffolded compose has \`deploy.replicas: \${WORKER_COUNT:-1}\`. So:

1. User launches cluster → \`.env\` has \`WORKER_COUNT=1\` (scaffolder default) → 1 worker running.
2. User clicks +/+/+/+ in cloud UI → orchestrator scales to 5 via Engine API → \`cluster.yaml\` updated to \`workers: 5\` → \`.env\` still says \`WORKER_COUNT=1\`.
3. User runs \`npx generacy update\` later (e.g. to pick up a new image) → \`docker compose up -d\` reads \`.env\` → compose sees the worker service should have 1 replica → **destroys the 4 extra workers** the user explicitly scaled to.

Same hazard for any direct \`docker compose up -d\` invocation from the host, not just \`npx generacy update\`. The orchestrator-managed state silently loses on every compose re-up.

## Fix options

**A. Restore \`.env\` writes inside \`scaleWorkers\`.** Simplest; re-introduces what the previous (compose-shell-out) implementation already did. Both \`.env\` and \`cluster.yaml\` updated atomically inside the same scale operation. \`.env\` lives next to \`cluster.yaml\`, same filesystem, same \`atomicWrite\` helper already in worker-scaler. Cost: \`.env\` is technically a per-launch artifact that lives on the host filesystem only (cluster-base/cluster-microservices flow A); but for local-CLI launches it's in the project dir and we *can* reach it via \`resolveGeneracyDir\`.

**B. Have \`npx generacy up\` / \`update\` read \`cluster.yaml\` and inject \`WORKER_COUNT\` into the compose env before running.** Cleaner separation of source-of-truth — \`cluster.yaml\` is authoritative and \`.env\` becomes derived state. But requires CLI changes and assumes everyone uses \`npx generacy up\` (a power-user who runs raw \`docker compose up -d\` still has the bug).

**C. Both.** Belt-and-suspenders: worker-scaler keeps \`.env\` in sync (so raw \`docker compose\` works), AND \`npx generacy up\` re-derives WORKER_COUNT from cluster.yaml on each launch (so a stale \`.env\` doesn't override the source of truth). The CLI step also handles the bootstrap case where \`cluster.yaml\` was hand-edited but \`.env\` wasn't.

Recommend **C**. Implementation is small in each layer and the two work together: worker-scaler covers the \"user scaled via UI\" case, CLI covers the \"user edited cluster.yaml manually\" case and serves as a defense against \`.env\` drift from any other source.

## Acceptance

- After scaling to N via the cloud UI, \`.env\`'s \`WORKER_COUNT\` equals N.
- Running \`npx generacy update\` (or \`docker compose up -d\` directly) does not change the running worker count.
- A hand-edit of \`cluster.yaml\` followed by \`npx generacy up\` honours the cluster.yaml value, not a stale \`.env\` value.

## Related

- [#706](https://github.com/generacy-ai/generacy/issues/706) — the source of this regression. Closing comments documented \"WORKER_COUNT only matters for the first \`docker compose up\`\" which is incorrect.

## User Stories

### US1: Cloud UI scale survives compose re-up

**As a** Generacy operator who scaled workers via the cloud UI,
**I want** my chosen worker count to persist across `npx generacy update` and any direct `docker compose up -d`,
**So that** routine image updates and re-ups do not silently destroy workers I explicitly scaled to.

**Acceptance Criteria**:
- [ ] After scaling to N via cloud UI, `.env`'s `WORKER_COUNT` equals N.
- [ ] Running `npx generacy update` after a cloud-UI scale leaves the running worker count unchanged.
- [ ] A direct `docker compose up -d` from the host after a cloud-UI scale leaves the running worker count unchanged.

### US2: Hand-edited cluster.yaml wins over stale .env

**As a** power user who edits `cluster.yaml` directly,
**I want** `npx generacy up` / `update` to honour the value in `cluster.yaml` even when `.env` has a stale `WORKER_COUNT`,
**So that** `cluster.yaml` remains the authoritative source of truth.

**Acceptance Criteria**:
- [ ] After editing `cluster.yaml` to `workers: N`, the next `npx generacy up` runs N worker replicas regardless of the prior `WORKER_COUNT` in `.env`.
- [ ] `.env`'s `WORKER_COUNT` is reconciled to N as part of the same CLI invocation.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `scaleWorkers` in `worker-scaler.ts` writes the new `WORKER_COUNT` to the host project's `.env` after writing `cluster.yaml`. Uses the existing `atomicWrite` helper. | P1 | Restores the behaviour dropped in #706. |
| FR-002 | If a `WORKER_COUNT=` line exists in `.env`, replace its value in-place. If it does not exist, append `WORKER_COUNT=<N>` as a new line. Preserve all other lines and ordering. | P1 | |
| FR-003 | `npx generacy up` reads `workers` from `cluster.yaml` and re-derives `WORKER_COUNT` before invoking `docker compose up -d`. The re-derived value is written back to `.env` so the running compose process sees a consistent value. | P1 | Defends against stale `.env` after hand-edits to `cluster.yaml`. |
| FR-004 | `npx generacy update` performs the same re-derivation as FR-003 before invoking `docker compose pull` + `docker compose up -d`. | P1 | |
| FR-005 | If `cluster.yaml` is missing the `workers` key entirely, the CLI falls back to the scaffolder default (`1`) and logs a warning identifying the fallback path. | P2 | |
| FR-006 | Failures of the `.env` write in `scaleWorkers` (FR-001/FR-002) are logged but non-blocking: the `cluster.yaml` write (the source of truth) remains the authoritative outcome of the scale operation. | P1 | Determines ordering — see FR-007. |
| FR-007 | Write order in `scaleWorkers` is: `cluster.yaml` first, then `.env`. If the `.env` write fails after a successful `cluster.yaml` write, the next CLI re-derivation (FR-003/FR-004) will reconcile `.env` from `cluster.yaml`. | P1 | Clarified in Q2 (B). |
| FR-008 | If `.env` does not exist when `scaleWorkers` runs, skip the `.env` write and emit a warning log. Do not create a new `.env` from `scaleWorkers`; rely on the CLI re-derivation path (FR-003/FR-004) to populate `.env` on the next `up`/`update`. | P1 | Clarified in Q1 (B). |
| FR-009 | If `cluster.yaml` has `workers: 0` or a negative integer, the CLI re-derivation (FR-003/FR-004) clamps the effective `WORKER_COUNT` to `1` and emits a warning log. The clamped value is also written back to `.env`. | P1 | Clarified in Q3 (B). |
| FR-010 | If `cluster.yaml`'s `workers` value is not a non-negative integer (e.g. string, null, array), the CLI re-derivation treats it identically to a missing key (FR-005): fall through to the scaffolder default and emit a warning log distinguishing "malformed value" from "missing key" for log readers. | P1 | Clarified in Q4 (A). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Cloud-UI scale survives `npx generacy update` | 100% | Manual test: scale to 5 via UI; run `npx generacy update`; assert `docker compose ps` still shows 5 worker replicas. |
| SC-002 | Cloud-UI scale survives raw `docker compose up -d` | 100% | Manual test: scale to 5 via UI; run `docker compose up -d` from project dir; assert worker replicas unchanged. |
| SC-003 | Hand-edited `cluster.yaml` overrides stale `.env` on next `up` | 100% | Manual test: edit `cluster.yaml` `workers: 3` while `.env` says `WORKER_COUNT=5`; run `npx generacy up`; assert 3 worker replicas and `.env`'s `WORKER_COUNT=3`. |
| SC-004 | `.env` and `cluster.yaml` agree after every `scaleWorkers` call | 100% | Programmatic test: assert post-scale `.env`'s `WORKER_COUNT` equals `cluster.yaml`'s `workers`. |

## Assumptions

- `.env` lives next to `cluster.yaml` in the host project directory and is reachable via `resolveGeneracyDir` (the helper already used by `worker-scaler.ts`).
- The `atomicWrite` helper in `worker-scaler.ts` is suitable for `.env` writes (same filesystem, same trust boundary).
- `cluster.yaml`'s `workers` field, when present and well-formed, is a non-negative integer. Malformed/zero/negative values are edge cases handled per FR-009 / FR-010.
- The cluster-base / cluster-microservices flow A path (where `.env` lives on the host filesystem only) is the primary target. Other launch paths that don't materialize `.env` are handled by FR-008 (skip + warn).
- Cloud-UI scale operations flow through `scaleWorkers` (Engine API path); `cluster.yaml` is updated first by that flow today and continues to be the source of truth.

## Out of Scope

- Removing the `.env` file or the `WORKER_COUNT` env var from the compose interpolation contract (would require coordinated cluster-base / cluster-microservices template changes).
- Locking or transactional cross-file writes; partial-failure recovery relies on the next CLI re-derivation as a self-healing mechanism.
- Surfacing the FR-009 / FR-010 warning logs as a cloud-UI notification (separate concern; warning log is sufficient for v1).
- Migrating away from `.env` entirely toward `cluster.yaml`-driven compose env injection only.

---

*Generated by speckit*
