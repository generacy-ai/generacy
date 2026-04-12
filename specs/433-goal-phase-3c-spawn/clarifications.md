# Clarifications: Migrate conversation-spawner to AgentLauncher (PTY wrapper)

**Issue**: #433 | **Branch**: `433-goal-phase-3c-spawn`

---

## Batch 1 — 2026-04-12

### Q1: Constructor Injection Pattern
**Context**: FR-001 says ConversationSpawner "accepts an AgentLauncher instance (injected via constructor or method)" and notes it "replaces direct processFactory usage for spawnTurn()." Currently the constructor is `ConversationSpawner(processFactory, gracePeriodMs)`. The choice here affects the API surface and whether a transitional period with both dependencies is needed.
**Question**: Should `processFactory` be fully replaced by `agentLauncher` in the ConversationSpawner constructor, or should both be accepted (e.g., for a transitional period or because processFactory is used elsewhere in the class)?
**Options**:
- A: Replace entirely — constructor becomes `(agentLauncher, gracePeriodMs)`
- B: Accept both — constructor becomes `(agentLauncher, processFactory, gracePeriodMs)` with processFactory used only for non-spawnTurn paths
- C: Method injection — keep constructor unchanged, pass agentLauncher via a setter or directly to spawnTurn()

**Answer**: A — Replace processFactory entirely; constructor becomes `(agentLauncher, gracePeriodMs)`

`processFactory` is only used in two methods: `spawnTurn()` (the active path) and `spawn()` (deprecated, line 109). Both spawn Claude via `python3 -u -c <PTY_WRAPPER> claude ...` — both are Claude-specific invocations that route through `ClaudeCodeLaunchPlugin`. `gracefulKill()` does not use `processFactory` at all (it only calls `handle.kill()`).

Since `AgentLauncher` wraps `ProcessFactory` internally, replacing `processFactory` with `agentLauncher` loses nothing. The deprecated `spawn()` method also routes through `agentLauncher.launch({ pluginId: "claude-code", intent: { kind: "conversation-turn", ... } })` — its command composition is nearly identical to `spawnTurn()` minus the `-p` flag.

Option B (accept both) adds a transitional dependency that isn't needed — there's no consumer of `processFactory` that can't go through `agentLauncher`. Option C (method injection) scatters the dependency across call sites instead of centralizing it.

### Q2: AgentLauncher Instance Wiring
**Context**: ConversationSpawner is currently created in `server.ts` (line ~344) with `conversationProcessFactory`. The existing `AgentLauncher` instance is created in `claude-cli-worker.ts` (line ~110) with the process factories and plugins already registered. These are in different parts of the application lifecycle.
**Question**: Where should the `AgentLauncher` instance for ConversationSpawner come from? Should `server.ts` create its own AgentLauncher, reuse the one from `ClaudeCliWorker`, or restructure the wiring so both share a single instance?
**Options**:
- A: Create a new AgentLauncher in server.ts with the same factory/plugin registrations
- B: Pass the existing AgentLauncher from ClaudeCliWorker into the conversation system
- C: Lift AgentLauncher creation to a shared setup function used by both

**Answer**: C — Lift AgentLauncher creation to a shared setup function

Both `server.ts` (which creates `ConversationSpawner`) and `claude-cli-worker.ts` (which creates `CliSpawner`) need an `AgentLauncher` with the same plugin registrations and factory map. Duplicating that setup in two places invites drift.

Create a shared factory function (e.g. `createAgentLauncher(config)` in a new `launcher-setup.ts` or similar) that:
- Creates the factory map (`"default"` → `defaultProcessFactory`, `"interactive"` → `conversationProcessFactory`)
- Registers `ClaudeCodeLaunchPlugin` and `GenericSubprocessPlugin`
- Returns the configured `AgentLauncher`

Both `server.ts` and `claude-cli-worker.ts` call this function. `server.ts` passes the launcher to `ConversationSpawner`; `claude-cli-worker.ts` passes it to `CliSpawner`.

Option A (duplicate AgentLauncher in server.ts) risks plugin registration inconsistencies. Option B (pass from ClaudeCliWorker into conversation system) creates a coupling between the worker and conversation subsystems that doesn't exist today.

### Q3: Environment Construction Ownership
**Context**: Currently ConversationSpawner builds environment variables inline before spawning. FR-007 says "cwd and env are passed through the LaunchRequest, not constructed separately." AgentLauncher has a 3-layer env merge (`process.env ← plugin env ← caller env`), and `conversationProcessFactory` also merges `process.env` with spawn options, creating a potential double-merge.
**Question**: After migration, should ConversationSpawner still construct env vars and pass them as `LaunchRequest.env` (caller overrides), or should env construction move entirely into the plugin? And should `conversationProcessFactory` be modified to avoid double-merging `process.env`?
**Options**:
- A: ConversationSpawner passes env as caller overrides in LaunchRequest.env; accept double-merge as harmless
- B: Move env construction into the plugin; ConversationSpawner passes no env
- C: ConversationSpawner passes env as caller overrides AND fix conversationProcessFactory to not re-merge process.env

**Answer**: C — ConversationSpawner passes env as caller overrides AND fix conversationProcessFactory to not re-merge

This aligns with the decision established in #425 Q4 (answer C): **AgentLauncher owns the `process.env` base layer**; factories pass env through unchanged.

Currently `spawnTurn()` passes `env: {}` and the factory merges with `process.env`. After migration:
- `ConversationSpawner` passes `request.env = {}` (no caller overrides)
- `AgentLauncher` merges: `{ ...process.env, ...pluginEnv, ...callerEnv }` = `{ ...process.env }` (since both plugin and caller env are empty for this intent)
- The factory receives the fully merged env and passes it through without re-merging

The factory fix (removing `{ ...process.env, ...options.env }` → just `options.env`) coordinates with #425's ProcessFactory standardization. If that change hasn't landed yet when this issue is implemented, the double-merge is harmless (spread semantics make `{ ...process.env, ...{ ...process.env } }` = `{ ...process.env }`), but the factory fix should be tracked as a prerequisite or co-landed.

### Q4: Test Modification Expectation
**Context**: US1 AC3 states "All existing conversation tests pass without modification." However, `conversation-spawner.test.ts` mocks `processFactory.spawn()` directly, and `conversation-manager.test.ts` mocks `spawner.spawnTurn()`. Since the constructor and internal delegation are changing, at minimum the mock setup in spawner tests must change.
**Question**: Does "without modification" mean (a) test files must not be edited at all (requiring a backward-compatible shim), (b) test assertions/behavior verification stay equivalent but mock setup can change, or (c) only integration tests must pass unchanged while unit tests can be updated?
**Options**:
- A: No test file edits — backward-compatible API required
- B: Mock setup can change but assertions must remain equivalent
- C: Only integration tests must pass unchanged; unit tests can be rewritten

**Answer**: B — Mock setup can change; assertions must remain equivalent

`conversation-spawner.test.ts` mocks `processFactory.spawn()` and verifies the args passed to it. After migration, the mock target changes from `processFactory.spawn()` to `agentLauncher.launch()` (or the `RecordingProcessFactory` at the end of the chain). The mock setup lines change, but the assertions verify the same thing: "given these `ConversationTurnOptions`, the composed command includes `--resume <sessionId>`, `--model <model>`, etc."

`conversation-manager.test.ts` mocks the spawner itself (`spawner.spawnTurn = vi.fn()`), not the underlying factory. These tests should need **zero changes** — they don't care how `spawnTurn()` is implemented internally.

### Q5: AbortSignal Propagation
**Context**: AgentLauncher accepts `request.signal?: AbortSignal` for cancellation, but current `spawnTurn()` has no signal/cancellation mechanism (relying instead on `gracefulKill()`). The migration is an opportunity to add AbortSignal support, but the spec lists "preserve byte-identical subprocess shape" as a goal and doesn't mention signal changes.
**Question**: Should the migration add AbortSignal support to `spawnTurn()` (leveraging AgentLauncher's existing capability), or should it be omitted to keep the migration minimal and byte-identical?
**Options**:
- A: Omit AbortSignal — keep migration minimal, add in a follow-up issue
- B: Add AbortSignal as optional parameter to spawnTurn() — low risk since it's additive

**Answer**: A — Omit AbortSignal; keep migration minimal

`spawnTurn()` currently has no signal parameter. Adding one is additive and low-risk, but it's scope creep for a migration issue whose explicit goal is "byte-identical subprocess shape."

The conversation system manages process lifecycle through `ConversationManager.end()` → `spawner.gracefulKill()`, not through abort signals. Adding abort support is a feature, not a refactor — it belongs in a follow-up issue if there's a use case for it.

Pass `signal: undefined` in the `LaunchRequest` (same approach as #431 Q2 — callers that own their own lifecycle don't pass signal to the launcher).
