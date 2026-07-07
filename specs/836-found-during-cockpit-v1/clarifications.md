# Clarifications — #836 `cockpit watch` must survive its own poll interval

## Batch 1 — 2026-07-07

### Q1: Regression Test Approach
**Context**: FR-004 requires "a test that runs the real un-aborted loop and asserts ≥ 2 poll ticks," and adds "Uses `deps.onTick` counter or process-alive check. Must not depend on `deps.abortSignal` to keep the process alive." US2's acceptance criterion says "the real `runWatch` loop **or** the compiled CLI binary." All existing `watch.test.ts` cases inject `abortSignal` for deterministic termination — which is exactly the pattern the bug hides behind. There are two viable test strategies, and the choice materially affects test complexity, CI runtime, and what class of regression is caught:

- **In-process**: call `runWatch()` directly, use `intervalOverride: 200`, count `onTick` invocations. To stop the loop after N ticks without violating the "must not depend on `abortSignal`" note, either (a) fire an `AbortController` **only for teardown after** the assertion passes (treats abortSignal as a stopper, not a keep-alive), or (b) use `process.emit('SIGTERM')` to hit the real signal path.
- **Subprocess**: `child_process.spawn` the compiled CLI binary, tail stderr for ≥ 2 startup/poll lines with a real (short) `--interval`, then `child.kill('SIGTERM')`. Catches CLI-wiring regressions (e.g., `action` handler exiting early) that the in-process path can't see.

**Question**: How should the FR-004 regression test be implemented?

**Options**:
- A: In-process only — call `runWatch()` with `intervalOverride: 200` and no injected `abortSignal`; count `onTick`s and fire an abort **after** the 2nd tick purely to terminate the test (accepts that abortSignal is used for stopping, not aliveness). Simplest, fast, deterministic.
- B: In-process only — same as A but stop via `process.emit('SIGTERM')` inside the `onTick` callback to exercise the real signal path (no `abortSignal` injection at all).
- C: Subprocess only — `child_process.spawn` the compiled `generacy` CLI with `--interval` (below floor triggers clamp; may need small override), tail stderr for evidence of ≥ 2 polls, kill via SIGTERM. Slower but tests the exact prod path.
- D: Both — one in-process test (A or B) covering `runWatch` semantics + one subprocess test (C) covering CLI wiring.

**Answer**: *Pending*

---

### Q2: FR-002 Defensive `unref` Opt-In Flag
**Context**: FR-002 (P2) says "If a non-CLI embedder ever needs an unref'd timer, that behavior must be gated behind an explicit `WatchDeps` flag that the CLI entry point does not set" — and notes "no current embedder is known. Default = referenced timer." This is genuinely ambiguous: it could mean "add the flag now, defensively, so the door stays open" **or** "leave it out until an embedder actually needs it (YAGNI); the requirement only kicks in when someone re-introduces `unref`." The choice affects PR diff size, test surface, and the public shape of `WatchDeps`.

**Question**: Should this PR proactively add the opt-in `unref` flag to `WatchDeps`, or defer until a real embedder needs it?

**Options**:
- A: Proactive — add `WatchDeps.unrefTimer?: boolean` (default `false`), thread it into `sleep()`, add one test that asserts `unrefTimer: true` yields an unref'd timer. CLI never sets it. Establishes the opt-in contract now.
- B: Defer — remove `timer.unref?.()` entirely with no flag. If a future embedder needs unref behavior, they add the flag then (following FR-002 at that point). Smaller diff, YAGNI.

**Answer**: *Pending*
