# Feature Specification: CLI worker-count-deriver must read merged cluster config and never write to cluster.yaml

**Branch**: `712-problem-cli-s` | **Date**: 2026-05-23 | **Status**: Draft | **Issue**: [#712](https://github.com/generacy-ai/generacy/issues/712)

## Summary

The CLI's `reconcileWorkerCount()` (in `packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts`, called by both `npx generacy up` and `npx generacy update`) has two bugs that together break the worker-scale story end-to-end:

1. **Reads only `cluster.yaml`** — ignores `cluster.local.yaml` where the runtime worker-count source of truth was moved by #709. Any subsequent `npx generacy update` rewrites `.env` from the stale template default and destroys cloud-UI scaling.
2. **Writes back to `cluster.yaml`** — in fallback paths (missing key, malformed value, clamped from 0), the CLI mutates the git-tracked `cluster.yaml` — the exact behavior #709 was filed to eliminate.

The fix is to (a) switch `deriveWorkerCount` to use `readMergedClusterConfig` from `@generacy-ai/config` (becoming async), and (b) remove the cluster.yaml write-back branch entirely.

## Problem (verbatim from issue)

The CLI's [`reconcileWorkerCount()`](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts) — added by [#708](https://github.com/generacy-ai/generacy/pull/710), called by both `npx generacy up` and `npx generacy update` — has two related issues that together make the worker-scale story broken end-to-end:

### Bug 1: reads only `cluster.yaml`, ignores `cluster.local.yaml`

[worker-count-deriver.ts:32-44](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts#L32-L44) hard-codes:
```ts
const yamlPath = join(generacyDir, 'cluster.yaml');
if (!existsSync(yamlPath)) { ... }
content = readFileSync(yamlPath, 'utf-8');
```

But [#709](https://github.com/generacy-ai/generacy/pull/711) moved the runtime worker-count source of truth into `cluster.local.yaml` (worker-scaler writes only there now). The CLI's deriver never reads it, so:

1. User clicks +/+/+/+ in the cloud UI → orchestrator writes `cluster.local.yaml: workers: 5` and `.env: WORKER_COUNT=5`. Scale works.
2. User later runs `npx generacy update` (image refresh, channel switch, etc.) → `reconcileWorkerCount` reads only `cluster.yaml` (still `workers: 1` because that's the template default) → rewrites `.env` to `WORKER_COUNT=1` → `docker compose up -d` scales workers back to 1, destroying the 4 extras.

This **regresses the exact bug #708 was filed to fix**. The two PRs were merged in order (#710 then #711, with a rebase) but the CLI deriver was not updated to use `readMergedClusterConfig` during the rebase.

### Bug 2: rewrites `cluster.yaml` in fallback paths — directly violates #709

[worker-count-deriver.ts:156-181](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts#L156-L181):
```ts
if (derived.source !== 'cluster.yaml') {
  const yamlPath = join(generacyDir, 'cluster.yaml');
  ...
  doc.workers = derived.workerCount;
  atomicWriteSync(yamlPath, stringifyYaml(doc));
  logger.info(`Reconciled cluster.yaml workers to ${derived.workerCount}`);
}
```

When the deriver falls back (missing key, malformed value, clamped from 0), the CLI **writes back to `cluster.yaml`** — exactly the git-tracked-file mutation that [#709](https://github.com/generacy-ai/generacy/issues/709) was filed to eliminate. Every `npx generacy up` on a project with a missing/malformed `workers` field produces an uncommitted `cluster.yaml` diff in the user's working tree.

## Verified

- [worker-count-deriver.ts:32-44](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts#L32-L44) — read of `cluster.yaml` only
- [worker-count-deriver.ts:156-181](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts#L156-L181) — write to `cluster.yaml`
- [worker-scaler.ts:466-470](https://github.com/generacy-ai/generacy/blob/develop/packages/control-plane/src/services/worker-scaler.ts#L466-L470) — writes to `cluster.local.yaml`, not `cluster.yaml`
- [packages/config/src/cluster-config.ts](https://github.com/generacy-ai/generacy/blob/develop/packages/config/src/cluster-config.ts) — the merged-read helper that the deriver should use exists, but isn't imported

The orchestrator-side readers (`relay-bridge.ts`, `app-config.ts`) correctly use `readMergedClusterConfig` after #709. Only the CLI was missed.

## User Stories

### US1: Cloud-UI scaling persists across CLI lifecycle commands

**As a** developer using the Generacy cloud UI to scale a cluster's worker count,
**I want** subsequent `npx generacy update` and `npx generacy up` runs to preserve my scaled worker count,
**So that** routine image refreshes and channel switches don't silently revert workers to the template default.

**Acceptance Criteria**:
- [ ] After scaling to 5 workers via the cloud UI, running `npx generacy update` keeps `WORKER_COUNT=5` in `.env` and leaves 5 workers running.
- [ ] After scaling to 5 workers via the cloud UI, running `npx generacy up` keeps `WORKER_COUNT=5` in `.env` and leaves 5 workers running.
- [ ] `cluster.local.yaml` is the source of truth for worker count when present; `cluster.yaml` is only the template fallback.

### US2: `npx generacy up` leaves the working tree clean

**As a** developer with a project whose `cluster.yaml` has a missing or malformed `workers` field,
**I want** `npx generacy up` to use the derived/clamped value without rewriting my git-tracked `cluster.yaml`,
**So that** my working tree stays clean and I don't get spurious uncommitted diffs.

**Acceptance Criteria**:
- [ ] `git status` is clean after `npx generacy up` on a project with `workers: 0` in `cluster.yaml`.
- [ ] `git status` is clean after `npx generacy up` on a project with malformed `workers` (e.g., `workers: "five"`) in `cluster.yaml`.
- [ ] `git status` is clean after `npx generacy up` on a project with `cluster.yaml` missing the `workers` key entirely.
- [ ] A warning is logged when fallback/clamping occurs, but `cluster.yaml` is not modified.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `deriveWorkerCount(generacyDir, logger)` reads worker count from the merged result of `readMergedClusterConfig(generacyDir)` (i.e., `cluster.local.yaml` overlaid on `cluster.yaml`). | P1 | Replaces direct `readFileSync('cluster.yaml')`. Function signature becomes async. |
| FR-002 | All callers of `deriveWorkerCount` (`reconcileWorkerCount`, `up`, `update`) are updated to `await` the result. | P1 | Required by FR-001. |
| FR-003 | `reconcileWorkerCount` does not write to `cluster.yaml` under any code path. | P1 | Delete lines 156-181 of `worker-count-deriver.ts`. |
| FR-004 | When the derived value comes from a fallback (missing key, malformed value, clamped from 0), a warning is logged but no git-tracked file is mutated. | P1 | `.env` is still updated with `WORKER_COUNT=<derived>`. |
| FR-005 | Existing unit tests in `worker-count-deriver.test.ts` are updated to cover the async signature and merged-config read path. | P1 | |
| FR-006 | A regression test verifies the local-wins precedence: `cluster.local.yaml: workers: 5` + `cluster.yaml: workers: 1` → derived count is 5. | P1 | Pins the failure mode from US1. |
| FR-007 | A regression test verifies that after `reconcileWorkerCount` runs against a project with `workers: 0` (or missing/malformed) in `cluster.yaml`, the file's contents on disk are unchanged. | P1 | Pins the failure mode from US2. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Worker count preserved across `npx generacy update` after cloud-UI scaling | 100% (no reversion) | Manual end-to-end: scale to N via UI, run `npx generacy update`, confirm `docker compose ps` still shows N workers. |
| SC-002 | `cluster.yaml` mutations by CLI | Zero | `git diff packages/generacy/.../cluster.yaml` is empty after any `up`/`update` invocation in every test scenario. |
| SC-003 | Unit test coverage for merged-config read path | All four scenarios pass: local-only, template-only, both (local wins), neither (default) | `pnpm test worker-count-deriver` green. |
| SC-004 | No new lint/type errors | Zero | `pnpm typecheck && pnpm lint` green. |

## Assumptions

- `readMergedClusterConfig` from `@generacy-ai/config` already implements local-wins semantics correctly (verified by orchestrator-side usage in `relay-bridge.ts` and `app-config.ts`).
- The CLI's `up` and `update` commands' top-level handlers are already async, so threading `await` through `reconcileWorkerCount` is a mechanical change.
- The "warn and continue" UX for malformed `workers` values is preferable to either silent rewrite or hard error. Users who want a different value edit `cluster.yaml` themselves.

## Out of Scope

- Any change to `cluster.local.yaml` write semantics in the orchestrator (already handled in #709).
- Migration of legacy `cluster.yaml` files that have non-integer `workers` values (we warn, we don't rewrite).
- Surfacing the worker-count value in CLI output (informational logging only).
- Changes to how `.env` is written (the existing `.env` write path is correct; only the input value changes).
- Adding a `--workers <N>` CLI override flag (separate feature if desired).

## Related

- [#708](https://github.com/generacy-ai/generacy/issues/708) — original `.env` sync issue. Worker-scaler side fix landed correctly; CLI side fix has the bugs above.
- [#709](https://github.com/generacy-ai/generacy/issues/709) — `cluster.local.yaml` separation. Orchestrator side migration landed correctly; CLI deriver was missed.
- [#706](https://github.com/generacy-ai/generacy/issues/706) — Engine-API refactor that this thread builds on.

---

*Generated by speckit*
