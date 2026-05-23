# Feature Specification: Fix `.env` `WORKER_COUNT` drift after worker scaling

**Branch**: `708-problem-706-https-github` | **Date**: 2026-05-23 | **Status**: Draft
**Source**: [#708](https://github.com/generacy-ai/generacy/issues/708)
**Workflow**: `speckit-bugfix`

## Summary

When a user scales workers via the cloud UI (orchestrator → Engine API), the running replica count diverges from `WORKER_COUNT` in the host's `.env` file. The next `docker compose up -d` (run via `npx generacy update`, `npx generacy up`, or directly) reads the stale `.env`, sees `WORKER_COUNT=1`, and tears down the extra workers the user explicitly scaled to. This bug was introduced by [#706](https://github.com/generacy-ai/generacy/issues/706), which dropped `.env` writes from `worker-scaler.ts` on the (incorrect) reasoning that `WORKER_COUNT` in `.env` was dead state.

Recommended fix is option **C** from the issue: belt-and-suspenders — restore `.env` writes inside `scaleWorkers` AND have the CLI re-derive `WORKER_COUNT` from `cluster.yaml` before invoking `docker compose up -d`.

## Problem

`.env` is read by the host's compose CLI on every `docker compose up -d`. The scaffolded `docker-compose.yml` declares `deploy.replicas: ${WORKER_COUNT:-1}` for the worker service. When `.env` drifts from `cluster.yaml`:

1. User launches cluster → `.env` has `WORKER_COUNT=1` (scaffolder default) → 1 worker running.
2. User scales to 5 via the cloud UI → orchestrator updates `cluster.yaml` to `workers: 5` and uses the Engine API to spawn replicas → `.env` still says `WORKER_COUNT=1`.
3. User runs `npx generacy update` (e.g. to pick up a new image) → `docker compose up -d` reads `.env` → compose sees replicas should be `1` → destroys the 4 extra workers.

Same hazard applies to any direct `docker compose up -d` from the host.

## Fix options considered

- **A. Restore `.env` writes inside `scaleWorkers`.** Simplest; both `.env` and `cluster.yaml` updated atomically inside the same scale operation.
- **B. Have `npx generacy up`/`update` read `cluster.yaml` and inject `WORKER_COUNT` into the compose env before running.** Cleaner separation of source-of-truth, but doesn't help users who run raw `docker compose up -d`.
- **C. Both** (recommended). Worker-scaler covers the "scaled via UI" case; CLI covers the "user edited `cluster.yaml` manually" case and defends against `.env` drift from any other source.

## User Stories

### US1: Worker count persists across compose re-ups

**As a** Generacy user who has scaled workers via the cloud UI,
**I want** my scaled worker count to survive `npx generacy update` and direct `docker compose up -d`,
**So that** routine image updates or restarts don't silently destroy workers I'm actively using.

**Acceptance Criteria**:
- [ ] After scaling to N via the cloud UI, `.env`'s `WORKER_COUNT` equals N.
- [ ] Running `npx generacy update` after scaling does not change the running worker count.
- [ ] Running `docker compose up -d` directly (no CLI) after scaling does not change the running worker count.

### US2: Authoritative cluster.yaml wins over stale .env

**As a** Generacy user who has hand-edited `cluster.yaml`,
**I want** the CLI to honor `cluster.yaml` as the source of truth,
**So that** a stale `.env` value can't override my intent.

**Acceptance Criteria**:
- [ ] A hand-edit of `cluster.yaml` (changing `workers:`) followed by `npx generacy up` results in the running worker count matching `cluster.yaml`, even if `.env` is stale.
- [ ] `npx generacy update` also re-derives `WORKER_COUNT` from `cluster.yaml` before invoking compose.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `scaleWorkers` in `packages/orchestrator/src/services/worker-scaler.ts` MUST write the new worker count to the host project's `.env` file (`WORKER_COUNT=<N>`), atomically alongside the `cluster.yaml` update. | P1 | Use the existing `atomicWrite` helper. `.env` location resolved via the same logic that locates `cluster.yaml` on the host filesystem. |
| FR-002 | `.env` write MUST preserve other env keys (no clobbering). If `WORKER_COUNT=` exists, update in place; otherwise append. | P1 | |
| FR-003 | `npx generacy up` MUST read `workers` from `cluster.yaml` and pass `WORKER_COUNT=<N>` to the `docker compose up -d` invocation (via env, not by rewriting `.env`). | P1 | `cluster.yaml` is the source of truth. CLI does not need to write `.env`. |
| FR-004 | `npx generacy update` MUST follow the same pattern as FR-003 for both `docker compose pull` and `docker compose up -d`. | P1 | Update reuses the same compose-up step. |
| FR-005 | When `cluster.yaml` is missing or has no `workers` key, the CLI MUST fall back to whatever `.env`/scaffolder default applies today (no behavior change for fresh clusters). | P2 | Fail-soft to current behavior. |
| FR-006 | Worker-scaler `.env` write failure MUST be logged but MUST NOT block the scale operation succeeding (cluster.yaml + Engine API state are authoritative; `.env` is derived). | P2 | Belt-and-suspenders: even if `.env` write fails, CLI re-derivation at next `up`/`update` will reconcile. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `.env` `WORKER_COUNT` matches `cluster.yaml` `workers` after a scaling operation. | 100% | Scale via UI to N=5; inspect `.env`; assert `WORKER_COUNT=5`. |
| SC-002 | Worker count survives `npx generacy update`. | No replicas destroyed | Scale to N>1, run `npx generacy update`, count running worker containers, assert == N. |
| SC-003 | Worker count survives direct `docker compose up -d` from the host. | No replicas destroyed | Same as SC-002 but bypassing CLI. |
| SC-004 | Hand-edited `cluster.yaml` takes effect via `npx generacy up`. | Running count == `cluster.yaml` value | Edit `cluster.yaml` `workers: 3`, run `npx generacy up`, assert 3 worker containers. |

## Assumptions

- `.env` lives in the same directory as `cluster.yaml` for local-CLI launches (resolvable via `resolveGeneracyDir` / the existing helper already used by worker-scaler).
- The host's `docker compose` CLI version honors env-var overrides passed via `--env-file` or process env when interpolating `${WORKER_COUNT:-1}` in `docker-compose.yml`.
- `cluster.yaml`'s `workers` field is always a non-negative integer when present (no string coercion required beyond existing validation).
- Cluster-base/cluster-microservices flow A (host filesystem `.env`) is the only deployment shape affected; in-cluster deployments don't have a host-side compose CLI invocation to defend against.

## Out of Scope

- Removing `WORKER_COUNT` interpolation from the scaffolded `docker-compose.yml` (a deeper refactor to make orchestrator the sole source of truth — separate issue).
- Reconciling `.env` from `cluster.yaml` automatically when the daemon starts (the bootstrap-time case is handled by the CLI re-derivation in FR-003/FR-004).
- Adding a `generacy doctor` check for `.env` ↔ `cluster.yaml` drift (could be a follow-up).
- Multi-repo / sibling-workdir scaling semantics.

## Related

- [#706](https://github.com/generacy-ai/generacy/issues/706) — the source of this regression. Closing comments documented "WORKER_COUNT only matters for the first `docker compose up`" which is incorrect.
- [#707](https://github.com/generacy-ai/generacy/pull/707) — the PR that landed #706.

---

*Generated by speckit*
