# Research — #836 `cockpit watch` unref bug

This is a bugfix, not a design exercise. Research here documents the two decisions that shaped the plan (both resolved in `clarifications.md`) and the runtime behavior of `Timer.unref()` that made the bug latent.

## Decision Log

### D1: Sleep timer must be referenced

**Decision**: Remove `timer.unref?.()` outright. No flag, no branch.

**Rationale**: `Timer.unref()` tells Node's event loop that this handle should not prevent the process from exiting. When the `while (!stopped)` loop `await`s the sleep, the only remaining referenced handles are process-level signal listeners (`SIGINT`/`SIGTERM`) — those alone do NOT keep the loop alive because they're passive listeners on `process`, not handles registered with the loop as "please stay alive for me." The unref'd timer registers, but its `unref()` withdraws its vote. Result: loop drains, process exits 0.

The abort path (SIGINT → `controller.abort()` → sleep resolves early) is orthogonal to keep-alive and is unaffected by removing the `unref`.

**Alternatives considered**:

- **Add a `WatchDeps.unrefTimer` opt-in flag (default false)**. Rejected per Q2: no embedder needs it today; adding dead surface area contradicts CLAUDE.md's YAGNI directive. A comment at the site satisfies the FR-002 constraint until an embedder shows up.
- **Keep the `unref` and add a `setInterval`-based keep-alive elsewhere**. Rejected: convoluted, hides intent. If the timer between polls is what should keep the loop alive, that timer should be referenced. That is what the loop *means*.
- **Switch to `setInterval` and drop the async-await loop**. Rejected: much larger diff, changes error-handling semantics of `runOnePoll` (currently awaited serially — a slow poll delays the next poll by exactly its own runtime, no overlap), and introduces re-entrancy risk. Out of scope for a bugfix.

**Source**: Node docs on [`Timeout.unref()`](https://nodejs.org/api/timers.html#timeoutunref) — "When called, requests that the Node.js event loop *not* remain active if this is the only active timer."

### D2: Regression test must be subprocess-only

**Decision**: One new subprocess-driven test. No in-process `runWatch` + `onTick` counting variant.

**Rationale (per Q1)**: Under vitest, the test runner's own I/O handles keep the event loop alive independent of the code under test. An unref'd timer inside `runWatch` still fires because the runner is refusing to exit for other reasons. So an in-process test can invoke `runWatch` with `intervalOverride: 200`, count `onTick`s, and PASS against the buggy code. It provides false confidence — exactly the failure mode the existing abort-driven suite already has, and the reason this bug survived to production.

Only a spawned child process — where the watch loop is the sole thing keeping Node alive — reproduces the drain.

**Amendment to FR-004**: The original spec said "assert ≥ 2 poll ticks." At the 15 s interval floor that is a 30+ s test. The property that broke is "process stays alive through the first sleep," which is testable in ~5 s with the same regression power. The subprocess test asserts "still alive 5 s after the startup line, exits 0 on SIGTERM."

**Alternatives considered**:

- **In-process + `abortSignal` for teardown only** (Q1 option A): fails to catch the bug (see rationale).
- **In-process + `process.emit('SIGTERM')` for teardown** (Q1 option B): fails to catch the bug for the same reason.
- **Both in-process and subprocess** (Q1 option D): the in-process half adds runtime, config surface, and no additional signal. Rejected.
- **White-box `hasRef()` assertion**: Q1 flagged as "allowed but not required." Not included — the subprocess test is sufficient and this would coupling the test to `setTimeout`'s internal shape.

**Source**: [Q1 answer in `clarifications.md`](./clarifications.md#q1-regression-test-approach).

## Sibling Prior Art

Same test-mirrors-code failure pattern seen in #800 and #826 (referenced in spec, out of scope here). The general lesson — "tests that inject the test-only escape hatch cannot catch bugs in the production path that lacks the escape hatch" — is the rationale for the subprocess-only test.

## Fixture Choice for the Subprocess Test

The subprocess test needs a real, resolvable epic ref for `resolveEpic` to succeed against `gh api`. Options:

1. **Real public issue in `generacy-ai/generacy`** — pragmatic; picks a closed low-noise issue as a stable canary. Requires `GH_TOKEN` in CI (already available).
2. **Mock `gh` at the subprocess boundary** — infeasible without either a shim binary on PATH or invasive changes to `runWatch` (both larger than the bugfix).
3. **Scope test to CI only** (`describe.skipIf(!process.env.CI)`) — reasonable safety net if a stable public fixture can't be committed.

Recommendation: pick a stable closed issue in this repo and skip locally when `GH_TOKEN` is unset. The task file (produced by `/speckit:tasks` next) will pin the fixture identifier.
