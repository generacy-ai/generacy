# Clarifications

## Batch 1 — 2026-04-12

### Q1: ConversationTurnIntent field shape
**Context**: The spec defines the conversation-turn intent as `{ kind: "conversation-turn", turn }` but never specifies the `turn` object type. The existing `ConversationTurnOptions` in `conversation-spawner.ts` includes `message: string`, `sessionId?: string`, `model?: string`, and `skipPermissions: boolean`. These fields are essential for composing the PTY-wrapped command.
**Question**: What fields should `ConversationTurnIntent` contain? Should it mirror `ConversationTurnOptions` (message, sessionId, model, skipPermissions), or should some fields be handled differently?
**Options**:
- A: Mirror all fields from `ConversationTurnOptions` directly on the intent (`message`, `sessionId?`, `model?`, `skipPermissions`)
- B: Flatten into the intent without a nested `turn` object (e.g., `{ kind: "conversation-turn", message, sessionId?, ... }`)
- C: Keep a nested `turn` object containing only the message/session, with model and permissions as separate top-level fields

**Answer**: **B** — Flatten fields directly on the intent (no nested `turn` object). The intent carries `{ kind: "conversation-turn", message: string, sessionId?: string, model?: string, skipPermissions: boolean }`. `cwd` is a spawn-level concern on `LaunchRequest.cwd`. The intent type is defined independently even if fields happen to match `ConversationTurnOptions`.

### Q2: PrFeedbackIntent prompt source
**Context**: The existing `PrFeedbackHandler` builds a structured prompt from fetched PR comments and passes it as a positional CLI arg to `claude -p <prompt>`. The spec says `buildLaunch({ kind: "pr-feedback", prNumber: 42 })` should produce the command, but `buildLaunch` is a pure synchronous method — it cannot fetch PR comments from GitHub. The prompt string must come from somewhere.
**Question**: Should `PrFeedbackIntent` include a `prompt: string` field (caller pre-builds the prompt before calling launch), or should the plugin only receive `prNumber` and produce a partial command that the caller completes?
**Options**:
- A: `PrFeedbackIntent` includes `prompt: string` — the caller builds the prompt and passes it in
- B: `PrFeedbackIntent` includes only `prNumber` — the plugin produces a command template that the caller extends
- C: `PrFeedbackIntent` includes both `prNumber` and `prompt` for metadata/logging purposes

**Answer**: **C** — Include both `prNumber` and `prompt` on the intent: `{ kind: "pr-feedback", prNumber: number, prompt: string }`. The caller (PrFeedbackHandler) builds the prompt via `buildFeedbackPrompt()` asynchronously before calling `buildLaunch()`. `prompt` is needed to compose `claude -p <prompt>`. `prNumber` is needed for intent identification, logging, and tracing.

### Q3: createOutputParser() intent-awareness
**Context**: The `AgentLaunchPlugin` interface defines `createOutputParser(): OutputParser` with no arguments. However, `ClaudeCodeLaunchPlugin` needs to return different parsers for different intents: stream-json parser for phase/pr-feedback vs PTY output parser for conversation-turn. Since `createOutputParser()` receives no intent information, the plugin would need to store state from `buildLaunch()` — but the spec says "ClaudeCodeLaunchPlugin is a pure function of its inputs" and a shared mutable state pattern breaks concurrency safety when multiple launches use the same plugin instance.
**Question**: How should the plugin vary its output parser per intent kind?
**Options**:
- A: Extend the Wave 1 interface to `createOutputParser(intent: LaunchIntent)` (breaking change to Phase 1 interface)
- B: Accept statefulness — `buildLaunch()` stores the last intent kind, `createOutputParser()` reads it (concurrency-unsafe)
- C: Always return the stream-json parser from `createOutputParser()` and have the conversation-turn path use a different mechanism (e.g., the caller wraps or replaces the parser)
- D: Return a composite parser that auto-detects the output format from the first chunk

**Answer**: **A** — Extend Wave 1 interface to `createOutputParser(intent: LaunchIntent)`. The original plan already specifies this signature. Since Wave 1 hasn't shipped yet, updating the interface is a coordination change, not a breaking change. File an update on #425's PR to add `intent: LaunchIntent` to `createOutputParser`. The `GenericSubprocessPlugin` ignores the parameter.

### Q4: Missing CLI flags (--verbose, conditional --dangerously-skip-permissions)
**Context**: Both `pr-feedback-handler` and `conversation-spawner` pass `--verbose` to Claude CLI, but the spec only mentions `--output-format stream-json`, `--dangerously-skip-permissions`, and `--resume`. Additionally, `--dangerously-skip-permissions` is always included for phase execution (FR-003) and PR feedback, but is conditional for conversation turns (via `skipPermissions` option). The spec doesn't address either of these.
**Question**: Should `--verbose` be included in all plugin-composed commands? And should `--dangerously-skip-permissions` be configurable per-intent or always hardcoded?
**Options**:
- A: Always include both `--verbose` and `--dangerously-skip-permissions` for all intents (simplest, matches current behavior)
- B: Always include `--verbose`; make `--dangerously-skip-permissions` configurable via a field on each intent type
- C: Make both flags configurable per-intent

**Answer**: **B** — Always include `--verbose`; make `--dangerously-skip-permissions` configurable per-intent. All three spawn sites include `--verbose` unconditionally. `--dangerously-skip-permissions` is unconditional for phase and pr-feedback intents but conditional on `skipPermissions` for conversation-turn (already carried on the intent per Q1). No extra configuration field needed — intent kind determines behavior.

### Q5: Validate phase handling
**Context**: `PHASE_TO_COMMAND` maps `validate` to `null`, meaning there is no Claude CLI slash command for the validate phase. The spec doesn't specify how `buildLaunch({ kind: "phase", phase: "validate" })` should behave.
**Question**: Should `PhaseIntent` exclude `validate` from its phase type (compile-time prevention), or should `buildLaunch` throw a runtime error for unsupported phases?
**Options**:
- A: Exclude `validate` from `PhaseIntent.phase` type — `phase: "specify" | "clarify" | "plan" | "tasks" | "implement"` (compile-time safety)
- B: Include `validate` in the type but throw at runtime from `buildLaunch` if the phase maps to `null`
- C: Include `validate` and return a no-op `LaunchSpec` (e.g., `echo "validate is a no-op"`)

**Answer**: **A** — Exclude `validate` from `PhaseIntent.phase` type: `phase: "specify" | "clarify" | "plan" | "tasks" | "implement"`. The validate phase doesn't invoke Claude — it runs `sh -c <cmd>` via `runValidatePhase`, which is a `{ kind: "shell" }` intent for `GenericSubprocessPlugin`. Compile-time exclusion matches the existing control flow where the orchestrator branches `validate` to `runValidatePhase` before reaching `spawnPhase`.
