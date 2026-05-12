import { spawn, type ChildProcess } from 'node:child_process';
import { getRelayPushEvent } from '../relay-events.js';

export type VsCodeTunnelStatus = 'stopped' | 'starting' | 'authorization_pending' | 'connected' | 'disconnected' | 'error';

export interface VsCodeTunnelStartResult {
  status: VsCodeTunnelStatus;
  tunnelName: string;
}

export interface VsCodeTunnelEvent {
  status: VsCodeTunnelStatus;
  deviceCode?: string;
  verificationUri?: string;
  tunnelName?: string;
  error?: string;
  details?: string;
}

export interface VsCodeTunnelManager {
  start(): Promise<VsCodeTunnelStartResult>;
  stop(): Promise<void>;
  getStatus(): VsCodeTunnelStatus;
  shutdown(): Promise<void>;
}

export interface VsCodeTunnelManagerOptions {
  binPath: string;
  tunnelName: string;
  forceKillTimeoutMs?: number;
  deviceCodeTimeoutMs?: number;
}

export const DEFAULT_VSCODE_CLI_BIN = '/usr/local/bin/code';
export const DEFAULT_DEVICE_CODE_TIMEOUT_MS = 30_000;
export const DEFAULT_FORCE_KILL_TIMEOUT_MS = 5_000;

const DEVICE_CODE_PATTERN = /([A-Z0-9]{4}-[A-Z0-9]{4})/;
const VERIFICATION_URI_PATTERN = /https:\/\/github\.com\/login\/device/;
const CONNECTED_PATTERN = /is connected|tunnel is ready/i;

export function loadOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): VsCodeTunnelManagerOptions {
  const tunnelName = env['GENERACY_CLUSTER_ID'];
  if (!tunnelName) throw new Error('GENERACY_CLUSTER_ID is required for VS Code tunnel');

  return {
    binPath: env['VSCODE_CLI_BIN'] ?? DEFAULT_VSCODE_CLI_BIN,
    tunnelName,
  };
}

function emitTunnelEvent(payload: VsCodeTunnelEvent): void {
  const pushEvent = getRelayPushEvent();
  if (pushEvent) pushEvent('cluster.vscode-tunnel', payload);
}

export class VsCodeTunnelProcessManager implements VsCodeTunnelManager {
  private child: ChildProcess | null = null;
  private status: VsCodeTunnelStatus = 'stopped';
  private exitWaiters: Array<() => void> = [];
  private deviceCodeTimer: NodeJS.Timeout | null = null;
  private stdoutBuffer: string[] = [];
  private deviceCode: string | null = null;
  private verificationUri: string | null = null;

  constructor(private readonly opts: VsCodeTunnelManagerOptions) {}

  getStatus(): VsCodeTunnelStatus {
    return this.status;
  }

  async start(): Promise<VsCodeTunnelStartResult> {
    if (this.child) {
      if (this.status === 'authorization_pending' && this.deviceCode) {
        emitTunnelEvent({
          status: 'authorization_pending',
          deviceCode: this.deviceCode,
          verificationUri: this.verificationUri ?? 'https://github.com/login/device',
          tunnelName: this.opts.tunnelName,
        });
      } else if (this.status === 'connected') {
        emitTunnelEvent({ status: 'connected', tunnelName: this.opts.tunnelName });
      }
      return { status: this.status, tunnelName: this.opts.tunnelName };
    }

    this.status = 'starting';
    this.stdoutBuffer = [];
    emitTunnelEvent({ status: 'starting', tunnelName: this.opts.tunnelName });

    const args = [
      'tunnel',
      '--accept-server-license-terms',
      '--name', this.opts.tunnelName,
    ];

    const child = spawn(this.opts.binPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    child.on('exit', () => {
      const wasConnected = this.status === 'connected';
      this.child = null;
      this.clearDeviceCodeTimer();
      this.deviceCode = null;
      this.verificationUri = null;

      if (wasConnected) {
        this.status = 'disconnected';
        emitTunnelEvent({ status: 'disconnected', tunnelName: this.opts.tunnelName });
      } else {
        this.status = 'stopped';
      }

      const waiters = this.exitWaiters;
      this.exitWaiters = [];
      for (const w of waiters) w();
    });

    child.on('error', () => {
      this.child = null;
      this.status = 'error';
      this.clearDeviceCodeTimer();
      this.deviceCode = null;
      this.verificationUri = null;
      emitTunnelEvent({ status: 'error', error: 'Failed to spawn VS Code CLI process' });
    });

    this.child = child;

    // Parse stdout line-by-line for device code and connection status
    let partial = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      partial += chunk.toString();
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        this.handleStdoutLine(line, child);
      }
    });

    child.stderr?.on('data', () => {
      // drain stderr to prevent backpressure
    });

    // Set device code timeout
    const timeoutMs = this.opts.deviceCodeTimeoutMs ?? DEFAULT_DEVICE_CODE_TIMEOUT_MS;
    this.deviceCodeTimer = setTimeout(() => {
      if (this.status === 'starting') {
        this.status = 'error';
        const last20 = this.stdoutBuffer.slice(-20).join('\n');
        emitTunnelEvent({
          status: 'error',
          error: 'Timed out waiting for device code',
          details: last20 || undefined,
        });
      }
    }, timeoutMs);
    if (typeof this.deviceCodeTimer.unref === 'function') this.deviceCodeTimer.unref();

    return { status: 'starting', tunnelName: this.opts.tunnelName };
  }

  async stop(): Promise<void> {
    this.clearDeviceCodeTimer();
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
      }, this.opts.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS);
      child.once('exit', () => clearTimeout(forceKill));
    });
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  private handleStdoutLine(line: string, child: ChildProcess): void {
    this.stdoutBuffer.push(line);
    // Keep buffer bounded
    if (this.stdoutBuffer.length > 50) this.stdoutBuffer.shift();

    // Check for device code
    if (this.status === 'starting' || this.status === 'authorization_pending') {
      const codeMatch = line.match(DEVICE_CODE_PATTERN);
      const uriMatch = line.match(VERIFICATION_URI_PATTERN);

      if (codeMatch && this.status === 'starting') {
        this.clearDeviceCodeTimer();
        this.status = 'authorization_pending';
        this.deviceCode = codeMatch[1];
        this.verificationUri = 'https://github.com/login/device';
        emitTunnelEvent({
          status: 'authorization_pending',
          deviceCode: this.deviceCode,
          verificationUri: this.verificationUri,
          tunnelName: this.opts.tunnelName,
        });
      } else if (uriMatch && this.status === 'starting') {
        // URI seen before code — we might get the code on a subsequent line
        // Don't transition yet, but clear the timer since we're making progress
        this.clearDeviceCodeTimer();
      }
    }

    // Check for connected status
    if (this.child === child && CONNECTED_PATTERN.test(line)) {
      this.clearDeviceCodeTimer();
      this.status = 'connected';
      this.deviceCode = null;
      this.verificationUri = null;
      emitTunnelEvent({ status: 'connected', tunnelName: this.opts.tunnelName });
    }
  }

  private clearDeviceCodeTimer(): void {
    if (this.deviceCodeTimer) {
      clearTimeout(this.deviceCodeTimer);
      this.deviceCodeTimer = null;
    }
  }
}

let manager: VsCodeTunnelManager | null = null;

export function getVsCodeTunnelManager(): VsCodeTunnelManager {
  if (!manager) {
    manager = new VsCodeTunnelProcessManager(loadOptionsFromEnv());
  }
  return manager;
}

export function setVsCodeTunnelManager(next: VsCodeTunnelManager | null): void {
  manager = next;
}
