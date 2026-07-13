/**
 * Claude Code-specific launch intent types.
 *
 * The orchestrator OWNS the canonical agent intent types (see
 * `@generacy-ai/orchestrator` `src/launcher/types.ts`). These are structural
 * mirrors defined locally so the plugin does not take a build-time dependency
 * on the orchestrator's compiled `.d.ts` — the two packages form a workspace
 * cycle, so `pnpm -r build` compiles them concurrently and a cross-package
 * type import races the producer's `dist/`. TypeScript structural typing keeps
 * these compatible with the orchestrator-owned types at the registration seam.
 * Same rationale as the local `LaunchSpec`/`OutputParser` in
 * `claude-code-launch-plugin.ts`. (Issue #813 permits importing or structurally
 * matching the orchestrator-owned intent types.)
 */

/**
 * Intent for executing a speckit workflow phase via Claude CLI.
 * Excludes 'validate' at compile time — validate runs via GenericSubprocessPlugin.
 */
export interface PhaseIntent {
  kind: 'phase';
  /** Speckit phase to execute */
  phase: 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement';
  /** Full prompt text: slash command + issue URL (composed by caller) */
  prompt: string;
  /** Resume a previous Claude session (for MCP server warmth + context carry) */
  sessionId?: string;
  /** Optional model override, provider-interpreted. */
  model?: string;
}

/**
 * Intent for addressing PR review feedback via Claude CLI.
 */
export interface PrFeedbackIntent {
  kind: 'pr-feedback';
  /** PR number for logging/tracing */
  prNumber: number;
  /** Full prompt text (pre-built by caller via buildFeedbackPrompt()) */
  prompt: string;
  /** Optional model override, provider-interpreted. */
  model?: string;
}

/**
 * Intent for a bounded merge-conflict resolution agent attempt (#898).
 * Routes through the same launcher plumbing as `pr-feedback` — no new
 * plugin needed. The handler produces a structured prompt tagging sibling-
 * owned paths and forbidding `--theirs`/`--ours` on them.
 */
export interface MergeConflictIntent {
  kind: 'merge-conflict';
  /** For logging/tracing */
  issueNumber: number;
  /** Full prompt (built by MergeConflictHandler via buildMergeConflictPrompt) */
  prompt: string;
}

/**
 * Intent for a bounded validate-fix agent attempt (#892). Routes through the
 * same launcher plumbing as `pr-feedback` — no new plugin needed. The
 * `evidenceHash` surfaces in launcher observability + PhaseTracker dedupe key.
 */
export interface ValidateFixIntent {
  kind: 'validate-fix';
  /** PR number for logging/tracing */
  prNumber: number;
  /** Full prompt text (pre-built by ValidateFixHandler with stdout evidence) */
  prompt: string;
  /** 64-hex SHA-256 identity of the failing evidence — surfaces in logs. */
  evidenceHash: string;
}

/**
 * Intent for a single interactive conversation turn via PTY-wrapped Claude CLI.
 */
export interface ConversationTurnIntent {
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

/**
 * Intent for invoking Claude CLI with a raw command string.
 * Used by the root-level ClaudeCodeInvoker adapter.
 * Produces: claude --print --dangerously-skip-permissions <command>
 */
export interface InvokeIntent {
  kind: 'invoke';
  /** Raw command string (e.g., "/speckit:specify https://...") */
  command: string;
  /** Whether to stream output (reserved for future use) */
  streaming?: boolean;
}

/**
 * Union of all Claude Code-specific intent types.
 */
export type ClaudeCodeIntent =
  | PhaseIntent
  | PrFeedbackIntent
  | ValidateFixIntent
  | MergeConflictIntent
  | ConversationTurnIntent
  | InvokeIntent;
