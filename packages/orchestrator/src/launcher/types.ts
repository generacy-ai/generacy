import type { ChildProcessHandle } from '../worker/types.js';
import type { LaunchRequestCredentials } from '@generacy-ai/credhelper';

/**
 * Intent for launching a generic subprocess with explicit command/args.
 */
export interface GenericSubprocessIntent {
  kind: 'generic-subprocess';
  command: string;
  args: string[];
  env?: Record<string, string>;
  detached?: boolean;
  /** Stdio profile selecting which ProcessFactory to use. Default: 'default' */
  stdioProfile?: 'default' | 'interactive';
}

/**
 * Intent for launching a shell command (string passed to sh -c).
 */
export interface ShellIntent {
  kind: 'shell';
  command: string;
  env?: Record<string, string>;
  detached?: boolean;
}

/**
 * Intent for executing a speckit workflow phase.
 * Excludes 'validate' at compile time — validate runs via GenericSubprocessPlugin.
 */
export interface PhaseIntent {
  kind: 'phase';
  /** Speckit phase to execute */
  phase: 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement';
  /** Full prompt text: slash command + issue URL (composed by caller) */
  prompt: string;
  /** Resume a previous session (for MCP server warmth + context carry) */
  sessionId?: string;
  /** Optional model override, provider-interpreted. */
  model?: string;
}

/**
 * Intent for addressing PR review feedback.
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
 * Intent for a bounded validate-fix agent attempt (#892). Routes through the
 * same launcher plumbing as `pr-feedback`. The `evidenceHash` surfaces in
 * launcher observability + PhaseTracker dedupe key.
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
 * Intent for a bounded merge-conflict resolution agent attempt (#898).
 * Routes through the same launcher plumbing as `pr-feedback`.
 */
export interface MergeConflictIntent {
  kind: 'merge-conflict';
  /** For logging/tracing */
  issueNumber: number;
  /** Full prompt (built by MergeConflictHandler via buildMergeConflictPrompt) */
  prompt: string;
}

/**
 * Intent for a single interactive conversation turn.
 */
export interface ConversationTurnIntent {
  kind: 'conversation-turn';
  /** User message to send */
  message: string;
  /** Resume session ID (omit for first turn) */
  sessionId?: string;
  /** Model override (omit for default) */
  model?: string;
  /** Whether to skip permission prompts */
  skipPermissions: boolean;
}

/**
 * Intent for invoking a raw command string.
 */
export interface InvokeIntent {
  kind: 'invoke';
  /** Raw command string (e.g., "/speckit:specify https://...") */
  command: string;
  /** Whether to stream output (reserved for future use) */
  streaming?: boolean;
}

/**
 * Discriminated union of all launch intent kinds.
 */
export type LaunchIntent =
  | GenericSubprocessIntent
  | ShellIntent
  | PhaseIntent
  | PrFeedbackIntent
  | ValidateFixIntent
  | MergeConflictIntent
  | ConversationTurnIntent
  | InvokeIntent;

/**
 * Request to launch a process through the AgentLauncher.
 */
export interface LaunchRequest {
  /** The intent describing what to launch */
  intent: LaunchIntent;
  /** Working directory for the spawned process */
  cwd: string;
  /** Caller-provided environment overrides (highest priority in merge) */
  env?: Record<string, string>;
  /** Optional abort signal for cancellation */
  signal?: AbortSignal;
  /** Whether to create a process group (enables group-kill) */
  detached?: boolean;
  /** Optional credential scoping — when set, a credhelper session is managed around the subprocess */
  credentials?: LaunchRequestCredentials;
  /** Optional provider selector. Default: 'claude-code'. Runtime-validated (UnknownProviderError). */
  provider?: string;
}

/**
 * Output of a plugin's buildLaunch() — tells the launcher HOW to spawn.
 */
export interface LaunchSpec {
  /** Executable command */
  command: string;
  /** Command arguments */
  args: string[];
  /** Plugin-provided environment variables (middle priority in merge) */
  env?: Record<string, string>;
  /**
   * Stdio profile name selecting which ProcessFactory to use.
   * Default: "default" (stdin ignored, stdout/stderr piped)
   * "interactive" selects the conversation factory (all stdio piped)
   */
  stdioProfile?: string;
  /** Whether to create a process group (forwarded from intent) */
  detached?: boolean;
}

/**
 * Plugin interface for the AgentLauncher registry.
 * Each plugin handles one or more LaunchIntent kinds.
 */
export interface AgentLaunchPlugin {
  /** Unique identifier for this plugin */
  readonly pluginId: string;
  /** Provider namespace this plugin claims. Registry key is (provider, kind). */
  readonly provider: string;
  /** Intent kinds this plugin can handle */
  readonly supportedKinds: readonly string[];
  /**
   * Transform a LaunchIntent into a LaunchSpec (command, args, env, stdio profile).
   * Called by AgentLauncher during launch().
   */
  buildLaunch(intent: LaunchIntent): LaunchSpec;
  /**
   * Create a new OutputParser instance for this launch.
   * Called once per launch; the parser is attached to the LaunchHandle.
   * @param intent - The launch intent (plugins may use this to select parser behavior)
   */
  createOutputParser(intent: LaunchIntent): OutputParser;
}

/**
 * Stateful output parser attached to a launched process.
 * Processes chunks from stdout/stderr streams.
 */
export interface OutputParser {
  /**
   * Process a chunk of output from the child process.
   * @param stream - Which stream the data came from
   * @param data - The string data chunk
   */
  processChunk(stream: 'stdout' | 'stderr', data: string): void;
  /**
   * Flush any buffered state. Called when the process exits.
   */
  flush(): void;
}

/**
 * Handle returned by AgentLauncher.launch().
 * Thin wrapper — no lifecycle ownership (callers manage shutdown).
 */
export interface LaunchHandle {
  /** The underlying child process handle (kill, exitPromise, stdio streams) */
  process: ChildProcessHandle;
  /** Plugin-created output parser for this launch */
  outputParser: OutputParser;
  /** Plugin-provided metadata (e.g., plugin ID, intent kind) */
  metadata: {
    pluginId: string;
    intentKind: string;
    [key: string]: unknown;
  };
}
