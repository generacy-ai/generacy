# Quickstart: Atomic `requeueForResume()` / `release()` re-pend

## Prerequisites

- Node.js >=22
- pnpm (workspace-managed)
- Docker or a live Redis 7 instance for the concurrency + Lua-execution tests

## Installation

Standard monorepo install:

```bash
pnpm install
```

## Build

```bash
pnpm --filter @generacy-ai/orchestrator build
```

## Test invocation

**All `redis-queue-adapter.*` tests** (unit + real-ioredis + ioredis-mock):

```bash
pnpm --filter @generacy-ai/orchestrator test -- redis-queue-adapter
```

**Only the new atomicity + round-trip regression suites** for this fix:

```bash
pnpm --filter @generacy-ai/orchestrator test -- \
  redis-queue-adapter.release-atomic \
  redis-queue-adapter.requeueForResume-atomic \
  redis-queue-adapter.round-trip-count \
  redis-queue-adapter.attemptcount-preservation
```

**Static script-wiring assertions** (fast; runs against extracted script constants):

```bash
pnpm --filter @generacy-ai/orchestrator test -- redis-queue-adapter.script-wiring
```

## Live Redis for integration tests

CI already provides a `redis:7` service for the existing `redis-queue-adapter.reclaim-lua.test.ts` suite. Locally, spin up an ad-hoc instance:

```bash
docker run --rm -p 6379:6379 redis:7
```

Then set the connection URL if the test harness needs it (default: `redis://127.0.0.1:6379`):

```bash
export REDIS_URL="redis://127.0.0.1:6379"
```

## Deterministic-interleave baseline demonstration (reviewer artifact)

Per Clarifications Q4 → C, the load-bearing deliverable of this fix is a deterministic controlled-interleave test that **fails against the pre-fix code** and **passes against the fixed code**. Run against BOTH to prove diagnostic value:

**Step 1 — checkout pre-fix baseline** (a fresh worktree keeps the fixed code intact):

```bash
git worktree add ../generacy-1069-baseline HEAD~1
cd ../generacy-1069-baseline
pnpm install
pnpm --filter @generacy-ai/orchestrator test -- redis-queue-adapter.release-atomic 2>&1 | tee ../1069-baseline-failure.log
```

Expected: the "deterministic controlled interleave" `describe` block FAILS with `expect(ZCARD pending).toBe(1)` receiving `2`. This failure output is the reviewer artifact — copy into the PR description as evidence.

**Step 2 — verify against the fix**:

```bash
cd /workspaces/generacy
pnpm --filter @generacy-ai/orchestrator test -- redis-queue-adapter.release-atomic
```

Expected: all tests pass. The interleave window is structurally closed; the harness naturally degenerates to `Promise.all` behaviour because there is no longer a between-round-trips point to inject into.

**Step 3 — clean up worktree**:

```bash
git worktree remove ../generacy-1069-baseline
```

## Changeset

Author `.changeset/1069-atomic-release-requeue-resume.md` with bump `'@generacy-ai/orchestrator': patch` per Decision 9 in `research.md`. Verify with:

```bash
pnpm changeset status --since=origin/develop
```

Note: `pnpm changeset status --since=origin/develop` reads git — it won't see the changeset until it's committed. Use plain `pnpm changeset status` to check the working-tree state.

## Available commands (reviewer / operator)

None new. This fix is invisible from the CLI. The `generacy` binary and its subcommands are unchanged.

## Verification checklist for the reviewer

- [ ] Static: `redis-queue-adapter.script-wiring.test.ts` asserts both new scripts are registered with correct `numberOfKeys` and the correct command names on `ioredis`.
- [ ] Static: both new scripts' text contains `HGET`, `HDEL`, `ZADD`, `DEL`, and (for `RELEASE_SCRIPT`) `SREM` in the correct order.
- [ ] Dynamic: deterministic interleave passes on the fix, FAILS on the pre-fix baseline (evidence in PR description).
- [ ] Dynamic: round-trip counter asserts exactly 1 command per happy-path call for `requeueForResume`, `release` retry branch, `release` dead-letter branch.
- [ ] Dynamic: 100-cycle attemptCount preservation passes.
- [ ] Interface: `git diff packages/orchestrator/src/types/monitor.ts` shows no changes touching `release` or `requeueForResume` (SC-008).
- [ ] Changeset: single `.changeset/1069-*.md` file with `patch` bump on `@generacy-ai/orchestrator`.

## Troubleshooting

**`cjson.decode is nil` on ioredis-mock**: expected. Both new scripts require the `cjson` Lua module which ioredis-mock's fengari VM does not expose. Use real ioredis against a live Redis 7 for these tests (see `research.md § Decision 6`). The existing `redis-queue-adapter.reclaim-lua.test.ts` documents the same limitation at lines 22–27.

**`CROSSSLOT Keys in request don't hash to the same slot`**: only surfaces on Redis Cluster. All KEYS args must map to the same slot. Verify with `redis-cli cluster keyslot <keyname>` for each of pending, claimed:<workerId>, heartbeat, dead-letter, and in-flight-items — they must all return the same integer. If they don't, the cluster's slot-mapping needs a hash-tag convention (out of scope for this fix; `RECLAIM_ORPHAN_SCRIPT` has the identical constraint already, so any cluster running today is already known-safe).

**Deterministic-interleave test hangs**: the interleave harness uses `redis.monitor()` or a wrapped client to detect the `HGET` from `requeueForResume`/`release`. If a prior test polluted the monitor subscriber list, `beforeEach` `redis.flushall()` may not reset it — explicitly `await redis.disconnect(); redis = new Redis(...);` between test blocks.

**Log-line assertions fail after the rewrite**: the fix is defined to preserve every log field and every message text verbatim (FR-005 + SC-007). If a downstream test asserts against the current text or fields and starts failing, that is a bug in the rewrite, not in the test.
