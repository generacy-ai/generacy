# Tasks: Model-name route resolution + CLAUDE_CONFIG_DIR gateway env in every launch builder

**Input**: Design documents from `/specs/1198-context-claude-code-validates/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/launch-route.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Route primitive (core module)

- [X] T001 [US1] Create `packages/generacy-plugin-claude-code/src/launch/route.ts` with:
  - `type Route = 'subscription' | 'gateway'`.
  - `resolveRoute(model?: string): Route` — pure, returns `'gateway'` iff `model` contains `/`, else `'subscription'` (including `undefined` and `''`). No I/O, no env reads, no cache (contract: `contracts/launch-route.md`, FR-001).
  - `DEFAULT_GATEWAY_CONFIG_DIR = '/home/node/.claude-gateway'`.
  - `resolveGatewayConfigDir(explicit?: string): string` — `explicit ?? process.env.GENERACY_CLAUDE_GATEWAY_CONFIG_DIR ?? DEFAULT_GATEWAY_CONFIG_DIR` (nullish chaining only; FR-002, Q2=A).
  - `GatewayRouteUnavailableError extends Error` — readonly fields `model` + `gatewayConfigDir`, `name = 'GatewayRouteUnavailableError'`; message names the model, the gateway dir, and the literal `GENERACY_LLM_GATEWAY_URL` (FR-005, SC-003, Decision 5).
  - Module-level `const provisionedDirs = new Set<string>()` (positive-only cache).
  - `assertGatewayProvisioned(model: string, gatewayConfigDir: string): void` — cache hit → return; else `existsSync(join(dir, 'settings.json'))` present → `add` to cache + return; absent → throw `GatewayRouteUnavailableError`. Negative result NEVER cached (FR-006, Q3=A).
  - `_resetGatewayProvisionCacheForTests(): void` — clears the set (mirrors `_setHasEffortMechanismForTests`).
  - Imports: `node:fs` (`existsSync`), `node:path` (`join`) only — zero new deps.

## Phase 2: Plugin wiring

- [X] T002 [US1] Modify `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`:
  - Add `route?: 'gateway'` to the plugin-local `LaunchSpec` interface (type excludes `'subscription'` by design so it cannot be stamped on subscription launches; FR-007, data-model invariants).
  - Add exported `interface ClaudeCodeLaunchPluginOptions { gatewayConfigDir?: string }`.
  - Add `constructor(options?: ClaudeCodeLaunchPluginOptions)` storing `this.gatewayConfigDir = resolveGatewayConfigDir(options?.gatewayConfigDir)` (optional so ~15 existing `new ClaudeCodeLaunchPlugin()` call sites compile unchanged; Decision 6).
  - Add private `applyRoute(spec: LaunchSpec, model?: string): LaunchSpec` — subscription route returns `spec` **as-is** (no spread); gateway route calls `assertGatewayProvisioned(model!, this.gatewayConfigDir)` then returns `{ ...spec, env: { CLAUDE_CONFIG_DIR: this.gatewayConfigDir }, route: 'gateway' }`.
  - Import `resolveRoute`, `resolveGatewayConfigDir`, `assertGatewayProvisioned` from `./route.js`.

- [X] T003 [US1] In the same file (`claude-code-launch-plugin.ts`), wrap the return of each of the **six** model-bearing builders in `this.applyRoute(...)`, passing `intent.model`:
  - `buildPhaseLaunch`, `buildPrFeedbackLaunch`, `buildMergeConflictLaunch`, `buildReviewLaunch`, `buildRemediateLaunch`, `buildConversationTurnLaunch`.
  - Each `return { command, args, stdioProfile }` becomes `return this.applyRoute({ command, args, stdioProfile }, intent.model)`.
  - Do NOT touch `buildInvokeLaunch` (carries no model; never gains `route`/`env`) and do NOT change arg construction (FR-009, Q4=A — `--model`/`--effort` verbatim).
  - Depends on T002 (`applyRoute` must exist).

- [X] T004 [US1] Add public exports to `packages/generacy-plugin-claude-code/src/index.ts`:
  - `export { resolveRoute, GatewayRouteUnavailableError, DEFAULT_GATEWAY_CONFIG_DIR, _resetGatewayProvisionCacheForTests } from './launch/route.js';`
  - `export type { Route } from './launch/route.js';`
  - `export type { ClaudeCodeLaunchPluginOptions } from './launch/claude-code-launch-plugin.js';`
  - Depends on T001, T002.

## Phase 3: Tests

- [X] T005 [P] [US1] [US2] [US3] Create `packages/generacy-plugin-claude-code/tests/unit/route.test.ts`:
  - SC-001 table for `resolveRoute`: `claude-opus-4-7`, `opus`, `sonnet`, `claude-sonnet-4-5[1m]`, `''`, `undefined` → `'subscription'`; `openai/gpt-5.5`, `openrouter/qwen/qwen3.5-coder` → `'gateway'`.
  - `resolveGatewayConfigDir` precedence: explicit option > `GENERACY_CLAUDE_GATEWAY_CONFIG_DIR` (stub via `vi.stubEnv`) > default; empty-string explicit still wins over env (nullish).
  - Cache semantics (Q3=A) against a real `mkdtemp` dir: missing `settings.json` → throws; create it → next call passes (negative never cached); delete after a positive → still passes (positive cached); distinct dirs keyed independently.
  - `GatewayRouteUnavailableError`: `instanceof Error` + `instanceof GatewayRouteUnavailableError`, `name`, `.model`/`.gatewayConfigDir` populated, message contains model + dir + `GENERACY_LLM_GATEWAY_URL` (SC-003).
  - Call `_resetGatewayProvisionCacheForTests()` in `beforeEach`.

- [X] T006 [US1] [US2] [US3] Extend `packages/generacy-plugin-claude-code/tests/unit/claude-code-launch-plugin.test.ts` (per-builder matrix over all six model-bearing builders; reset provision cache in `beforeEach`):
  - Gateway model (dir provisioned via temp dir passed as explicit ctor option) → `env.CLAUDE_CONFIG_DIR === dir` and `route === 'gateway'`; args identical to the subscription spec modulo the model string (SC-002, FR-009).
  - Subscription model AND `undefined` model → `expect(spec).toEqual(preChangeSpec)` strictly, plus `expect(spec).not.toHaveProperty('env')` and `not.toHaveProperty('route')` (SC-002/SC-004, US2 byte-identity).
  - Gateway model + unprovisioned dir → `toThrow(GatewayRouteUnavailableError)` (US3, SC-003).
  - `buildInvokeLaunch` never gains `route` or gateway `env`.
  - Depends on T003, T004.

## Phase 4: Changeset & verification

- [X] T007 [P] [US1] Create `.changeset/1198-gateway-route-resolution.md` — `@generacy-ai/generacy-plugin-claude-code` **minor** bump (new public capability: `resolveRoute`, `GatewayRouteUnavailableError`, `ClaudeCodeLaunchPluginOptions`, gateway env injection). MUST be a newly-added file in the PR diff (CI gate, CLAUDE.md).

- [X] T008 [US1] [US2] Run `pnpm -r build` then the full test suite (SC-005). Confirm the new `route.ts`/plugin changes build, `route.test.ts` + `claude-code-launch-plugin.test.ts` pass, and existing orchestrator tests that construct `new ClaudeCodeLaunchPlugin()` (incl. `claude-code-launch-plugin-integration.test.ts` at the registration seam) compile and pass unchanged. Depends on T001–T007.

## Dependencies & Execution Order

- **T001** (route module) has no dependencies — start here.
- **T002 → T003 → T004** are sequential in `claude-code-launch-plugin.ts` / `index.ts` (T002 defines `applyRoute` + ctor; T003 calls it in the six builders; T004 re-exports symbols created in T001/T002).
- **T005 [P]** can be written in parallel with the Phase 2 wiring — it targets only `route.ts` (T001).
- **T006** depends on the plugin wiring (T003) and exports (T004).
- **T007 [P]** (changeset) is independent of all code tasks.
- **T008** is the final gate; depends on everything.

**Parallel opportunities**: T005 and T007 can run concurrently with the Phase 2 wiring tasks once T001 lands. All other tasks are sequential due to shared-file edits (`claude-code-launch-plugin.ts`, `index.ts`).

**No playbook coupling**: this feature edits only `packages/generacy-plugin-claude-code/`; no `packages/claude-plugin-cockpit/commands/*.md` files are touched, so no `playbook-verification.test.ts` re-pin task is required.
