# Clarifications: Introduce AgentLauncher + GenericSubprocessPlugin

## Batch 1 — 2026-04-12

### Q1: LaunchSpec stdio config vs ProcessFactory
**Context**: FR-003 defines `LaunchSpec` output as including "stdio config", but `ProcessFactory.spawn()` accepts only `{ cwd, env, signal }` — stdio configuration is baked into each factory implementation (`defaultProcessFactory` uses `['ignore', 'pipe', 'pipe']`; `conversationProcessFactory` uses `['pipe', 'pipe', 'pipe']`). This mismatch blocks the `LaunchSpec` type definition and the `launch()` implementation.
**Question**: How should `LaunchSpec`'s stdio config relate to `ProcessFactory`?
**Options**:
- A: Extend `ProcessFactory.spawn()` to accept stdio options (breaking change to the interface)
- B: Make stdio in `LaunchSpec` metadata-only (ProcessFactory continues to own stdio internally)
- C: `AgentLauncher` holds multiple `ProcessFactory` instances and selects one based on the plugin's stdio needs

**Answer**: **C** — `AgentLauncher` holds multiple `ProcessFactory` instances keyed by stdio profile name (e.g. `"default"`, `"interactive"`). `LaunchSpec` includes a `stdioProfile?: string` field (defaulting to `"default"`). The launcher selects the factory matching the profile. This matches the current architecture where `conversationProcessFactory` exists solely for interactive use, and avoids touching the `ProcessFactory` interface.

### Q2: OutputParser interface shape
**Context**: FR-005 requires defining an `OutputParser` interface. Existing parsers in the codebase differ significantly: `OutputCapture` is callback-based with `processChunk()`/`flush()`; `ConversationOutputParser` is event-driven. Even though `GenericSubprocessPlugin` only needs a passthrough, the interface contract must be defined now since all future plugins implement it.
**Question**: What shape should the `OutputParser` interface take?
**Options**:
- A: Stateful processor — `processChunk(stream: 'stdout'|'stderr', data: Buffer): void` + `flush(): void` (aligns with existing `OutputCapture`)
- B: Pair of Node.js transform streams (stdout + stderr)
- C: Simple stateless function `parse(data: Buffer): T`

**Answer**: **A** — Stateful processor with `processChunk(stream: 'stdout'|'stderr', data: string): void` + `flush(): void`. Aligns with existing `OutputCapture` and `ConversationOutputParser` which both implement this contract. The `stream` discriminator is a minor extension that lets `GenericSubprocessPlugin` passthrough capture both streams.

### Q3: LaunchIntent — define all 5 kinds or only Phase 1 kinds
**Context**: FR-001 defines `LaunchIntent` as a discriminated union with 5 kinds (`phase`, `pr-feedback`, `conversation-turn`, `generic-subprocess`, `shell`), but only `generic-subprocess` and `shell` are handled in Phase 1. Defining all 5 kinds upfront requires knowing the per-kind payload shape (e.g., what fields does a `phase` intent carry?). Defining only 2 means deciding how to make the union extensible later.
**Question**: Should the Phase 1 type definition include all 5 `LaunchIntent` kinds with their payload shapes, or only the 2 kinds that Phase 1 handles?
**Options**:
- A: Define all 5 kinds now with best-guess payloads (may need revision in Wave 2)
- B: Define only `generic-subprocess` and `shell`; make the union extensible via a generic `kind: string` escape hatch
- C: Define only `generic-subprocess` and `shell` as concrete types; add remaining kinds in their respective waves as pure additions to the union

**Answer**: **C** — Define only `generic-subprocess` and `shell` as concrete types; add remaining kinds in their respective waves as pure additions to the union. TypeScript discriminated unions are naturally additive. Each wave's PR adds to the union in the same commit as the plugin that handles it.

### Q4: process.env merging responsibility
**Context**: The spec says `AgentLauncher.launch()` merges plugin env with caller env (caller wins — FR-008). However, `defaultProcessFactory` already merges the passed env with `process.env` internally, while `conversationProcessFactory` does not. This creates ambiguity about where `process.env` enters the picture — if AgentLauncher also merges `process.env`, the result is double-merged for some factories.
**Question**: Should `AgentLauncher` merge `process.env` into the env it passes to `ProcessFactory.spawn()`, or should it pass only the plugin+caller merged env and leave `process.env` handling to the factory?
**Options**:
- A: AgentLauncher merges `process.env` (factories should NOT merge again — implies standardizing factory behavior)
- B: AgentLauncher passes only plugin+caller env; each factory decides whether to include `process.env` (status quo, but inconsistent)
- C: AgentLauncher always includes `process.env` as the base layer (process.env ← plugin env ← caller env), and factories are updated to NOT merge

**Answer**: **C** — `AgentLauncher` always includes `process.env` as the base layer (`process.env ← plugin env ← caller env`), and factories are updated to NOT merge. Both factories currently merge identically (`{ ...process.env, ...options.env }`), so removing the merge from factories is mechanical with zero net behavioral difference. The factory change should land in the same PR.

### Q5: LaunchHandle lifecycle and signal ownership
**Context**: The spec says `LaunchHandle` wraps `ChildProcessHandle` (FR-006) and `LaunchRequest` carries an abort signal (FR-002). Currently every spawner (`CliSpawner`, `ConversationSpawner`, `PrFeedbackHandler`) independently implements SIGTERM → grace period → SIGKILL shutdown logic. US3 requires signal propagation through `LaunchHandle`. This is a design fork: should `LaunchHandle` centralize lifecycle management or remain a thin wrapper?
**Question**: Should `LaunchHandle` own process lifecycle (abort signal wiring, graceful shutdown with SIGTERM→SIGKILL) or just passthrough `kill()` from `ChildProcessHandle` and leave lifecycle to callers?
**Options**:
- A: Thin wrapper — `LaunchHandle` exposes `kill()` and `exitPromise` directly; callers manage lifecycle (matches Phase 1 "zero caller changes" goal)
- B: Full lifecycle — `LaunchHandle` wires abort signal, implements graceful shutdown, and exposes a higher-level `abort()` method (centralizes duplicated logic but adds Phase 1 scope)

**Answer**: **A** — Thin wrapper. `LaunchHandle` exposes `process: ChildProcessHandle` (with `kill()` and `exitPromise`) plus `outputParser` and metadata. Callers continue to implement their own shutdown. Lifecycle consolidation belongs in Wave 3 when callers are being migrated.
