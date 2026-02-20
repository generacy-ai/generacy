import type {
  CliSpawnOptions,
  ChildProcessHandle,
  Logger,
  PhaseResult,
  ProcessFactory,
  WorkflowPhase,
} from './types.js';
import { PHASE_TO_COMMAND } from './types.js';
import type { OutputCapture } from './output-capture.js';

/** Default timeout for the validate phase (10 minutes). */
const DEFAULT_VALIDATE_TIMEOUT_MS = 600_000;

/**
 * Spawns Claude CLI processes (or shell commands for validation) and manages
 * their lifecycle: stdout/stderr capture, timeout with SIGTERM then SIGKILL,
 * and abort signal propagation.
 */
export class CliSpawner {
  constructor(
    private readonly processFactory: ProcessFactory,
    private readonly logger: Logger,
    private readonly shutdownGracePeriodMs: number = 5000,
  ) {}

  /**
   * Spawn a Claude CLI process for the given workflow phase.
   *
   * Builds the command line from PHASE_TO_COMMAND, captures stdout via the
   * provided OutputCapture, and handles timeout / abort with a
   * SIGTERM -> grace period -> SIGKILL sequence.
   */
  async spawnPhase(
    phase: WorkflowPhase,
    options: CliSpawnOptions,
    capture: OutputCapture,
  ): Promise<PhaseResult> {
    const command = PHASE_TO_COMMAND[phase];
    if (command === null) {
      throw new Error(`Phase "${phase}" has no CLI command (use runValidatePhase instead)`);
    }

    const prompt = `${command} ${options.prompt}`;

    const args = [
      '--headless',
      '--output', 'json',
      '--print', 'all',
      '--max-turns', String(options.maxTurns),
    ];

    // Resume a previous session to keep MCP servers warm and carry context
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    }

    args.push('--prompt', prompt);

    this.logger.info(
      {
        phase,
        cwd: options.cwd,
        maxTurns: options.maxTurns,
        timeoutMs: options.timeoutMs,
        resumeSessionId: options.resumeSessionId ?? null,
      },
      options.resumeSessionId
        ? 'Resuming Claude CLI session for phase'
        : 'Spawning new Claude CLI session for phase',
    );

    const child = this.processFactory.spawn('claude', args, {
      cwd: options.cwd,
      env: options.env,
    });

    return this.manageProcess(child, phase, options.timeoutMs, options.signal, capture);
  }

  /**
   * Run a shell validation command (e.g., `pnpm test && pnpm build`).
   *
   * Unlike `spawnPhase`, this does not invoke the Claude CLI; it runs an
   * arbitrary shell command via `sh -c`.
   */
  async runValidatePhase(
    checkoutPath: string,
    validateCommand: string,
    signal: AbortSignal,
  ): Promise<PhaseResult> {
    const phase: WorkflowPhase = 'validate';
    const timeoutMs = DEFAULT_VALIDATE_TIMEOUT_MS;

    this.logger.info(
      { phase, cwd: checkoutPath, validateCommand, timeoutMs },
      'Spawning validation command',
    );

    const child = this.processFactory.spawn('sh', ['-c', validateCommand], {
      cwd: checkoutPath,
      env: {} as Record<string, string>,
    });

    return this.manageProcess(child, phase, timeoutMs, signal, undefined);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Manages the full lifecycle of a spawned child process:
   * - Capture stdout (via OutputCapture if provided) and stderr
   * - Enforce timeout with SIGTERM -> grace period -> SIGKILL
   * - Propagate abort signal
   * - Return a PhaseResult once the process exits
   */
  private async manageProcess(
    child: ChildProcessHandle,
    phase: WorkflowPhase,
    timeoutMs: number,
    signal: AbortSignal,
    capture: OutputCapture | undefined,
  ): Promise<PhaseResult> {
    const startTime = Date.now();
    let stderrBuffer = '';

    // ---- stdout ----
    if (child.stdout && capture) {
      child.stdout.on('data', (data: Buffer | string) => {
        capture.processChunk(typeof data === 'string' ? data : data.toString('utf-8'));
      });
    }

    // For runValidatePhase we still want to capture stdout even without OutputCapture,
    // so we attach a no-op listener to avoid back-pressure issues.
    if (child.stdout && !capture) {
      child.stdout.on('data', () => {
        // intentionally empty
      });
    }

    // ---- stderr ----
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer | string) => {
        stderrBuffer += typeof data === 'string' ? data : data.toString('utf-8');
      });
    }

    // ---- Timeout handling ----
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      this.logger.warn(
        { phase, pid: child.pid, timeoutMs },
        'Phase timed out, sending SIGTERM',
      );
      this.gracefulKill(child, phase);
    }, timeoutMs);

    // ---- Abort signal handling ----
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      this.logger.warn({ phase, pid: child.pid }, 'Abort signal received, sending SIGTERM');
      this.gracefulKill(child, phase);
    };

    // Avoid attaching listener if already aborted.
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // ---- Wait for exit ----
    let exitCode: number | null;
    try {
      exitCode = await child.exitPromise;
    } finally {
      clearTimeout(timeoutTimer);
      signal.removeEventListener('abort', onAbort);
    }

    // ---- Flush capture ----
    if (capture) {
      capture.flush();
    }

    const durationMs = Date.now() - startTime;
    const resolvedExitCode = exitCode ?? 1;
    const success = resolvedExitCode === 0;

    this.logger.info(
      { phase, exitCode: resolvedExitCode, durationMs, success, timedOut, aborted },
      'Phase process exited',
    );

    const result: PhaseResult = {
      phase,
      success,
      exitCode: resolvedExitCode,
      durationMs,
      output: capture ? capture.getOutput() : [],
      sessionId: capture?.sessionId,
    };

    if (!success) {
      let message = `Phase "${phase}" failed with exit code ${resolvedExitCode}`;
      if (timedOut) {
        message = `Phase "${phase}" timed out after ${timeoutMs}ms`;
      } else if (aborted) {
        message = `Phase "${phase}" was aborted`;
      }

      result.error = {
        message,
        stderr: stderrBuffer,
        phase,
      };
    }

    return result;
  }

  /**
   * Send SIGTERM, wait the grace period, then send SIGKILL if the process
   * is still alive.
   */
  private gracefulKill(child: ChildProcessHandle, phase: WorkflowPhase): void {
    child.kill('SIGTERM');

    const killTimer = setTimeout(() => {
      this.logger.warn(
        { phase, pid: child.pid },
        'Grace period expired, sending SIGKILL',
      );
      child.kill('SIGKILL');
    }, this.shutdownGracePeriodMs);

    // Clear the SIGKILL timer once the process exits on its own.
    void child.exitPromise.then(() => {
      clearTimeout(killTimer);
    });
  }
}
