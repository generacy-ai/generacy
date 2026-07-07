# Clarifications

## Batch 1 — 2026-07-07

### Q1: Shared helper contract
**Context**: FR-002 requires a single shared implementation of the "post-activation branch decision (retry vs. resume)" called from both startup branches. Two viable shapes: (a) the helper *owns* the branch — it takes `checkPostActivationState()` output plus the two services (or their factories) and internally decides retry vs. resume, so each branch is a one-liner call site; (b) the helper *returns state only* (or a discriminated-union verdict) and each branch does its own `if/else`. Shape (a) makes drift impossible by construction (the whole thing you must not forget is inside the helper); shape (b) keeps side-effect wiring visible at each call site but re-introduces exactly the copy-paste that shipped #824 broken. The choice also drives where `BootResumeService` and `PostActivationRetryService` get constructed.
**Question**: Which shape should the shared helper take?
**Options**:
- A: Helper owns the decision — accepts `sendRelayEvent` (+ logger) and internally constructs both services and fires retry-or-resume-or-noop. Both call sites become a single `await runPostActivationBranch(...)` line. (Recommended — matches FR-002's "cannot ship a fix into one path while leaving the other silently broken.")
- B: Helper returns state/verdict only; each branch constructs services and dispatches. Preserves side-effect visibility at call sites.

**Answer**: *Pending*

### Q2: Helper location
**Context**: Spec's Out-of-Scope allows "a new shared helper" alongside `server.ts` changes but doesn't say where it lives. Options: keep it as a nested `async function` inside `server.ts` (zero new files, one import surface), or extract to a new module (e.g. `packages/orchestrator/src/services/post-activation-dispatch.ts`) so it can be unit-tested directly without booting Fastify. Q4's answer partly depends on this (a nested function can only be exercised via `createServer()`; a module export can be imported and unit-tested standalone).
**Question**: Where should the shared helper live?
**Options**:
- A: New file under `packages/orchestrator/src/services/` (e.g. `post-activation-dispatch.ts`), exported and imported by `server.ts`. Enables direct unit test of the helper without booting the server. (Recommended.)
- B: Nested function inside `server.ts`. Zero new files; helper is only reachable through `createServer()`.

**Answer**: *Pending*

### Q3: Regression test approach for FR-005
**Context**: FR-005 requires a test that "drives the `activateInBackground` startup path with `activated && postActivationComplete` state and asserts `BootResumeService.triggerBootResume()` (or the two `/lifecycle/*-start` POSTs) fires." Two levels of coverage: (a) a unit-level test on the shared helper (module import) that stubs `checkPostActivationState()` and asserts the resume path is taken — cheap, fast, and directly proves the helper's branch decision; (b) an integration test that calls `createServer()` with a config that has empty `config.relay.apiKey` (forcing the `activateInBackground` branch), stubs the activation-client and control-plane socket, and asserts a spy on `BootResumeService.triggerBootResume` fires. Option (b) is a truer regression guard for the wiring bug (SC-003: "delete/comment the boot-resume invocation on the `activateInBackground` side; test must fail"). Option (a) only fails if the helper itself regresses, not if `activateInBackground` stops calling the helper.
**Question**: Which test level does FR-005 need?
**Options**:
- A: Integration test on `createServer()` driving the `activateInBackground` branch. Directly satisfies SC-003 (deleting the boot-resume call from `activateInBackground` makes the test fail). (Recommended — the whole point of FR-005 is closing the wiring-gap coverage that #824 missed.)
- B: Unit test on the shared helper only. Cheaper; sufficient if paired with a static-inspection assertion that both branches import the helper.
- C: Both A and B.

**Answer**: *Pending*
