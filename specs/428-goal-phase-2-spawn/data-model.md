# Data Model: ClaudeCodeLaunchPlugin (Phase 2)

**Feature**: #428 — Create ClaudeCodeLaunchPlugin
**Date**: 2026-04-12

## Core Intent Types

### PhaseIntent

Represents a request to execute a speckit workflow phase via Claude CLI.

```typescript
interface PhaseIntent {
  kind: 'phase';
  /** Speckit phase to execute — excludes 'validate' (compile-time prevention) */
  phase: 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement';
  /** Full prompt text: slash command + issue URL (composed by caller) */
  prompt: string;
  /** Resume a previous Claude session (for MCP server warmth + context carry) */
  sessionId?: string;
}
```

**Produces**: `claude -p --output-format stream-json --dangerously-skip-permissions --verbose [--resume <sessionId>] "<slash-command> <prompt>"`

### PrFeedbackIntent

Represents a request to address PR review feedback via Claude CLI.

```typescript
interface PrFeedbackIntent {
  kind: 'pr-feedback';
  /** PR number for logging/tracing */
  prNumber: number;
  /** Full prompt text (pre-built by caller via buildFeedbackPrompt()) */
  prompt: string;
}
```

**Produces**: `claude -p --output-format stream-json --dangerously-skip-permissions --verbose "<prompt>"`

### ConversationTurnIntent

Represents a single interactive conversation turn via PTY-wrapped Claude CLI.

```typescript
interface ConversationTurnIntent {
  kind: 'conversation-turn';
  /** User message to send */
  message: string;
  /** Resume session ID (omit for first turn) */
  sessionId?: string;
  /** Model override (omit for CLI default) */
  model?: string;
  /** Whether to skip permission prompts */
  skipPermissions: boolean;
}
```

**Produces**: `python3 -u -c <PTY_WRAPPER> claude -p <message> --output-format stream-json --verbose [--resume <sessionId>] [--dangerously-skip-permissions] [--model <model>]`

### ClaudeCodeIntent (Union)

```typescript
type ClaudeCodeIntent = PhaseIntent | PrFeedbackIntent | ConversationTurnIntent;
```

## Updated Wave 1 Types

### AgentLaunchPlugin (modified)

```typescript
interface AgentLaunchPlugin {
  readonly pluginId: string;
  readonly supportedKinds: readonly string[];
  buildLaunch(intent: LaunchIntent): LaunchSpec;
  createOutputParser(intent: LaunchIntent): OutputParser;  // CHANGED: added intent parameter
}
```

### LaunchIntent (extended union)

```typescript
// Phase 1 kinds
type LaunchIntent = GenericSubprocessIntent | ShellIntent;
// After Phase 2 (extended via import)
type LaunchIntent = GenericSubprocessIntent | ShellIntent | ClaudeCodeIntent;
```

**Note**: The union extension requires updating `launcher/types.ts` to import and include the Claude Code intent types. Alternative: keep `LaunchIntent` as-is and have `buildLaunch` accept `LaunchIntent | ClaudeCodeIntent` via generics or type assertion. Decision deferred to implementation — the simplest approach that satisfies the type checker wins.

## Constants

### PHASE_TO_COMMAND

```typescript
const PHASE_TO_COMMAND: Record<PhaseIntent['phase'], string> = {
  specify: '/specify',
  clarify: '/clarify',
  plan: '/plan',
  tasks: '/tasks',
  implement: '/implement',
};
```

Note: This is a subset of the orchestrator's `PHASE_TO_COMMAND` — excludes `validate: null` since the type system prevents it.

### PTY_WRAPPER

```typescript
const PTY_WRAPPER = [
  'import pty, os, sys',
  '# Prevent PTY line wrapping by setting huge terminal width',
  'os.environ["COLUMNS"] = "50000"',
  'def read(fd):',
  '    data = os.read(fd, 65536)',
  '    # Strip CRLF that PTY adds, return cleaned data',
  '    # (pty._copy writes our return value to stdout)',
  '    return data.replace(b"\\r\\n", b"\\n")',
  'pty.spawn(sys.argv[1:], read)',
].join('\n');
```

## ClaudeCodeLaunchPlugin Class

```typescript
class ClaudeCodeLaunchPlugin implements AgentLaunchPlugin {
  readonly pluginId = 'claude-code';
  readonly supportedKinds = ['phase', 'pr-feedback', 'conversation-turn'] as const;

  buildLaunch(intent: LaunchIntent): LaunchSpec;
  createOutputParser(intent: LaunchIntent): OutputParser;
}
```

### buildLaunch Output (LaunchSpec by intent)

| Intent | command | args pattern | stdioProfile | env |
|--------|---------|-------------|--------------|-----|
| phase | `"claude"` | `['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose', '--resume?', prompt]` | `"default"` | `undefined` |
| pr-feedback | `"claude"` | `['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose', prompt]` | `"default"` | `undefined` |
| conversation-turn | `"python3"` | `['-u', '-c', PTY_WRAPPER, 'claude', '-p', message, '--output-format', 'stream-json', '--verbose', '--resume?', '--dangerously-skip-permissions?', '--model?']` | `"interactive"` | `undefined` |

### Validation Rules

- `PhaseIntent.phase` must be one of: `specify`, `clarify`, `plan`, `tasks`, `implement` (enforced by TypeScript)
- `PrFeedbackIntent.prompt` must be non-empty (runtime check in `buildLaunch`)
- `ConversationTurnIntent.message` must be non-empty (runtime check in `buildLaunch`)
- `ConversationTurnIntent.skipPermissions` is required (no default — caller must be explicit)

## Relationships

```
AgentLauncher
  ├── registerPlugin(GenericSubprocessPlugin)   # Wave 1
  └── registerPlugin(ClaudeCodeLaunchPlugin)    # Wave 2 (this issue)

ClaudeCodeLaunchPlugin
  ├── handles: PhaseIntent        → replaces CliSpawner.spawnPhase() args
  ├── handles: PrFeedbackIntent   → replaces PrFeedbackHandler.spawnClaudeForFeedback() args
  └── handles: ConversationTurnIntent → replaces ConversationSpawner.spawnTurn() args

Existing callers (unchanged until Wave 3):
  CliSpawner            → still direct-spawns via ProcessFactory
  PrFeedbackHandler     → still direct-spawns via ProcessFactory
  ConversationSpawner   → still direct-spawns via ProcessFactory
```
