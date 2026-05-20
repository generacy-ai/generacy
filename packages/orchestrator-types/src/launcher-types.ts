/**
 * Type definitions for the AgentLauncher system.
 * These are interfaces only — no runtime code.
 */

/**
 * Handle wrapping a spawned child process.
 */
export interface ChildProcessHandle {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  readonly exitPromise: Promise<number | null>;
}

/**
 * Stateful output parser attached to a launched process.
 */
export interface OutputParser {
  processChunk(stream: 'stdout' | 'stderr', data: string): void;
  flush(): void;
}

/**
 * Intent for launching a generic subprocess.
 */
export interface GenericSubprocessIntent {
  kind: 'generic-subprocess';
  command: string;
  args: string[];
  env?: Record<string, string>;
  detached?: boolean;
  stdioProfile?: string;
}

/**
 * Intent for launching a shell command.
 */
export interface ShellIntent {
  kind: 'shell';
  command: string;
  env?: Record<string, string>;
  detached?: boolean;
}

/**
 * Discriminated union of launch intent kinds.
 * The full union in the orchestrator also includes ClaudeCodeIntent;
 * this covers the subset relevant outside the orchestrator.
 */
export type LaunchIntent = GenericSubprocessIntent | ShellIntent;

/**
 * Request to launch a process through the AgentLauncher.
 */
export interface LaunchRequest {
  intent: LaunchIntent;
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  detached?: boolean;
  credentials?: unknown;
}

/**
 * Output of a plugin's buildLaunch() — tells the launcher HOW to spawn.
 */
export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  stdioProfile?: string;
  detached?: boolean;
}

/**
 * Plugin interface for the AgentLauncher registry.
 */
export interface AgentLaunchPlugin {
  readonly pluginId: string;
  readonly supportedKinds: readonly string[];
  buildLaunch(intent: LaunchIntent): LaunchSpec;
  createOutputParser(intent: LaunchIntent): OutputParser;
}

/**
 * Handle returned by AgentLauncher.launch().
 */
export interface LaunchHandle {
  process: ChildProcessHandle;
  outputParser: OutputParser;
  metadata: {
    pluginId: string;
    intentKind: string;
    [key: string]: unknown;
  };
}

/**
 * Public contract for launching agent processes.
 */
export interface AgentLauncher {
  registerPlugin(plugin: AgentLaunchPlugin): void;
  launch(request: LaunchRequest): Promise<LaunchHandle>;
}
