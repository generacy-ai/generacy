# Tasks: Orchestrator surfaces a real version on `/health`

**Input**: Design documents from `/specs/907-symptom-connected-clusters/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Type surface + resolver

- [ ] **T001** [P] [US2] Extend `HealthResponseSchema` in `packages/orchestrator/src/types/api.ts` (~line 210-219): add `version: z.string()` (non-optional) immediately after `services` and before `codeServerReady`. Field order must match the Fastify JSON schema addition in T003. `HealthResponse` type propagates via `z.infer<>` — no separate type edit needed.
- [ ] **T002** [P] [US2] Create new file `packages/orchestrator/src/services/orchestrator-version.ts` exporting `resolveOrchestratorVersion(): string`. Internal `isRealVersion(candidate)` guard: `candidate !== undefined && candidate !== '' && candidate !== '0.0.0'` (bare literal, no trim). Precedence: (a) `process.env.ORCHESTRATOR_VERSION`, (b) `readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')` → `JSON.parse().version` inside try/catch, (c) return the literal string `'unknown'`. Both sources pass through `isRealVersion`. Any error on the package.json path falls through to the sentinel; no throw.

---

## Phase 2: Handler + schema wiring

- [ ] **T003** [US1] [US2] Wire the resolver into `/health` in `packages/orchestrator/src/routes/health.ts`:
  - Add `import { resolveOrchestratorVersion } from '../services/orchestrator-version.js';`
  - Inside `setupHealthRoutes`, after `githubAuthGetter` binding (~line 58), capture `const resolvedVersion = resolveOrchestratorVersion();` — one call per process, closure-captured (per Decision 5 in `research.md`).
  - **200-branch schema** (~line 70-82): add `version: { type: 'string' }` alongside `status`, `timestamp`, `services`.
  - **503-branch schema** (~line 84-98): identical addition. Both branches are load-bearing — omitting the 503 side regresses on the degraded-health reconnect path (FR-002).
  - **Handler body** (~line 131-137): set `version: resolvedVersion` in the constructed `HealthResponse`. Position matches schema field order.
  - Do **NOT** touch `/health/live` or `/health/ready` (spec §Out of Scope).

  Depends on: T001 (needs the Zod field to typecheck), T002 (needs the resolver import to resolve).

---

## Phase 3: Test (FR-007 regression guard)

- [ ] **T004** [US2] Create `packages/orchestrator/src/__tests__/health-version.test.ts` mirroring the shape of `packages/orchestrator/src/__tests__/health-code-server.test.ts:1-62` (same mocks: `probeCodeServerSocket`, `probeControlPlaneSocket`, `@generacy-ai/control-plane`, `@generacy-ai/workflow-engine`; drive via `server.inject()` against `createServer()`). Three cases per Decision 6 in `research.md`:
  - **(a) env-var real**: `beforeEach` sets `process.env.ORCHESTRATOR_VERSION = 'sha-abc1234'` → assert response `body.version === 'sha-abc1234'`. `afterEach` restores prior env. Real resolver runs.
  - **(b) env-var `"0.0.0"` guard falls through to package.json**: `process.env.ORCHESTRATOR_VERSION = '0.0.0'` → assert `body.version !== '0.0.0'` AND `body.version !== ''` (workspace package.json currently `"0.1.0"`; asserting inequality not equality keeps the test robust to workspace-version bumps). Real resolver runs. Covers Q1 → A.
  - **(c) sentinel**: `vi.mock('../services/orchestrator-version.js', () => ({ resolveOrchestratorVersion: () => 'unknown' }))` → assert `body.version === 'unknown'` (literal string, independent duplicate of the resolver's sentinel — anti-drift check per Q2 → A / Decision 7).

  Depends on: T003 (needs the field to be present in the wire response for `server.inject()` assertions to pass).

---

## Phase 4: Polish

- [ ] **T005** [P] [US1] [US2] Run `pnpm --filter @generacy-ai/orchestrator typecheck` and `pnpm --filter @generacy-ai/orchestrator test health-version` from the repo root. Both must pass. If typecheck fails on the handler, the Zod field is missing or misnamed (revisit T001). If the FR-007 test fails on the sentinel case, the resolver mock path in T004 case (c) is misspelled (`../services/orchestrator-version.js` — with `.js` extension for ESM).

  Depends on: T001, T002, T003, T004.

---

## Dependencies & Execution Order

**Parallel-eligible**:
- **T001** and **T002** can run in parallel: separate files (`types/api.ts` vs. new `services/orchestrator-version.ts`), no imports between them.

**Sequential**:
- **T003** depends on both T001 (Zod field for compile-time type of the handler's returned `HealthResponse`) and T002 (module the handler imports).
- **T004** depends on T003: the test asserts on `body.version` in the injected `/health` response, which is only present once the handler + schema are wired.
- **T005** depends on all prior tasks (verification pass).

**Suggested execution**:
1. T001 + T002 concurrently (parallel — mark [P]).
2. T003 (handler + schema wiring).
3. T004 (FR-007 test).
4. T005 (typecheck + test run).

**Not touched (intentional per spec + plan)**:
- `packages/cluster-relay/src/metadata.ts` — FR-006, out of scope.
- `packages/orchestrator/src/services/relay-bridge.ts` `collectMetadata` — Q5 → A, `channel`/`uptime` out of scope.
- `.github/workflows/publish-cluster-*.yml` and cluster-base / cluster-microservices Dockerfiles — cross-repo `ENV ORCHESTRATOR_VERSION=$sha` wiring is a follow-up PR, not in this repo's blast radius.
- `/health/live` and `/health/ready` handlers — spec scope is `/health` only.

## Next Step

Run `/speckit:implement` to begin executing the task list, or `/speckit:analyze` to sanity-check consistency across `spec.md`, `plan.md`, and `tasks.md` first.
