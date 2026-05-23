# Tasks: CLI worker-count-deriver must read merged cluster config

**Input**: Design documents from `/specs/712-problem-cli-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/derive-worker-count.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

All tasks belong to **US1** — "Fix `reconcileWorkerCount` so cloud-UI scaling survives `npx generacy up` / `npx generacy update`, and stop mutating the git-tracked `cluster.yaml`."

## Phase 1: Core Implementation

- [ ] **T001 [US1]** Update `DeriveResult` type and add `readCanonicalOnly` helper in `packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts`
  - Extend `DeriveResult.source` enum to `'cluster.yaml' | 'cluster.local.yaml' | 'clamped' | 'default'` (per `data-model.md` and Decision 4).
  - Extract the current inline canonical-only read body (existsSync + readFileSync + parseYaml + `RawClusterYamlSchema` + numeric/clamping branches) into a private `readCanonicalOnly(generacyDir): DeriveResult` helper. No behavior change in this helper — it is the degraded-read fallback path.
  - Keep `atomicWriteSync`, `applyWorkerCountToEnv`, `syncEnvWorkerCount`, `SyncEnvResult` untouched in this task.

- [ ] **T002 [US1]** Convert `deriveWorkerCount` to async + merged-config read in `packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts`
  - Add `import { readMergedClusterConfig } from '@generacy-ai/config';`.
  - Change signature to `export async function deriveWorkerCount(generacyDir: string, _logger: Logger): Promise<DeriveResult>`.
  - Implement the contract in `contracts/derive-worker-count.md` § Behavior:
    1. `try { const { merged, canonical, local } = await readMergedClusterConfig(generacyDir); }`
    2. On success, branch in this order: `local.workers` (set + valid) → `source: 'cluster.local.yaml'`; else `canonical.workers` (set + valid) → `source: 'cluster.yaml'`; else `source: 'default'` with a warning describing what was missing.
    3. Both files absent → `source: 'default'`, warning `"cluster.yaml not found at <path>; using default 1"`.
    4. Canonical absent + valid local (Q3=B) → emit warning `"cluster.yaml not found at <path>; using cluster.local.yaml value (workers: <n>). Run 'npx generacy init' to restore the template config."` alongside `source: 'cluster.local.yaml'`.
    5. On throw from `readMergedClusterConfig` (corrupt/schema-rejected local), catch → call `readCanonicalOnly(generacyDir)` (T001), prepend warning `"cluster.local.yaml unreadable; using cluster.yaml value"`, force `source = 'cluster.yaml'` only when a canonical value was actually used (keep `'default'` if canonical was also absent/malformed — per contract § Error-handling row "canonical malformed, local absent").
  - Numeric clamping rules unchanged from current implementation (integer ≤ 0 → `'clamped'`; non-integer / wrong type → `'default'`).
  - Function still never throws; all errors fold into the result.

- [ ] **T003 [US1]** Remove the `cluster.yaml` write-back branch and make `reconcileWorkerCount` async in `packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts`
  - Change signature to `export async function reconcileWorkerCount(generacyDir: string, logger: Logger): Promise<{ workerCount: number; envWrote: boolean }>`.
  - Replace `const derived = deriveWorkerCount(...)` with `const derived = await deriveWorkerCount(...)`.
  - Delete lines 157–182 (the `if (derived.source !== 'cluster.yaml') { ... atomicWriteSync(yamlPath, ...) }` block) entirely. No replacement — no self-heal under any branch.
  - Update the info log so the source name is accurate per Decision 4:
    - `derived.source === 'cluster.local.yaml'` → `'Reconciled WORKER_COUNT from cluster.local.yaml: <n>'`
    - otherwise → `'Reconciled WORKER_COUNT from cluster.yaml: <n>'` (covers `cluster.yaml`, `clamped`, `default` — keeps existing format).
  - Drop now-unused imports if any (`renameSync`, `statSync`, `writeFileSync` likely still needed by `atomicWriteSync`; `stringifyYaml` becomes unused — remove it).

## Phase 2: Caller Updates

- [ ] **T004 [P] [US1]** Await `reconcileWorkerCount` in `packages/generacy/src/cli/commands/up/index.ts:29`
  - Change `reconcileWorkerCount(generacyDir, logger)` → `await reconcileWorkerCount(generacyDir, logger)`.
  - Caller is already inside an `async` Commander action handler — no other changes needed.

- [ ] **T005 [P] [US1]** Await `reconcileWorkerCount` in `packages/generacy/src/cli/commands/update/index.ts:93`
  - Change `reconcileWorkerCount(generacyDir, logger)` → `await reconcileWorkerCount(generacyDir, logger)`.
  - Caller is already inside an `async` Commander action handler — no other changes needed.

## Phase 3: Tests

- [ ] **T006 [US1]** Update existing tests for async signature in `packages/generacy/src/cli/commands/cluster/__tests__/worker-count-deriver.test.ts`
  - All existing `describe('deriveWorkerCount', ...)` and `describe('reconcileWorkerCount', ...)` cases: await the calls and switch the test function to `async`.
  - Delete or rewrite the two existing tests that assert self-heal:
    - `'idempotency: running twice on malformed yaml self-heals on first call, no-op on second'` (lines ~260–282) — rewrite to assert `cluster.yaml` is **byte-identical** after both calls (no self-heal); `.env` still gets `WORKER_COUNT=1`.
    - `'cluster.yaml self-heal preserves other keys'` (lines ~284–297) — rewrite as `'cluster.yaml is never rewritten even when workers is malformed'`: assert `readFileSync(yamlPath, 'utf-8') === yamlBefore` after `reconcileWorkerCount`.
  - The `'deriveWorkerCount on unreadable cluster.yaml'` describe block: keep, but expect `source === 'default'` via the degraded-read fallback (canonical also unreadable).

- [ ] **T007 [US1]** Add the 8-row merged-config matrix tests in `packages/generacy/src/cli/commands/cluster/__tests__/worker-count-deriver.test.ts`
  - New `describe('deriveWorkerCount — merged cluster config (#712)', ...)` block. One `it` per row of the matrix in `data-model.md` § "Behavioral matrix":
    1. canonical valid (`workers: 3`), local absent → `workerCount=3, source='cluster.yaml', warnings=[]`.
    2. canonical valid (3), local valid (5) → `workerCount=5, source='cluster.local.yaml', warnings=[]`.
    3. canonical valid (3), local malformed (`workers: not-a-number`) → `workerCount=3, source='cluster.yaml'`, warnings include `/cluster\.local\.yaml unreadable/`.
    4. canonical absent, local valid (5) → `workerCount=5, source='cluster.local.yaml'`, warnings include `/npx generacy init/`.
    5. canonical absent, local absent → `workerCount=1, source='default'`, warnings include `/cluster\.yaml not found/`.
    6. canonical malformed (`workers: "five"`), local absent → `workerCount=1, source='default'`, warnings include `/malformed/`.
    7. canonical malformed, local valid (5) → `workerCount=5, source='cluster.local.yaml'`, warnings include `/cluster\.local\.yaml unreadable/` (the canonical malformedness is masked because local wins; document the chosen warning text in the test).
    8. canonical `workers: 0`, local absent → `workerCount=1, source='clamped'`, warnings include `/clamping to 1/`.
  - Use the existing `mkdtempSync` + `writeFileSync` fixture pattern. Reuse `makeLogger()` / `asLogger()` helpers.

- [ ] **T008 [US1]** Add the acceptance-criterion regression test in `packages/generacy/src/cli/commands/cluster/__tests__/worker-count-deriver.test.ts`
  - New `it('regression #712: scaled overlay survives reconcileWorkerCount; cluster.yaml byte-identical', ...)`:
    - Write `cluster.yaml: workers: 1`.
    - Write `cluster.local.yaml: workers: 5`.
    - Write `.env: WORKER_COUNT=1`.
    - Snapshot `cluster.yaml` bytes.
    - Call `await reconcileWorkerCount(dir, logger)`.
    - Assert: result `{ workerCount: 5, envWrote: true }`; `.env` contains `WORKER_COUNT=5`; `readFileSync(cluster.yaml)` is byte-identical to the snapshot.
  - This is the canonical guard for acceptance criteria #1 and #2 in `spec.md`.

## Phase 4: Verification

- [ ] **T009 [US1]** Run unit tests and manual verification per `quickstart.md`
  - `pnpm --filter @generacy-ai/generacy test -- worker-count-deriver` → all green.
  - `pnpm --filter @generacy-ai/generacy build` → no type errors (catches missed `await` on callers, missed import updates).
  - Manual scenario from `quickstart.md` § "Manual verification — the regression scenario from the spec": confirm `.env` shows `WORKER_COUNT=5` and `cluster.yaml` is unchanged after `node packages/generacy/bin/generacy.js update --dry-run`.
  - Optional: run degraded-overlay scenario (`quickstart.md` § "Verification — degraded local overlay") and canonical-missing scenario (§ "Verification — canonical missing, overlay valid").

## Dependencies & Execution Order

**Sequential within Phase 1**: T001 → T002 → T003 (each builds on the previous within the same file).

**Phase 1 → Phase 2**: T004 and T005 depend on T003 (callers need the async signature to compile).

**Phase 2 tasks are parallel with each other**: T004 and T005 touch different files (`up/index.ts` vs `update/index.ts`), no shared state. Mark `[P]`.

**Phase 1 → Phase 3**: T006/T007/T008 depend on T001+T002+T003 to compile against the new types. T006 must come before T007 and T008 only because all three edit the same test file (avoid merge conflicts within a single editor session); they don't depend on each other logically.

**Phase 3 → Phase 4**: T009 depends on T002+T003+T004+T005+T006+T007+T008 (need the whole stack to compile and tests to exist).

**Parallel opportunities**:
- T004 ∥ T005 (different files, both depend on T003).
- After T003 lands, T004/T005 can be done in parallel with T006/T007/T008 (different files).

**Suggested execution order** (one agent, sequential):
T001 → T002 → T003 → T004 → T005 → T006 → T007 → T008 → T009.

**Parallel-friendly order** (two agents after T003):
- Agent A: T004 → T005
- Agent B: T006 → T007 → T008
- Both: T009 (verification once both streams merge)
