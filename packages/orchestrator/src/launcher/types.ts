import type { ChildProcessHandle } from '../worker/types.js';

/**
 * Intent for launching a generic subprocess with explicit command/args.
 */
export interface GenericSubprocessIntent {
  kind: 'generic-subprocess';
  command: string;
  args: string[];
  env?: Record<string, string>;
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
}

/**
 * Discriminated union of all launch intent kinds.
 * Phase 1: generic-subprocess, shell
 * Future waves add: phase, pr-feedback, conversation-turn
 */
export type LaunchIntent = GenericSubprocessIntent | ShellIntent;

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
}

/**
 * Plugin interface for the AgentLauncher registry.
 * Each plugin handles one or more LaunchIntent kinds.
 */
export interface AgentLaunchPlugin {
  /** Unique identifier for this plugin */
  readonly pluginId: string;
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
   */
  createOutputParser(): OutputParser;
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
