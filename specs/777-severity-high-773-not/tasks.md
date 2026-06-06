# Tasks: JIT gh token provider works without `github-app` descriptor (#777)

**Input**: Design documents from `/specs/777-severity-high-773-not/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/jit-github-token-provider.ts.md, contracts/gh-cli-env-override.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to. This spec is a single bug fix (US1: "wizard-bootstrapped clusters keep `gh` working past the 1h ambient-token expiry").

---

## Phase 1: Core provider changes

- [X] **T001** [US1] Modify `packages/orchestrator/src/services/jit-github-token-provider.ts`:
  - Export new constant `WIZARD_SENTINEL_KEY = '__wizard__'` (top-level).
  - Widen `JitGithubTokenProviderOptions.credentialId` from `string` to `string | undefined` (`credentialId?: string`).
  - In `createJitGithubTokenProvider`, derive `const effectiveKey = credentialId ?? WIZARD_SENTINEL_KEY` once.
  - Replace every `cache.get(credentialId)` / `cache.set(credentialId, …)` / `cache.delete(credentialId)` with `effectiveKey`.
  - Replace `authHealth?.recordResult(credentialId, …)` with `authHealth?.recordResult(effectiveKey, …)`.
  - Replace the warn-log payload field `credentialId` with `credentialId: effectiveKey`.
  - Leave `client.fetch(credentialId)` call **unchanged** — pass the original (possibly `undefined`) value so the existing `'{}'` branch in `JitGitTokenClient.fetch` is preserved.
  - Reference: contracts/jit-github-token-provider.ts.md, data-model.md "Constants" + "Modified types".

- [X] **T002** [P] [US1] Create `packages/orchestrator/src/services/cluster-api-key-probe.ts` (~15 LOC):
  - Export `const DEFAULT_KEY_PATH = '/var/lib/generacy/cluster-api-key'` (must match `packages/control-plane/src/services/cluster-api-key.ts:4`).
  - Export `clusterApiKeyExists(keyPath?: string): boolean` that returns `fs.existsSync(keyPath ?? process.env.CLUSTER_API_KEY_PATH ?? DEFAULT_KEY_PATH)`.
  - Pure `node:fs` wrapper. Does NOT read the file's contents.
  - JSDoc explaining the test override env var and that it is intentionally separate from the control-plane's async `ClusterApiKeyReader`.
  - Reference: data-model.md "New types".

- [X] **T003** [P] [US1] Tighten `resolveTokenEnv` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts:67-71`:
  - Change body from `return token ? { GH_TOKEN: token } : undefined;` to `return { GH_TOKEN: token ?? '' };` (only when `this.tokenProvider` is set).
  - Preserve the early `if (!this.tokenProvider) return undefined;` branch verbatim — legacy callers without a provider keep ambient inheritance.
  - Add JSDoc above the method capturing the invariant: "provider present ⇒ `GH_TOKEN` always set, never `undefined`". Reference contract document.
  - Reference: contracts/gh-cli-env-override.md.

---

## Phase 2: Wiring (depends on Phase 1)

- [X] **T004** [US1] Update provider-construction gate in `packages/orchestrator/src/server.ts:201-224`. **Depends on T001, T002.**
  - Import `clusterApiKeyExists` from `./services/cluster-api-key-probe.js` (alongside existing `createJitGithubTokenProvider` import).
  - Replace the gating condition `githubAppCredentialId ? createJitGithubTokenProvider({…}) : undefined` with: build the provider when `clusterApiKeyExists()` returns `true`, pass `credentialId: githubAppCredentialId` (may be `undefined`), keep the other options identical. When `clusterApiKeyExists()` is `false`, leave the provider `undefined` (legacy fallback for truly-unconfigured clusters).
  - Update the leading comment block (lines 211-216) to describe the new gate and the credential-less branch.
  - Do NOT touch the downstream references to `githubAppCredentialId` at lines 358 / 386 — they pass through to other services unchanged.
  - Reference: research.md D1, plan.md "Project Structure".

- [X] **T005** [P] [US1] Add `JitTokenError` catch branches at loop-boundary call sites so a JIT-fetch failure logs and skips the cycle (never silently spawns `gh` with the ambient token). Mirror the existing `GhAuthError` catch pattern from #762. Touched files:
  - `packages/orchestrator/src/services/label-monitor-service.ts` — `pollRepo` catch chain: add a `catch (err) { if (err instanceof JitTokenError) { log.warn({ code: err.code, repo }, 'JIT token fetch failed — skipping label monitor cycle'); return; } throw err; }` branch *before* the existing `GhAuthError` branch (or fold into the same chain).
  - `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` — same treatment in `pollRepo`.
  - `packages/orchestrator/src/services/webhook-setup-service.ts` — wrap the `executeCommand('gh', …)` paths (and any `GhCliGitHubClient` calls) in a per-call try/catch that logs and continues on `JitTokenError`. Webhook setup is best-effort, so a per-repo throw should not abort the whole setup pass.
  - `packages/orchestrator/src/worker/claude-cli-worker.ts` — sibling-fan-out call site (`gh pr ready` loop near `markReadyForReview` / `linkedPRs` handling): ensure the surrounding try/catch logs `JitTokenError` and continues with the next sibling.
  - Imports: add `import { JitTokenError } from '@generacy-ai/control-plane';` to each modified file that doesn't already import it.
  - Reference: contracts/gh-cli-env-override.md "Caller obligations".

---

## Phase 3: Tests (parallel with Phase 2)

- [X] **T006** [P] [US1] Unit tests for `packages/orchestrator/__tests__/services/jit-github-token-provider.test.ts` (extend existing file; reuse the existing fake `JitGitTokenClient`). Add cases:
  - `creates provider when credentialId omitted` — `createJitGithubTokenProvider({ client, logger })` returns a function.
  - `uses WIZARD_SENTINEL_KEY as cache key when credentialId omitted` — first call fetches, second call within `refreshWindowMs` returns the cached token without re-calling the client (verifies the cache write/read keys are consistent under the sentinel).
  - `calls client.fetch() with no argument when credentialId omitted` — spy on `client.fetch`; first arg is `undefined`.
  - `records authHealth under WIZARD_SENTINEL_KEY on failure` — fake `AuthHealthSink` spy; first arg of `recordResult` is `'__wizard__'`.
  - `propagates JitTokenError unchanged in credential-less path` — assert `err.code`, `err.message` preserved.
  - `passes credentialId to client.fetch when defined` — regression for descriptor path (`credentialId: 'foo'` → `client.fetch('foo')`).
  - `uses descriptor credentialId as cache key when defined` — sentinel not used; authHealth recorded under `'foo'`.
  - Import `WIZARD_SENTINEL_KEY` from the module under test for explicit assertions (do not duplicate the literal in tests).
  - Reference: contracts/jit-github-token-provider.ts.md "Tests".

- [X] **T007** [P] [US1] Unit tests for `packages/workflow-engine/__tests__/actions/github/client/gh-cli.test.ts` (extend existing file). Add cases:
  - `resolveTokenEnv returns { GH_TOKEN } when provider returns a token` — env value matches provider output.
  - `resolveTokenEnv returns { GH_TOKEN: '' } when provider returns empty string` — explicit empty string in env, NOT `undefined`.
  - `resolveTokenEnv returns undefined when no provider configured` — legacy behavior preserved.
  - `executeGh propagates JitTokenError when provider throws` — mock `executeCommand` (or the equivalent existing shim); assert it is NOT called and the error rethrown unchanged.
  - Reference: contracts/gh-cli-env-override.md "Tests".

- [X] **T008** [P] [US1] Unit tests for `packages/orchestrator/__tests__/services/cluster-api-key-probe.test.ts` (new file):
  - `returns true when key file exists at default path` — use `vi.mock('node:fs')` or a temp dir + env-var override.
  - `returns false when key file missing at default path`.
  - `honors explicit keyPath argument over env var and default`.
  - `honors CLUSTER_API_KEY_PATH env var when no explicit keyPath given`.
  - Reference: data-model.md "New types".

- [X] **T009** [P] [US1] Integration-style test (or regression test in `packages/orchestrator/__tests__/server.test.ts` if one exists, otherwise extend `jit-github-token-provider.test.ts` with a small `server.ts` wiring shim test) covering the three gating outcomes:
  - **Descriptor present + api-key present**: provider constructed, `credentialId` is the descriptor's id, sentinel NOT used.
  - **No descriptor + api-key present**: provider constructed, `credentialId` is `undefined`, sentinel used internally (verified via cache + authHealth keying).
  - **No api-key**: provider is `undefined` (legacy fallback).
  - If no `server.test.ts` exists, isolate via direct calls to `createJitGithubTokenProvider` + `clusterApiKeyExists` rather than booting Fastify.
  - Reference: spec.md "Acceptance criteria" bullets 1, 4, 5.

---

## Phase 4: Manual verification (depends on Phases 1-3)

- [ ] **T010** [US1] Run quickstart.md verification on a wizard-bootstrapped cluster:
  - V1: `gh api repos/<org>/<repo>` succeeds from inside the orchestrator container after the wizard `GH_TOKEN` has been force-expired.
  - V2: orchestrator logs show `credentialId: '__wizard__'` on the first JIT fetch line; `.agency/credentials.yaml` confirmed to have no `type: github-app` entry.
  - V3: spawn-env trace (or debug-build log) confirms the `GH_TOKEN` env passed to the `gh` subprocess is the fresh JIT token, not the value in `/var/lib/generacy/wizard-credentials.env`.
  - V4: with control-plane stopped, the next poll cycle emits a `JIT GitHub token refresh failed` warn line and a caller-side skip; no `Bad credentials` / HTTP 401 in the same cycle.
  - V5: long-run check — leave the cluster running ≥ 4 hours; `docker compose logs --since 4h orchestrator | grep -i 'Bad credentials\|HTTP 401'` is empty.
  - V6: descriptor-present regression — add a synthetic `github-app` descriptor; first JIT fetch log shows the real `credentialId`, NOT `'__wizard__'`; `gh` still works.
  - Reference: quickstart.md.

---

## Dependencies & Execution Order

**Within Phase 1**:
- T001 (provider edits) and T002 (api-key probe) touch different files and are independent → can run in parallel.
- T003 (gh-cli env override) is in a different package (workflow-engine) and depends on nothing → parallel with T001/T002.

**Phase 2 (T004, T005)**:
- T004 (server.ts wiring) imports both `WIZARD_SENTINEL_KEY` indirect dependencies and `clusterApiKeyExists` — **blocks on T001 + T002**.
- T005 (caller catch branches) imports `JitTokenError` (already exported from control-plane today) — does NOT depend on T001-T004 builds and can start as soon as T001 lands (so the provider's failure path is wired into a catch chain at the same time). Practically: run after T001 finishes (small) or in parallel with T003-T004.

**Phase 3 (tests, T006-T009)**:
- T006 blocked on T001.
- T007 blocked on T003.
- T008 blocked on T002.
- T009 blocked on T001 + T002 + T004.
- All four are in different files → parallel once their prerequisite implementation tasks finish.

**Phase 4 (T010)**:
- Blocked on all of Phases 1-3 landing (and a clean orchestrator build deployed to a wizard-bootstrapped cluster).

### Parallel execution graph

```
T001 ──┬─► T004 ──┬─► T009 ──┐
       │          │          │
T002 ──┘          │          │
                  │          │
T003 ────────► T007 ─────────┤──► T010
                             │
T001 ────────► T006 ─────────┤
                             │
T002 ────────► T008 ─────────┤
                             │
T001 ────────► T005 ─────────┘
```

Round 1 (parallel): **T001, T002, T003**.
Round 2 (parallel, after T001/T002): **T004, T005, T006, T007, T008**.
Round 3 (parallel, after T004): **T009**.
Round 4 (manual): **T010**.

---

## Notes

- **Single user story (US1)** — this is a high-severity bug fix, not a multi-story feature. Every task carries the `[US1]` tag for consistency with the format.
- **No setup phase** — all packages, build tooling, and test infra already exist.
- **No data model migration / no config migration** — the change is purely behavioral. Rollback is `git revert` of the implementation commits.
- **`/speckit:implement` next** to begin execution.

---

*Generated by speckit*
