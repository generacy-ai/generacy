/**
 * Module-level process launcher registration.
 *
 * Allows the orchestrator to register a launcher function at boot time
 * that routes spawn calls through AgentLauncher. External npm consumers
 * that never call registerProcessLauncher() get the fallback (direct spawn).
 */

/** Describes what to spawn via the registered process launcher */
export interface LaunchFunctionRequest {
  /** Intent kind: 'generic-subprocess' for command+args, 'shell' for shell command string */
  kind: 'generic-subprocess' | 'shell';
  /** Command to execute */
  command: string;
  /** Command arguments (empty for shell kind) */
  args: string[];
  /** Working directory */
  cwd: string;
  /** Environment variable overrides */
  env?: Record<string, string>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Whether to create a process group (enables group-kill) */
  detached?: boolean;
}

/** Handle returned by the registered process launcher */
export interface LaunchFunctionHandle {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  pid: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  exitPromise: Promise<number | null>;
}

/** Function type for the module-level process launcher registration */
export type LaunchFunction = (request: LaunchFunctionRequest) => LaunchFunctionHandle;

let _registeredLauncher: LaunchFunction | undefined;

/** Register a process launcher (called once at orchestrator boot) */
export function registerProcessLauncher(launcher: LaunchFunction): void {
  if (_registeredLauncher) {
    throw new Error('Process launcher already registered. Call clearProcessLauncher() first if re-registering.');
  }
  _registeredLauncher = launcher;
}

/** Get the registered process launcher (undefined if not registered) */
export function getProcessLauncher(): LaunchFunction | undefined {
  return _registeredLauncher;
}

/** Clear registration (for testing) */
export function clearProcessLauncher(): void {
  _registeredLauncher = undefined;
}
