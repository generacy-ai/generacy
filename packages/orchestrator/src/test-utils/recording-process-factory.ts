import { EventEmitter } from 'node:events';
import type { ProcessFactory, ChildProcessHandle } from '../worker/types.js';

/**
 * Captures exactly what the spawner passes to `ProcessFactory.spawn()`.
 */
export interface SpawnRecord {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * A `ProcessFactory` implementation that records every `spawn()` call
 * and returns a dummy `ChildProcessHandle`. Designed for snapshot testing
 * of spawn argument composition.
 */
export class RecordingProcessFactory implements ProcessFactory {
  readonly calls: SpawnRecord[] = [];

  constructor(private readonly exitCode: number = 0) {}

  spawn(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
  ): ChildProcessHandle {
    this.calls.push({
      command,
      args: [...args],
      cwd: options.cwd,
      env: { ...options.env },
    });

    let exitResolve: (code: number | null) => void;
    const exitPromise = new Promise<number | null>((resolve) => {
      exitResolve = resolve;
    });

    // Resolve after a microtask to simulate immediate exit
    void Promise.resolve().then(() => exitResolve(this.exitCode));

    return {
      stdin: null,
      stdout: new EventEmitter() as unknown as NodeJS.ReadableStream,
      stderr: new EventEmitter() as unknown as NodeJS.ReadableStream,
      pid: 12345,
      kill: () => {
        exitResolve(this.exitCode);
        return true;
      },
      exitPromise,
    };
  }

  reset(): void {
    this.calls.length = 0;
  }
}
