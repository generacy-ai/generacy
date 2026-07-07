import { spawn, type ChildProcess } from "node:child_process";
import { getRelayPushEvent } from "../relay-events.js";

export type VsCodeTunnelStatus =
  | "stopped"
  | "starting"
  | "authorization_pending"
  | "connected"
  | "disconnected"
  | "error";

export interface VsCodeTunnelStartResult {
  status: VsCodeTunnelStatus;
  tunnelName: string;
}

export interface VsCodeTunnelEvent {
  status: VsCodeTunnelStatus;
  deviceCode?: string;
  verificationUri?: string;
  tunnelName?: string;
  tunnelUrl?: string;
  error?: string;
  details?: string;
}

export interface VsCodeTunnelManager {
  start(): Promise<VsCodeTunnelStartResult>;
  stop(): Promise<void>;
  unregister(): Promise<void>;
  getStatus(): VsCodeTunnelStatus;
  shutdown(): Promise<void>;
}

export interface VsCodeTunnelManagerOptions {
  binPath: string;
  tunnelName: string;
  forceKillTimeoutMs?: number;
  deviceCodeTimeoutMs?: number;
}

export const DEFAULT_VSCODE_CLI_BIN = "/usr/local/bin/code";
export const DEFAULT_DEVICE_CODE_TIMEOUT_MS = 30_000;
export const DEFAULT_FORCE_KILL_TIMEOUT_MS = 5_000;

const DEVICE_CODE_PATTERN = /([A-Z0-9]{4}-[A-Z0-9]{4})/;
const VERIFICATION_URI_PATTERN = /https:\/\/github\.com\/login\/device/;
const CONNECTED_PATTERN =
  /https:\/\/vscode\.dev\/tunnel\/[\w-]+|is connected|tunnel is ready/i;
const TUNNEL_URL_PATTERN = /(https:\/\/vscode\.dev\/tunnel\/[\w-]+[\w\-/]*)/;

/**
 * Derive a VS Code tunnel name from a cluster UUID.
 *
 * Microsoft's tunnel service requires names to satisfy
 * `/^[a-z][a-z0-9-]{0,19}$/` (≤20 chars, lowercase, letter-initial,
 * `[a-z0-9-]`). UUIDs are 36 chars and hyphens are stripped before slicing.
 *
 * Per-cluster derivation is required for multi-cluster support (#744 FR-001).
 * Using the stable project id (the #618 fix) collided whenever a single
 * project had more than one cluster; cloud-side per-cluster persistence
 * (generacy-cloud#792, merge:true #563) makes the cluster UUID the right key.
 */
export function deriveTunnelName(clusterId: string): string {
  const compact = clusterId.replace(/-/g, "");
  const out = `g-${compact.slice(0, 18)}`;
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(out)) {
    throw new Error(`Derived tunnel name "${out}" violates Microsoft tunnel constraints`);
  }
  return out;
}

export function loadOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): VsCodeTunnelManagerOptions {
  // Cluster UUID source (reverted from #618). Multi-cluster per project
  // (#744 FR-001/FR-002) requires per-cluster tunnel names; project-id
  // derivation collided across siblings. Cloud-side per-cluster persistence
  // (generacy-cloud#792 + merge:true #563) keeps each cluster's tunnel name
  // stable across activations of THAT cluster.
  const id = env["GENERACY_CLUSTER_ID"];
  if (!id)
    throw new Error("GENERACY_CLUSTER_ID is required for VS Code tunnel");

  return {
    binPath: env["VSCODE_CLI_BIN"] ?? DEFAULT_VSCODE_CLI_BIN,
    tunnelName: deriveTunnelName(id),
  };
}

function emitTunnelEvent(payload: VsCodeTunnelEvent): void {
  const pushEvent = getRelayPushEvent();
  if (pushEvent) pushEvent("cluster.vscode-tunnel", payload);
}

export class VsCodeTunnelProcessManager implements VsCodeTunnelManager {
  private child: ChildProcess | null = null;
  private status: VsCodeTunnelStatus = "stopped";
  private exitWaiters: Array<() => void> = [];
  private deviceCodeTimer: NodeJS.Timeout | null = null;
  private stdoutBuffer: string[] = [];
  private deviceCode: string | null = null;
  private verificationUri: string | null = null;
  private tunnelUrl: string | null = null;
  // The name `code tunnel` actually registered. It can differ from the
  // requested `opts.tunnelName`: if that name is already taken (e.g. a stale
  // registration left behind by a previously-deleted Droplet for the same
  // project — the name is derived from the stable project id, see #618), the
  // CLI silently falls back to a random name. We must report THIS name so the
  // cloud/UI deep-links to the tunnel that's actually running, not the dead one.
  private actualTunnelName: string | null = null;
  private stopping = false;
  // Set by the device-code timeout handler before it kills the child so the
  // exit handler can suppress the wasPending `error` emit. Cleared at the top
  // of the exit handler alongside `stopping` so a stale value cannot leak.
  private timedOut = false;

  constructor(private readonly opts: VsCodeTunnelManagerOptions) {}

  /** Extract the registered tunnel name from a `https://vscode.dev/tunnel/<name>/…` URL. */
  private tunnelNameFromUrl(url: string | null): string | null {
    return url?.match(/vscode\.dev\/tunnel\/([\w-]+)/)?.[1] ?? null;
  }

  getStatus(): VsCodeTunnelStatus {
    return this.status;
  }

  async start(): Promise<VsCodeTunnelStartResult> {
    if (this.child) {
      // Defense-in-depth (FR-003): if some code path has left a stale child
      // behind alongside a resting-error status, don't early-return — SIGTERM
      // the stale child (via stop(), which handles SIGKILL backstop) and fall
      // through to a fresh spawn. `await` guarantees no two `code tunnel
      // --name <same>` processes ever overlap (#743).
      if (
        this.status === "error" ||
        this.status === "disconnected" ||
        this.status === "stopped"
      ) {
        await this.stop();
        // fall through to the fresh-spawn path below
      } else {
        if (this.status === "authorization_pending" && this.deviceCode) {
          emitTunnelEvent({
            status: "authorization_pending",
            deviceCode: this.deviceCode,
            verificationUri:
              this.verificationUri ?? "https://github.com/login/device",
            tunnelName: this.opts.tunnelName,
          });
        } else if (this.status === "connected") {
          emitTunnelEvent({
            status: "connected",
            tunnelName: this.actualTunnelName ?? this.opts.tunnelName,
            tunnelUrl: this.tunnelUrl ?? undefined,
          });
        }
        return {
          status: this.status,
          tunnelName: this.actualTunnelName ?? this.opts.tunnelName,
        };
      }
    }

    this.status = "starting";
    this.stdoutBuffer = [];
    emitTunnelEvent({ status: "starting", tunnelName: this.opts.tunnelName });

    const args = [
      "tunnel",
      "--accept-server-license-terms",
      "--name",
      this.opts.tunnelName,
    ];

    const child = spawn(this.opts.binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    child.on("exit", (code) => {
      const wasConnected = this.status === "connected";
      const wasPending =
        this.status === "authorization_pending" || this.status === "starting";
      const stopInitiated = this.stopping;
      const timedOut = this.timedOut;
      this.stopping = false;
      this.timedOut = false;
      this.child = null;
      this.clearDeviceCodeTimer();
      this.deviceCode = null;
      this.verificationUri = null;
      this.tunnelUrl = null;
      this.actualTunnelName = null;

      if (stopInitiated) {
        this.status = "stopped";
      } else if (timedOut) {
        // Device-code timeout initiated this exit. status was already set to
        // "error" and the single `error` event was emitted by the timeout
        // handler; suppress the wasPending duplicate emit.
      } else if (wasConnected) {
        this.status = "disconnected";
        emitTunnelEvent({
          status: "disconnected",
          tunnelName: this.opts.tunnelName,
        });
      } else if (wasPending) {
        this.status = "error";
        const last20 = this.stdoutBuffer.slice(-20).join("\n");
        emitTunnelEvent({
          status: "error",
          error: `code tunnel exited (code ${code}) before reaching connected state`,
          details: last20 || undefined,
          tunnelName: this.opts.tunnelName,
        });
      } else {
        this.status = "stopped";
      }

      const waiters = this.exitWaiters;
      this.exitWaiters = [];
      for (const w of waiters) w();
    });

    child.on("error", () => {
      this.child = null;
      this.status = "error";
      this.clearDeviceCodeTimer();
      this.deviceCode = null;
      this.verificationUri = null;
      emitTunnelEvent({
        status: "error",
        error: "Failed to spawn VS Code CLI process",
      });
    });

    this.child = child;

    // Parse stdout line-by-line for device code and connection status
    let partial = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      partial += chunk.toString();
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        this.handleStdoutLine(line, child);
      }
    });

    child.stderr?.on("data", () => {
      // drain stderr to prevent backpressure
    });

    // Set device code timeout
    const timeoutMs =
      this.opts.deviceCodeTimeoutMs ?? DEFAULT_DEVICE_CODE_TIMEOUT_MS;
    this.deviceCodeTimer = setTimeout(() => {
      if (this.status === "starting") {
        this.status = "error";
        const last20 = this.stdoutBuffer.slice(-20).join("\n");
        emitTunnelEvent({
          status: "error",
          error: "Timed out waiting for device code",
          details: last20 || undefined,
          tunnelName: this.opts.tunnelName,
        });
        // Kill the child so the exit handler can clear `this.child`, otherwise
        // every subsequent start() (the Restart button) will hit the early-
        // return with a live `this.child` and silently no-op. `timedOut`
        // routes the exit-handler cascade past the wasPending branch so we
        // don't emit a second, misleading "code tunnel exited (code N)" event.
        this.timedOut = true;
        this.child?.kill("SIGTERM");
        const forceKillMs =
          this.opts.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS;
        const forceKillTimer = setTimeout(() => {
          try {
            this.child?.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, forceKillMs);
        if (typeof forceKillTimer.unref === "function") forceKillTimer.unref();
      }
    }, timeoutMs);
    if (typeof this.deviceCodeTimer.unref === "function")
      this.deviceCodeTimer.unref();

    return { status: "starting", tunnelName: this.opts.tunnelName };
  }

  async stop(): Promise<void> {
    this.clearDeviceCodeTimer();
    const child = this.child;
    if (!child) return;

    this.stopping = true;
    return new Promise<void>((resolve) => {
      this.exitWaiters.push(resolve);
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (this.child === child) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
      }, this.opts.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS);
      child.once("exit", () => clearTimeout(forceKill));
    });
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * Release the cluster's tunnel name from Microsoft's tunnel service so the
   * name can be reused after `generacy destroy`. Best-effort: spawns
   * `code tunnel unregister --name <tunnelName>` with a 10s timeout. On
   * timeout or non-zero exit, emits a warning event and resolves; never throws.
   */
  async unregister(): Promise<void> {
    const args = ["tunnel", "unregister", "--name", this.opts.tunnelName];
    const child = spawn(this.opts.binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});

    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };

      const killTimer = setTimeout(() => {
        emitTunnelEvent({
          status: "error",
          error: "tunnel unregister timed out",
          tunnelName: this.opts.tunnelName,
        });
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        settle();
      }, 10_000);
      if (typeof killTimer.unref === "function") killTimer.unref();

      child.once("exit", (code) => {
        if (code !== 0) {
          emitTunnelEvent({
            status: "error",
            error: `tunnel unregister exited with code ${code}`,
            tunnelName: this.opts.tunnelName,
          });
        }
        settle();
      });

      child.once("error", (err) => {
        emitTunnelEvent({
          status: "error",
          error: `tunnel unregister failed: ${err.message}`,
          tunnelName: this.opts.tunnelName,
        });
        settle();
      });
    });
  }

  private handleStdoutLine(line: string, child: ChildProcess): void {
    this.stdoutBuffer.push(line);
    // Keep buffer bounded
    if (this.stdoutBuffer.length > 50) this.stdoutBuffer.shift();

    // Check for device code
    if (this.status === "starting" || this.status === "authorization_pending") {
      const codeMatch = line.match(DEVICE_CODE_PATTERN);
      const uriMatch = line.match(VERIFICATION_URI_PATTERN);

      if (codeMatch && this.status === "starting") {
        this.clearDeviceCodeTimer();
        this.status = "authorization_pending";
        this.deviceCode = codeMatch[1] ?? null;
        this.verificationUri = "https://github.com/login/device";
        emitTunnelEvent({
          status: "authorization_pending",
          deviceCode: this.deviceCode ?? undefined,
          verificationUri: this.verificationUri,
          tunnelName: this.opts.tunnelName,
        });
      } else if (uriMatch && this.status === "starting") {
        // URI seen before code — we might get the code on a subsequent line
        // Don't transition yet, but clear the timer since we're making progress
        this.clearDeviceCodeTimer();
      }
    }

    // Check for connected status
    if (this.child === child && CONNECTED_PATTERN.test(line)) {
      this.clearDeviceCodeTimer();
      this.status = "connected";
      this.deviceCode = null;
      this.verificationUri = null;
      const urlMatch = line.match(TUNNEL_URL_PATTERN);
      this.tunnelUrl = urlMatch?.[1] ?? null;
      // Prefer the name parsed from the actual tunnel URL — `code tunnel` may
      // have fallen back to a random name when the requested name was taken.
      this.actualTunnelName = this.tunnelNameFromUrl(this.tunnelUrl);
      emitTunnelEvent({
        status: "connected",
        tunnelName: this.actualTunnelName ?? this.opts.tunnelName,
        tunnelUrl: this.tunnelUrl ?? undefined,
      });
      // Observational: surface tunnel-name collisions (#744 FR-012).
      // `g-<uuid18>` collisions are vanishingly rare (~2^-72) but possible via
      // a stale registration of the same cluster id. We emit a clear error
      // event with both names so the cloud/UI can resolve to the actual
      // running tunnel. Does NOT abort the tunnel.
      if (
        this.actualTunnelName &&
        this.actualTunnelName !== this.opts.tunnelName
      ) {
        emitTunnelEvent({
          status: "error",
          error: "tunnel name collision",
          tunnelName: this.actualTunnelName,
          details: `requested=${this.opts.tunnelName} actual=${this.actualTunnelName}`,
        });
      }
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
