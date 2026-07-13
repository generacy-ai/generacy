# Research: Wire boot-resume into the wizard startup path (#834)

**Feature**: `834-summary-824-fix-auto` | **Date**: 2026-07-07

This feature is the corrective wiring for #824 (PR #832, commit `b3bad08`). The design space is small — the underlying services (`PostActivationRetryService`, `BootResumeService`) are correct and unchanged — but the *shape* of the fix determines whether the regression stays fixed. Three decisions locked by clarifications.

## Decision 1 — Shape of the shared helper (Q1)

**Decision**: **A — helper owns the decision.** New module `packages/orchestrator/src/services/post-activation-dispatch.ts` exports `runPostActivationBranch({ logger, sendRelayEvent })`. Internally it constructs `PostActivationRetryService`, calls `checkPostActivationState()`, and dispatches to retry / resume / noop. Both `server.ts` branches collapse to a single call.

**Rationale**:
- The entire defect in #824 is that the retry-vs-resume decision was duplicated across the two branches, and one copy silently dropped the resume half. **Shape B (helper returns state; each branch does its own `if/else`)** recreates that copy-paste surface. Shape A makes drift impossible by construction: there is one and only one place the retry/resume/noop decision lives, and both branches use it.
- The signature is identical for both call sites. Both branches already build `sendRelayEvent` to the same nullable-function shape (env-key uses `relayClientRef`; wizard uses `localRelayClient`). Neither the caller nor the helper needs to know which relay-client variable underlies it.
- The `.catch(logger)` fire-and-forget shape of both `triggerPostActivationRetry()` and `triggerBootResume()` is preserved inside the helper. No change to server-startup blocking semantics.
- Test hooks (`retryServiceFactory` / `resumeServiceFactory`) are optional constructor options — prod code passes none; the unit test injects fakes. This keeps the prod surface tiny and moves complexity into test-only paths.

**Alternatives considered**:
- **Shape B — helper returns state/verdict only; each branch dispatches** (Q1→B). Rejected: this is exactly the code-copy that shipped #824 broken. The `#824` fix would still have to be applied identically at both call sites, and a future contributor can regress it by touching only one. The only argument for B was "side-effect visibility at call sites" — but the side effects are already `.catch()`-suppressed fire-and-forgets, so the visibility win is illusory.

**References**: clarifications.md Q1 → A. Sibling `services/` layout: `post-activation-retry.ts:28-45` (retry service constructor), `boot-resume-service.ts:17-28` (resume service constructor). Env-key branch that #824 wired correctly: `packages/orchestrator/src/server.ts:470-503`. Wizard branch missing the resume half: `packages/orchestrator/src/server.ts:879-896`.

---

## Decision 2 — Helper location (Q2)

**Decision**: **A — new module under `packages/orchestrator/src/services/`.** File: `post-activation-dispatch.ts`. Exports `runPostActivationBranch`.

**Rationale**:
- Consistent with the existing pattern: `PostActivationRetryService` (`services/post-activation-retry.ts`) and `BootResumeService` (`services/boot-resume-service.ts`) already live here. The dispatcher is a natural sibling — it composes both.
- Unit-testable by import. The optional Q3→C helper test (see Decision 3) exists precisely because the helper can be imported and driven without booting Fastify. A nested `async function` inside `server.ts` cannot be exercised without `createServer()`, so the retry / resume / noop matrix could only be covered via the (slower, higher-friction) integration test.
- Zero cost. A new file adds no complexity relative to a nested function; both are one export.

**Alternatives considered**:
- **Shape B — nested function inside `server.ts`** (Q2→B). Rejected: forecloses the Q3→C complement (helper-level unit test on the full matrix) with no offsetting benefit. `server.ts` is already the largest orchestrator file; adding to it makes it harder to navigate, and callers of the helper elsewhere in the codebase (should any arise in follow-ups) would have to import from `server.ts` rather than from `services/`.

**References**: clarifications.md Q2 → A. Sibling layout: `packages/orchestrator/src/services/{post-activation-retry.ts, boot-resume-service.ts, control-plane-probe.ts, status-reporter.ts}`.

---

## Decision 3 — Regression test level (Q3)

**Decision**: **A load-bearing + C complement (optional).** New integration test at `packages/orchestrator/src/__tests__/server-boot-resume-wizard-branch.test.ts` drives `createServer()` with empty `config.relay.apiKey` (forcing the wizard branch), stubs `activate()` + control-plane socket, stubs `checkPostActivationState()` → `{ activated: true, postActivationComplete: true, needsRetry: false }`, and asserts a spy on `BootResumeService.triggerBootResume` fires. Optional unit test at `packages/orchestrator/src/__tests__/post-activation-dispatch.test.ts` covers the retry / resume / noop matrix by direct import.

**Rationale**:
- The whole reason FR-005 exists is that #824's validation only exercised the env-key branch — the wizard branch was never covered, so the mis-wiring shipped. A unit test on the helper (option B alone) would prove the helper's decision logic works but would **not** fail if `activateInBackground` stopped calling the helper. That is exactly the wiring gap that shipped #824 broken.
- SC-003 concretely requires: **delete the boot-resume dispatch from `activateInBackground`'s call site → integration test must fail**. Only the integration test can enforce this.
- The optional unit test (C complement) is cheap and provides fast feedback on the helper's decision matrix. It is not a substitute for A, but pairs well with it: helper regressions surface as unit-test failures (fast, clear); wiring regressions surface as integration-test failures (slower, but the *only* thing that catches the actual #824-shaped bug).
- Test infrastructure to force the wizard branch is already established. `server-background-activation.test.ts` (T006/T007/T008) uses `vi.mock('../activation/index.js', ...)` + `vi.mock('@generacy-ai/cluster-relay', ...)` + `vi.mock('@generacy-ai/control-plane', ...)` to drive `createServer()` down the `!config.relay.apiKey` branch with `activate()` returning a controllable promise. The new test copies that pattern.

**Alternatives considered**:
- **Shape B alone — helper unit test only** (Q3→B). Rejected: does not fail on the exact regression it exists to prevent. Fast and cheap, but load-bearing coverage must come from A.
- **Shape A alone — integration test only, skip C**. Acceptable minimum; the optional helper unit test is a welcome complement but not required. If C is dropped for velocity reasons, the plan still delivers the FR-005 requirement.

**References**: clarifications.md Q3 → A load-bearing, C optional. Test scaffolding to mirror: `packages/orchestrator/src/__tests__/server-background-activation.test.ts:15-50` (mock pattern) and `:60-82` (wizard-branch drive-through).

---

## Implementation patterns to follow

- **Helper module shape**: single exported async function `runPostActivationBranch(opts)`. Prod path constructs services from the two service classes directly; test path receives `retryServiceFactory` / `resumeServiceFactory` in `opts` (both optional, defaulted). Return a small discriminated-union `DispatchOutcome` (`'retry' | 'resume' | 'noop'`) for observability + testability; nothing in prod code needs to read the return value.
- **Fire-and-forget preservation**: `.triggerPostActivationRetry()` and `.triggerBootResume()` are still `.catch(logger)`-guarded inside the helper. The helper's own `Promise<DispatchOutcome>` resolves *after* dispatching (not after the service completes) — matches today's behavior exactly.
- **`sendRelayEvent` typing**: same as today's inlined callback shape (`(channel: string, payload: unknown) => void`), nullable. Both callers pass identical fn-or-undefined into the helper.
- **`server.ts` env-key call site** (~L470-503 becomes ~5 LOC):
  ```ts
  await runPostActivationBranch({
    logger: server.log,
    sendRelayEvent: relayClientRef ? (channel, payload) => relayClientRef!.send({ ... }) : undefined,
  });
  ```
- **`server.ts` wizard call site inside `activateInBackground()`** (~L879-896 becomes ~5 LOC):
  ```ts
  await runPostActivationBranch({
    logger: server.log,
    sendRelayEvent: localRelayClient ? (channel, payload) => localRelayClient!.send({ ... }) : undefined,
  });
  ```
- **Integration test scaffolding**: import + mock `activate` (from `../activation/index.js`), `@generacy-ai/cluster-relay`, `@generacy-ai/control-plane`. Mock `../services/post-activation-retry.js` at the module boundary so `checkPostActivationState()` returns the target state and both `triggerPostActivationRetry` / (real path via mock) don't fire real HTTP. Spy on `BootResumeService.prototype.triggerBootResume` (or mock `../services/boot-resume-service.js` and spy the constructor + method). Resolve the `activate` mock, then `vi.waitFor(() => expect(bootResumeSpy).toHaveBeenCalledTimes(1))`.
- **Helper unit test scaffolding**: import `runPostActivationBranch` directly; construct fake `PostActivationRetryService` and `BootResumeService` with just the methods the helper touches (`checkPostActivationState`, `triggerPostActivationRetry`, `triggerBootResume`); pass factories into the helper; assert on the fake methods' `mock.calls`.

## Key references

- **Issue**: [#834](https://github.com/generacy-ai/generacy/issues/834)
- **Parent issue (incomplete)**: [#824](https://github.com/generacy-ai/generacy/issues/824), PR [#832](https://github.com/generacy-ai/generacy/pull/832), commit `b3bad08`.
- **Env-key branch (has boot-resume wiring)**: `packages/orchestrator/src/server.ts:447-504`, resume block at L488-503.
- **Wizard branch (missing boot-resume wiring)**: `packages/orchestrator/src/server.ts:433-446` (entry) → `activateInBackground()` at `:799-897`; retry-only block at `:879-896`.
- **Sibling services (unchanged)**: `packages/orchestrator/src/services/post-activation-retry.ts` (retry service, 149 LOC); `packages/orchestrator/src/services/boot-resume-service.ts` (resume service, 118 LOC).
- **Test scaffolding to mirror**: `packages/orchestrator/src/__tests__/server-background-activation.test.ts` — wizard-branch drive-through.
- **Control-plane lifecycle handlers (unchanged)**: `packages/control-plane/src/routes/lifecycle.ts` handles both `code-server-start` and `vscode-tunnel-start`.
