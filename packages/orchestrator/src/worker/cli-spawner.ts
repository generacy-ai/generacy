import { Buffer } from 'node:buffer';
import type {
  CliSpawnOptions,
  ChildProcessHandle,
  Logger,
  PhaseResult,
  WorkflowPhase,
} from './types.js';
import type { OutputCapture } from './output-capture.js';
import type { AgentLauncher } from '../launcher/agent-launcher.js';
import type { ShellIntent } from '../launcher/types.js';
import { buildLaunchCredentials } from './credentials-helper.js';

/**
 * Pre-cap ring buffer capacity for shell-path merged stdout+stderr capture.
 * Deliberately larger than the 4 KiB post-cap bound so `boundOutputTail`'s
 * last-30-lines slicing has real data to work with when lines are long.
 */
const RING_BYTES = 8192;

/** Default timeout for the validate phase (10 minutes). */
export const DEFAULT_VALIDATE_TIMEOUT_MS = 600_000;

/** Default timeout for pre-validate dependency installation (5 minutes). */
export const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;

/**
 * Spawns Claude CLI processes (or shell commands for validation) and manages
 * their lifecycle: stdout/stderr capture, timeout with SIGTERM then SIGKILL,
 * and abort signal propagation.
 */
export class CliSpawner {
  constructor(
    private readonly agentLauncher: AgentLauncher,
    private readonly logger: Logger,
    private readonly shutdownGracePeriodMs: number = 5000,
    private readonly credentialRole?: string,
  ) {}

  /**
   * Spawn a Claude CLI process for the given workflow phase.
   *
   * Delegates command/args/env composition to AgentLauncher (ClaudeCodeLaunchPlugin),
   * captures stdout via the provided OutputCapture, and handles timeout / abort
   * with a SIGTERM -> grace period -> SIGKILL sequence.
   */
  async spawnPhase(
    phase: Exclude<WorkflowPhase, 'validate'>,
    options: CliSpawnOptions,
    capture: OutputCapture,
  ): Promise<PhaseResult> {
    this.logger.info(
      {
        phase,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        resumeSessionId: options.resumeSessionId ?? null,
      },
      options.resumeSessionId
        ? 'Resuming Claude CLI session for phase (via AgentLauncher)'
        : 'Spawning new Claude CLI session for phase (via AgentLauncher)',
    );

    const launchEnv: Record<string, string> = { ...options.env };
    if (options.siblingWorkdirs && Object.keys(options.siblingWorkdirs).length > 0) {
      launchEnv['GENERACY_SIBLING_WORKDIRS'] = JSON.stringify(options.siblingWorkdirs);
    }

    const handle = await this.agentLauncher.launch({
      intent: {
        kind: 'phase',
        phase,
        prompt: options.prompt,
        sessionId: options.resumeSessionId,
        ...(options.model !== undefined ? { model: options.model } : {}),
      },
      cwd: options.cwd,
      env: launchEnv,
      credentials: buildLaunchCredentials(this.credentialRole),
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
    });
    const child = handle.process;

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

    const intent: ShellIntent = { kind: 'shell', command: validateCommand };
    const handle = await this.agentLauncher.launch({
      intent,
      cwd: checkoutPath,
      env: {},
      credentials: buildLaunchCredentials(this.credentialRole),
    });

    return this.manageProcess(handle.process, phase, timeoutMs, signal, undefined);
  }

  /**
   * Run a dependency installation command before validation (e.g., `pnpm install`).
   *
   * Uses a shorter timeout (5 minutes) than the validate phase since install
   * should not take as long as running the full test/build suite.
   */
  async runPreValidateInstall(
    checkoutPath: string,
    installCommand: string,
    signal: AbortSignal,
  ): Promise<PhaseResult> {
    const phase: WorkflowPhase = 'validate';
    const timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS;

    this.logger.info(
      { phase, cwd: checkoutPath, installCommand, timeoutMs },
      'Spawning pre-validate install command',
    );

    const intent: ShellIntent = { kind: 'shell', command: installCommand };
    const handle = await this.agentLauncher.launch({
      intent,
      cwd: checkoutPath,
      env: {},
      credentials: buildLaunchCredentials(this.credentialRole),
    });

    return this.manageProcess(handle.process, phase, timeoutMs, signal, undefined);
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
    // #892: buffer raw stdout when no OutputCapture is attached — the
    // validate + install paths need it as evidence for the fix cycle.
    let stdoutBuffer = '';

    // ---- Merged stdout+stderr ring buffer (shell paths only) ----
    // #890: populated when capture is undefined. Chunks are appended in Node
    // `data`-event arrival order (best-effort per FR-004, Q5→A) into one Buffer.
    // The buffer holds at most RING_BYTES = 8192 bytes — older bytes are sliced off.
    // Feeds `error.output`; the separate stdout/stderr buffers above feed #892's
    // `capturedStdout`/`capturedStderr`.
    let outputRing = Buffer.alloc(0);
    const appendRing = (data: Buffer | string): void => {
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      outputRing = Buffer.concat([outputRing, buf]);
      if (outputRing.length > RING_BYTES) {
        outputRing = outputRing.subarray(outputRing.length - RING_BYTES);
      }
    };

    // ---- stdout ----
    if (child.stdout && capture) {
      child.stdout.on('data', (data: Buffer | string) => {
        capture.processChunk(typeof data === 'string' ? data : data.toString('utf-8'));
      });
    }

    // Shell paths (runValidatePhase, no OutputCapture): capture raw stdout for
    // two consumers — #890's merged evidence ring buffer (`error.output`) and
    // #892's raw `stdoutBuffer` feeding the ValidateFixHandler evidence
    // pipeline (bounded to a soft limit to avoid unbounded memory growth).
    const STDOUT_CAP_BYTES = 5 * 1024 * 1024; // 5 MiB
    if (child.stdout && !capture) {
      child.stdout.on('data', (data: Buffer | string) => {
        appendRing(data);
        if (stdoutBuffer.length < STDOUT_CAP_BYTES) {
          const chunk = typeof data === 'string' ? data : data.toString('utf-8');
          stdoutBuffer += chunk;
        }
      });
    }

    // ---- stderr ----
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer | string) => {
        // #892: raw stderr for `capturedStderr` (validate + install paths).
        stderrBuffer += typeof data === 'string' ? data : data.toString('utf-8');
        if (!capture) {
          // Shell path: interleave into the merged ring buffer.
          appendRing(data);
        }
        // CLI path: no ring buffer; stderr tail is not populated for CLI phases.
        // Their diagnostic surface is `PhaseResult.output` (parsed JSON events),
        // from which `buildErrorEvidence` synthesizes `outputTail` via
        // `synthesizeOutputTail` at evidence-build time.
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
      implementResult: capture?.implementResult,
      // #892: expose the raw non-CLI stdout/stderr for the validate-fix
      // evidence pipeline. Empty strings when OutputCapture was used.
      capturedStdout: capture ? undefined : stdoutBuffer,
      capturedStderr: stderrBuffer,
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
        output: capture ? '' : outputRing.toString('utf8'),
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
