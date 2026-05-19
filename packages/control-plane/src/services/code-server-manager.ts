import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export type CodeServerStatus = 'stopped' | 'starting' | 'running';

export interface CodeServerStartResult {
  status: 'starting' | 'running';
  socket_path: string;
}

export interface CodeServerManager {
  start(): Promise<CodeServerStartResult>;
  stop(): Promise<void>;
  touch(): void;
  getStatus(): CodeServerStatus;
  shutdown(): Promise<void>;
  onStatusChange(callback: (status: CodeServerStatus) => void): void;
}

export interface CodeServerManagerOptions {
  binPath: string;
  socketPath: string;
  idleTimeoutMs: number;
  userDataDir?: string;
  extensionsDir?: string;
  forceKillTimeoutMs?: number;
}

export const DEFAULT_CODE_SERVER_BIN = '/usr/local/bin/code-server';
export const DEFAULT_CODE_SERVER_SOCKET = '/run/generacy-control-plane/code-server.sock';
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function loadOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): CodeServerManagerOptions {
  const idleRaw = env['CODE_SERVER_IDLE_TIMEOUT_MS'];
  const idleTimeoutMs = idleRaw ? Number.parseInt(idleRaw, 10) : DEFAULT_IDLE_TIMEOUT_MS;

  const opts: CodeServerManagerOptions = {
    binPath: env['CODE_SERVER_BIN'] ?? DEFAULT_CODE_SERVER_BIN,
    socketPath: env['CODE_SERVER_SOCKET_PATH'] ?? DEFAULT_CODE_SERVER_SOCKET,
    idleTimeoutMs:
      Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 ? idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS,
  };
  if (env['CODE_SERVER_USER_DATA_DIR']) opts.userDataDir = env['CODE_SERVER_USER_DATA_DIR'];
  if (env['CODE_SERVER_EXTENSIONS_DIR']) opts.extensionsDir = env['CODE_SERVER_EXTENSIONS_DIR'];
  return opts;
}

export class CodeServerProcessManager implements CodeServerManager {
  private child: ChildProcess | null = null;
  private status: CodeServerStatus = 'stopped';
  private idleTimer: NodeJS.Timeout | null = null;
  private exitWaiters: Array<() => void> = [];
  private statusChangeCallback: ((status: CodeServerStatus) => void) | null = null;

  constructor(private readonly opts: CodeServerManagerOptions) {}

  onStatusChange(callback: (status: CodeServerStatus) => void): void {
    this.statusChangeCallback = callback;
  }

  getStatus(): CodeServerStatus {
    return this.status;
  }

  async start(): Promise<CodeServerStartResult> {
    if (this.child) {
      this.touch();
      return { status: this.status === 'running' ? 'running' : 'starting', socket_path: this.opts.socketPath };
    }

    await this.ensureSocketDir();
    await this.removeStaleSocket();

    const args = [
      '--socket', this.opts.socketPath,
      '--socket-mode', '0660',
      '--auth', 'none',
      '--disable-telemetry',
      '--disable-update-check',
    ];
    if (this.opts.userDataDir) args.push('--user-data-dir', this.opts.userDataDir);
    if (this.opts.extensionsDir) args.push('--extensions-dir', this.opts.extensionsDir);

    this.status = 'starting';
    const child = spawn(this.opts.binPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    child.on('exit', () => {
      this.child = null;
      this.status = 'stopped';
      this.clearIdleTimer();
      this.statusChangeCallback?.('stopped');
      const waiters = this.exitWaiters;
      this.exitWaiters = [];
      for (const w of waiters) w();
    });

    child.on('error', () => {
      this.child = null;
      this.status = 'stopped';
      this.clearIdleTimer();
      this.statusChangeCallback?.('stopped');
    });

    this.child = child;

    // Mark running once the socket appears (best-effort) and start the idle timer.
    this.waitForSocket().then(
      () => {
        if (this.child === child) {
          this.status = 'running';
          this.statusChangeCallback?.('running');
        }
      },
      () => {
        // socket never appeared; leave status as 'starting' until exit cleans up
      },
    );

    this.touch();
    return { status: 'starting', socket_path: this.opts.socketPath };
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    const child = this.child;
    if (!child) return;

    return new Promise<void>((resolve) => {
      this.exitWaiters.push(resolve);
      child.kill('SIGTERM');
      const forceKill = setTimeout(() => {
        if (this.child === child) {
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
        }
      }, this.opts.forceKillTimeoutMs ?? 5000);
      child.once('exit', () => clearTimeout(forceKill));
    });
  }

  touch(): void {
    if (!this.child) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.stop();
    }, this.opts.idleTimeoutMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async ensureSocketDir(): Promise<void> {
    const dir = path.dirname(this.opts.socketPath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // best-effort; spawn will fail loudly if the dir is unusable
    }
  }

  private async removeStaleSocket(): Promise<void> {
    try {
      await fs.unlink(this.opts.socketPath);
    } catch {
      // ENOENT is fine; other errors surface when the child tries to bind
    }
  }

  private async waitForSocket(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error('code-server exited before socket appeared');
      try {
        await fs.stat(this.opts.socketPath);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error(`code-server socket did not appear within ${timeoutMs}ms`);
  }
}

let manager: CodeServerManager | null = null;

export function getCodeServerManager(): CodeServerManager {
  if (!manager) {
    manager = new CodeServerProcessManager(loadOptionsFromEnv());
  }
  return manager;
}

export function setCodeServerManager(next: CodeServerManager | null): void {
  manager = next;
}
