# Clarifications: Migrate SubprocessAgency to AgentLauncher

## Batch 1 — 2026-04-12

### Q1: Stdio Profile Mismatch
**Context**: `SubprocessAgency` requires `['pipe', 'pipe', 'pipe']` for stdin writing (e.g., `this.process.stdin.write()`). However, `GenericSubprocessPlugin` hardcodes `stdioProfile: 'default'`, and the `defaultProcessFactory` uses `['ignore', 'pipe', 'pipe']` — meaning stdin would be unavailable after migration. This would break `SubprocessAgency.connect()`.
**Question**: How should the stdio profile mismatch be resolved? Should we add a new `'pipe-all'` profile to ProcessFactory, modify GenericSubprocessPlugin to accept a configurable profile, or change the default profile to use pipe for stdin?
**Options**:
- A: Add a new `'pipe-all'` stdio profile to ProcessFactory and allow GenericSubprocessPlugin to select it via intent
- B: Change GenericSubprocessPlugin to accept `stdioProfile` as part of the intent so callers can choose
- C: Change the `default` ProcessFactory profile to `['pipe', 'pipe', 'pipe']`

**Answer**: *Pending*

### Q2: Error Handling Semantics Change
**Context**: Currently `SubprocessAgency` listens for `process.on('error', ...)` and rejects the connect promise with the error. After migration, `ChildProcessHandle` does not expose error events — `ProcessFactory` swallows errors by resolving `exitPromise` with code 1. This means spawn failures (e.g., command not found) would no longer reject the connect promise; instead, the connect timeout would fire.
**Question**: Is it acceptable that process spawn errors (e.g., ENOENT) will surface as a timeout rather than an immediate error rejection? Or should ProcessFactory/ChildProcessHandle be extended to propagate spawn errors?
**Options**:
- A: Accept the changed error semantics — spawn errors will trigger connect timeout instead of immediate rejection
- B: Extend ChildProcessHandle to expose an error event or reject exitPromise on spawn errors (requires ProcessFactory changes)

**Answer**: *Pending*

### Q3: Environment Variable Merge Parity
**Context**: The spec says to pass env only at the `LaunchRequest` level to avoid double-merging. AgentLauncher performs a 3-layer merge: `process.env < plugin env < caller env`. The `GenericSubprocessIntent` also has an optional `env` field that flows into the plugin layer. To achieve byte-identical env with the current `{ ...process.env, ...this.env }` merge, the intent's `env` must be left undefined and `this.env` must be passed as `request.env`.
**Question**: Can you confirm that the correct approach is: set `intent.env = undefined` and `request.env = this.env`, relying on AgentLauncher's 3-layer merge to produce `{ ...process.env, ...this.env }`? Or is there a different env merge pattern intended?
**Options**:
- A: Confirm: intent.env = undefined, request.env = this.env (3-layer merge collapses to 2-layer)
- B: Different approach — specify the intended pattern

**Answer**: *Pending*

### Q4: Fallback Behavior Scope
**Context**: The spec requires a backwards-compatible fallback to direct `spawn()` when no `AgentLauncher` is provided. However, it doesn't specify what happens if the launcher is provided but `launch()` throws (e.g., plugin not registered, invalid intent).
**Question**: Should the fallback to direct `spawn()` only trigger when `agentLauncher` is undefined/not provided, or should it also catch launcher errors and fall back gracefully?
**Options**:
- A: Fallback only when agentLauncher is undefined — if launch() throws, let the error propagate
- B: Try launcher first, fall back to direct spawn() on any launcher error (defensive)

**Answer**: *Pending*

### Q5: Exit Signal Information Loss
**Context**: The current `ChildProcess.on('exit', ...)` callback receives both `code` and `signal` (e.g., SIGTERM, SIGKILL). After migration, `ChildProcessHandle.exitPromise` only resolves to `number | null`, losing the signal information. SubprocessAgency currently logs exit events but doesn't branch on the signal value.
**Question**: Is losing the exit signal information acceptable for this migration, or should `ChildProcessHandle.exitPromise` be extended to include signal info?
**Options**:
- A: Acceptable — exit signal info is not used for logic, loss is fine
- B: Extend ChildProcessHandle.exitPromise to resolve with { code, signal } (requires type change)

**Answer**: *Pending*
