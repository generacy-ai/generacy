# Research: Phase 3 Cleanup — Delete PHASE_TO_COMMAND and Claude Flags

## Technology Decisions

### 1. PTY_WRAPPER import strategy

**Decision**: Import `PTY_WRAPPER` from `@generacy-ai/generacy-plugin-claude-code` into `conversation-spawner.ts`.

**Rationale**: The orchestrator already depends on the plugin package (`"@generacy-ai/generacy-plugin-claude-code": "workspace:^"`). The plugin's `constants.ts` has an identical copy with a comment: "Copied from orchestrator conversation/conversation-spawner.ts — Wave 3 deletes the orchestrator copy." This is the intended migration path.

**Alternatives considered**:
- *Keep PTY_WRAPPER in orchestrator*: Contradicts the spec goal of removing Claude-specific knowledge
- *Move to shared package*: Over-engineering for one constant; plugin ownership is the right home

### 2. PHASE_TO_COMMAND replacement in phase-loop.ts

**Decision**: Replace `PHASE_TO_COMMAND[phase] === null` with `phase === 'validate'`.

**Rationale**: The PHASE_TO_COMMAND map encodes a simple fact: `validate` is the only phase without a CLI command. An inline equality check is more readable and self-documenting.

**Alternatives considered**:
- *Import from plugin*: The plugin's PHASE_TO_COMMAND doesn't include `validate` at all (different type), so the null-check pattern doesn't work
- *New constant `PHASES_WITHOUT_CLI`*: Over-engineering for a single value

### 3. Command derivation in cli-spawner.ts

**Decision**: Derive the slash command inline as `` `/${phase}` ``.

**Rationale**: All CLI-backed phases follow the pattern `/<phase-name>`. The mapping is 1:1 with no exceptions (validate is never passed to `spawnPhase`). A lookup table adds indirection without value.

**Alternatives considered**:
- *Import PHASE_TO_COMMAND from plugin*: Adds cross-package coupling for a trivial derivation
- *Pass command as parameter from PhaseLoop*: Shifts knowledge to the caller without benefit; the pattern is intrinsic to the CLI protocol

## Implementation Patterns

### Dead code identification methodology

Files were analyzed by tracing call sites from entry points:
- `ConversationManager` → `ConversationSpawner.spawnTurn()` (active) / `.spawn()` (dead)
- `PhaseLoop` → `CliSpawner.spawnPhase()` / `.runValidatePhase()` / `.runPreValidateInstall()` (all active)
- `PrFeedbackHandler` → all private methods (all active, called from `execute()`)

### "claude" literal audit

| File | Line | Context | Verdict |
|------|------|---------|---------|
| `cli-spawner.ts` | 75 | `spawn('claude', args, ...)` | KEEP — process command |
| `pr-feedback-handler.ts` | 305 | `spawn('claude', args, ...)` | KEEP — process command |
| `conversation-spawner.ts` | 80 | `claudeArgs = ['claude', ...]` | KEEP — process args |
| `conversation-spawner.ts` | 112 | `claudeArgs = ['claude', ...]` | DELETE — inside deprecated `spawn()` |
| Test snapshots | various | `"command": "claude"` | AUTO-UPDATE |

Process command `'claude'` is NOT a plugin-ID reference — it's the executable name for the Claude CLI binary. These remain because the orchestrator still directly spawns Claude CLI processes (via CliSpawner and PrFeedbackHandler). Full decoupling (routing through AgentLauncher) is future work.

## References

- [Spawn refactor plan — Phase 3](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-3--migrate-orchestrator-spawn-sites)
- Plugin constants: `packages/generacy-plugin-claude-code/src/launch/constants.ts`
- Issue #428 (Phase 2 — plugin infrastructure)
- Issue #429 (Phase 3a), #430 (Phase 3b)
