# Clarifications — Phase 5: Consolidate root-level claude-code-invoker

## Batch 1 — 2026-04-12

### Q1: InvocationConfig.command → LaunchIntent mapping
**Context**: `InvocationConfig.command` is a raw string (e.g., `/speckit:specify`), but `ClaudeCodeLaunchPlugin` only handles discriminated intent kinds: `'phase'`, `'pr-feedback'`, `'conversation-turn'`. None of these accept an arbitrary command string. The adapter needs to translate `command` into a concrete `LaunchIntent`, but the mapping strategy is unspecified.
**Question**: How should the adapter map `InvocationConfig.command` to a `LaunchIntent`? Should a new intent kind (e.g., `'generic-command'`) be added to `ClaudeCodeLaunchPlugin`, or should the adapter parse the command string to determine the existing intent kind (e.g., extracting `'specify'` from `/speckit:specify` → `PhaseIntent`)?
**Options**:
- A: Add a new `GenericCommandIntent` kind to the plugin that accepts a raw command string
- B: Parse `InvocationConfig.command` in the adapter to determine the matching existing intent kind (phase, pr-feedback, conversation-turn)
- C: Other approach (please specify)

**Answer**: A — Add a new intent kind to `ClaudeCodeLaunchPlugin`: `{ kind: "invoke", command: string, streaming?: boolean }`. The root-level invoker uses different flags (`--print`, `--dangerously-skip-permissions`) than the orchestrator's phase loop, so existing intent kinds can't cover it. The adapter maps `InvocationConfig.command` directly to `intent.command` — no parsing, no guessing. `ClaudeCodeLaunchPlugin.buildLaunch()` for this intent produces `{ command: "claude", args: ["--print", "--dangerously-skip-permissions", intent.command] }`. This is a pure additive union member per the pattern established in #425 Q3 answer C.

### Q2: ProcessFactory construction in root worker
**Context**: `AgentLauncher` requires a `Map<string, ProcessFactory>` at construction. The root worker (`src/worker/main.ts`) currently has no `ProcessFactory` setup. Additionally, `@generacy-ai/orchestrator` is not listed as a dependency in the root `package.json`.
**Question**: How should the root worker obtain/construct `ProcessFactory` instances for the `AgentLauncher`? Should it import from `@generacy-ai/orchestrator` (adding a new package dependency), use a convenience factory like `createAgentLauncher()`, or set up `ProcessFactory` differently?

**Answer**: Add `@generacy-ai/orchestrator` as a workspace dependency (`"@generacy-ai/orchestrator": "workspace:*"`) to the root `package.json`. Import the shared `createAgentLauncher()` setup function (established in #433 Q2 answer C) to get a fully configured `AgentLauncher` with the correct `ProcessFactory` map and plugin registrations. Setup in `main.ts` becomes: `const agentLauncher = createAgentLauncher(config); const claudeCode = new ClaudeCodeInvoker(agentLauncher); registry.register(claudeCode);`

### Q3: parseToolCalls logic fate
**Context**: The current `ClaudeCodeInvoker` has `parseToolCalls()` logic that parses `---TOOL_CALLS---` markers from stdout. The plugin's `createOutputParser()` returns a no-op parser with no equivalent logic. Tests currently assert on `toolCalls` array parsing. The spec says spawn-argv assertions move to plugin tests but doesn't address `parseToolCalls`.
**Question**: Should the `parseToolCalls` logic be dropped entirely (dead code), moved into the adapter, or moved into the plugin? Is the `---TOOL_CALLS---` marker format still used by any caller?
**Options**:
- A: Drop entirely — this is dead/legacy logic no longer used
- B: Keep in the adapter layer — the adapter parses stdout after the launch completes
- C: Move into the plugin's `OutputParser`

**Answer**: B — Keep `parseToolCalls` in the adapter layer. `InvocationResult.toolCalls` is part of the `AgentInvoker` contract and `AgentHandler` reads it for job metadata. The adapter collects stdout into a string, then calls `parseToolCalls()` on the result before building `InvocationResult`. This keeps the plugin clean (no knowledge of `---TOOL_CALLS---` markers) and preserves existing behavior. If markers are confirmed dead later, removal is a 1-line change.

### Q4: isAvailable() and initialize() post-migration
**Context**: Currently `isAvailable()` spawns `claude --version` directly via `child_process`. After migration, the adapter delegates to `AgentLauncher`, which has no "check availability" API. The `AgentInvoker` interface is unchanged, so these methods must still work.
**Question**: How should `isAvailable()` and `initialize()` be implemented in the adapter? Should they continue to spawn `claude --version` directly (keeping a minimal `child_process` dependency for health checks only), or delegate to a new launcher capability, or use a different approach?
**Options**:
- A: Keep direct `child_process.spawn('claude', ['--version'])` for health checks only — this is a diagnostic path, not a spawn path
- B: Add an availability check API to `AgentLauncher` and delegate
- C: Simplify to always return true / no-op (assume Claude is available if the plugin is registered)

**Answer**: Route `isAvailable()` through `AgentLauncher` using a `generic-subprocess` intent: `this.agentLauncher.launch({ pluginId: "generic-subprocess", intent: { kind: "generic-subprocess", command: "claude", args: ["--version"] }, ... })`. This satisfies the "no child_process in src/agents/" constraint, routes through the launcher (inherits uid/gid from credentials plan later), and preserves health-check semantics. `initialize()` continues to call `isAvailable()` and throw if false — no change.

### Q5: LaunchHandle → InvocationResult conversion contract
**Context**: `agentLauncher.launch()` returns a synchronous `LaunchHandle` containing `{ process: ChildProcessHandle, outputParser, metadata }`. The adapter must convert this to a `Promise<InvocationResult>` (with `success`, `output`, `exitCode`, `error`, `toolCalls`, `duration`). This includes stdout/stderr collection, exit code handling, timeout/kill behavior, and error wrapping. The spec says "invoke() translates to a LaunchRequest and calls agentLauncher.launch()" but doesn't describe this conversion.
**Question**: Should the adapter implement its own stdout/stderr collection and timeout logic on top of `LaunchHandle`, or is there an existing utility (e.g., in the orchestrator package) that converts a `LaunchHandle` into a result? What timeout behavior should the adapter use — the current `setTimeout` + `SIGTERM` approach, or `AbortSignal` via `LaunchRequest.signal`?
**Options**:
- A: Adapter implements its own stream collection + timeout logic (using `AbortSignal` for timeout)
- B: Adapter implements its own stream collection + timeout logic (using `setTimeout` + `kill()` as today)
- C: Use an existing orchestrator utility if one exists

**Answer**: B — Adapter implements own stream collection + timeout using `setTimeout` + `kill()` as today. The adapter replicates the current timeout pattern on `LaunchHandle.process`: collect stdout/stderr via data events, `setTimeout(() => { killed = true; handle.process.kill("SIGTERM"); }, config.timeout)`, await `handle.process.exitPromise`, then build `InvocationResult` with `parseToolCalls(stdout)`, duration, and error handling. This is the minimal-change approach — same semantics, no `AbortSignal` introduction. The adapter fully owns the `LaunchHandle` → `InvocationResult` lifecycle.
