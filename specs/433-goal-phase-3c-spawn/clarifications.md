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

**Answer**: *Pending*

### Q2: AgentLauncher Instance Wiring
**Context**: ConversationSpawner is currently created in `server.ts` (line ~344) with `conversationProcessFactory`. The existing `AgentLauncher` instance is created in `claude-cli-worker.ts` (line ~110) with the process factories and plugins already registered. These are in different parts of the application lifecycle.
**Question**: Where should the `AgentLauncher` instance for ConversationSpawner come from? Should `server.ts` create its own AgentLauncher, reuse the one from `ClaudeCliWorker`, or restructure the wiring so both share a single instance?
**Options**:
- A: Create a new AgentLauncher in server.ts with the same factory/plugin registrations
- B: Pass the existing AgentLauncher from ClaudeCliWorker into the conversation system
- C: Lift AgentLauncher creation to a shared setup function used by both

**Answer**: *Pending*

### Q3: Environment Construction Ownership
**Context**: Currently ConversationSpawner builds environment variables inline before spawning. FR-007 says "cwd and env are passed through the LaunchRequest, not constructed separately." AgentLauncher has a 3-layer env merge (`process.env ← plugin env ← caller env`), and `conversationProcessFactory` also merges `process.env` with spawn options, creating a potential double-merge.
**Question**: After migration, should ConversationSpawner still construct env vars and pass them as `LaunchRequest.env` (caller overrides), or should env construction move entirely into the plugin? And should `conversationProcessFactory` be modified to avoid double-merging `process.env`?
**Options**:
- A: ConversationSpawner passes env as caller overrides in LaunchRequest.env; accept double-merge as harmless
- B: Move env construction into the plugin; ConversationSpawner passes no env
- C: ConversationSpawner passes env as caller overrides AND fix conversationProcessFactory to not re-merge process.env

**Answer**: *Pending*

### Q4: Test Modification Expectation
**Context**: US1 AC3 states "All existing conversation tests pass without modification." However, `conversation-spawner.test.ts` mocks `processFactory.spawn()` directly, and `conversation-manager.test.ts` mocks `spawner.spawnTurn()`. Since the constructor and internal delegation are changing, at minimum the mock setup in spawner tests must change.
**Question**: Does "without modification" mean (a) test files must not be edited at all (requiring a backward-compatible shim), (b) test assertions/behavior verification stay equivalent but mock setup can change, or (c) only integration tests must pass unchanged while unit tests can be updated?
**Options**:
- A: No test file edits — backward-compatible API required
- B: Mock setup can change but assertions must remain equivalent
- C: Only integration tests must pass unchanged; unit tests can be rewritten

**Answer**: *Pending*

### Q5: AbortSignal Propagation
**Context**: AgentLauncher accepts `request.signal?: AbortSignal` for cancellation, but current `spawnTurn()` has no signal/cancellation mechanism (relying instead on `gracefulKill()`). The migration is an opportunity to add AbortSignal support, but the spec lists "preserve byte-identical subprocess shape" as a goal and doesn't mention signal changes.
**Question**: Should the migration add AbortSignal support to `spawnTurn()` (leveraging AgentLauncher's existing capability), or should it be omitted to keep the migration minimal and byte-identical?
**Options**:
- A: Omit AbortSignal — keep migration minimal, add in a follow-up issue
- B: Add AbortSignal as optional parameter to spawnTurn() — low risk since it's additive

**Answer**: *Pending*
