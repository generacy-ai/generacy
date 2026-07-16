import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------
const { spawnMock } = vi.hoisted(() => {
  const spawnMock = vi.fn();
  return { spawnMock };
});

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

// ---------------------------------------------------------------------------
// Mock relay-events
// ---------------------------------------------------------------------------
const { getRelayPushEventMock } = vi.hoisted(() => {
  const getRelayPushEventMock = vi.fn();
  return { getRelayPushEventMock };
});

vi.mock("../src/relay-events.js", () => ({
  getRelayPushEvent: getRelayPushEventMock,
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------
import {
  VsCodeTunnelProcessManager,
  loadOptionsFromEnv,
  deriveTunnelName,
  DEFAULT_VSCODE_CLI_BIN,
  type VsCodeTunnelManagerOptions,
  type VsCodeTunnelEvent,
} from "../src/services/vscode-tunnel-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createMockChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

/** Emit a complete line of stdout output (appends newline). */
function pushLine(
  child: ReturnType<typeof createMockChild>,
  line: string
): void {
  child.stdout.emit("data", Buffer.from(line + "\n"));
}

function defaultOpts(
  overrides?: Partial<VsCodeTunnelManagerOptions>
): VsCodeTunnelManagerOptions {
  return {
    binPath: "/usr/local/bin/code",
    tunnelName: "test-cluster",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("VsCodeTunnelProcessManager", () => {
  let pushEventFn: ReturnType<typeof vi.fn>;
  let relayEvents: Array<{ channel: string; payload: VsCodeTunnelEvent }>;

  beforeEach(() => {
    relayEvents = [];
    pushEventFn = vi.fn((channel: string, payload: VsCodeTunnelEvent) => {
      relayEvents.push({ channel, payload });
    });
    getRelayPushEventMock.mockReturnValue(pushEventFn);

    // Full reset (not just clear) so that any `mockReturnValueOnce` queue
    // residue from a previous test does not leak into this test's spawn.
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createMockChild());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. State machine transitions: stopped -> starting -> authorization_pending -> connected
  // -------------------------------------------------------------------------
  describe("state machine transitions", () => {
    it("starts in stopped state", () => {
      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      expect(mgr.getStatus()).toBe("stopped");
    });

    it("transitions from stopped to starting on start()", async () => {
      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      const result = await mgr.start();

      expect(result.status).toBe("starting");
      expect(result.tunnelName).toBe("test-cluster");
      expect(mgr.getStatus()).toBe("starting");
    });

    it("transitions stopped -> starting -> authorization_pending -> connected", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      expect(mgr.getStatus()).toBe("stopped");

      await mgr.start();
      expect(mgr.getStatus()).toBe("starting");

      // Emit a line containing a device code
      pushLine(
        child,
        "To grant access, please log in to https://github.com/login/device and use code AB12-CD34"
      );
      expect(mgr.getStatus()).toBe("authorization_pending");

      // Emit a line indicating connection
      pushLine(child, "Tunnel is ready and is connected");
      expect(mgr.getStatus()).toBe("connected");
    });

    it("spawns with correct arguments", async () => {
      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ binPath: "/custom/code" })
      );
      await mgr.start();

      expect(spawnMock).toHaveBeenCalledWith(
        "/custom/code",
        ["tunnel", "--accept-server-license-terms", "--name", "test-cluster"],
        { stdio: ["ignore", "pipe", "pipe"], detached: false }
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Device code parsing from stdout (XXXX-XXXX pattern)
  // -------------------------------------------------------------------------
  describe("device code parsing", () => {
    it("parses XXXX-XXXX device code from stdout", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(
        child,
        "Open https://github.com/login/device and enter code ABCD-1234"
      );

      expect(mgr.getStatus()).toBe("authorization_pending");
      expect(relayEvents).toContainEqual({
        channel: "cluster.vscode-tunnel",
        payload: {
          status: "authorization_pending",
          deviceCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          tunnelName: "test-cluster",
        },
      });
    });

    it("parses device code with all-uppercase letters and digits", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, "Your device code: XY99-Z0A1");

      expect(mgr.getStatus()).toBe("authorization_pending");
      const authEvent = relayEvents.find(
        (e) => e.payload.status === "authorization_pending"
      );
      expect(authEvent?.payload.deviceCode).toBe("XY99-Z0A1");
    });

    it("handles multi-chunk stdout data correctly", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      // Push partial line then complete it in two data events
      child.stdout.emit("data", Buffer.from("Use code AA"));
      child.stdout.emit("data", Buffer.from("BB-CC11\n"));

      expect(mgr.getStatus()).toBe("authorization_pending");
      const authEvent = relayEvents.find(
        (e) => e.payload.status === "authorization_pending"
      );
      expect(authEvent?.payload.deviceCode).toBe("AABB-CC11");
    });
  });

  // -------------------------------------------------------------------------
  // 3. 30s timeout without device code -> error state with details
  // -------------------------------------------------------------------------
  describe("device code timeout", () => {
    it("transitions to error state after deviceCodeTimeoutMs without device code", async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ deviceCodeTimeoutMs: 30_000 })
      );
      await mgr.start();

      expect(mgr.getStatus()).toBe("starting");

      // Push some stdout lines (but no device code)
      pushLine(child, "Initializing tunnel...");
      pushLine(child, "Looking for existing tunnel...");

      // Advance past the timeout
      vi.advanceTimersByTime(30_000);

      expect(mgr.getStatus()).toBe("error");
      const errorEvent = relayEvents.find((e) => e.payload.status === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.payload.error).toBe(
        "Timed out waiting for device code"
      );
      expect(errorEvent?.payload.details).toContain("Initializing tunnel...");
    });

    it("includes last 20 lines of stdout in error details", async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ deviceCodeTimeoutMs: 100 })
      );
      await mgr.start();

      // Push 25 lines to exceed the 20-line detail limit
      for (let i = 0; i < 25; i++) {
        pushLine(child, `log line ${i}`);
      }

      vi.advanceTimersByTime(100);

      const errorEvent = relayEvents.find((e) => e.payload.status === "error");
      expect(errorEvent?.payload.details).toBeDefined();
      // The stdoutBuffer keeps 50 but details shows last 20
      const detailLines = errorEvent!.payload.details!.split("\n");
      expect(detailLines).toHaveLength(20);
      expect(detailLines[0]).toBe("log line 5");
      expect(detailLines[19]).toBe("log line 24");
    });

    it("does not timeout if device code is received in time", async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ deviceCodeTimeoutMs: 1000 })
      );
      await mgr.start();

      // Receive device code before timeout
      pushLine(child, "Code: AAAA-BBBB");
      expect(mgr.getStatus()).toBe("authorization_pending");

      // Advance past the timeout
      vi.advanceTimersByTime(2000);

      // Should still be authorization_pending, not error
      expect(mgr.getStatus()).toBe("authorization_pending");
    });

    it("emits error with undefined details when stdout buffer is empty", async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ deviceCodeTimeoutMs: 50 })
      );
      await mgr.start();

      vi.advanceTimersByTime(50);

      const errorEvent = relayEvents.find((e) => e.payload.status === "error");
      expect(errorEvent?.payload.details).toBeUndefined();
    });

    // T002: FR-001 — timeout handler must SIGTERM the child so this.child is
    // eventually cleared by the exit handler and Restart can respawn.
    it("kills the child with SIGTERM after device code timeout (FR-001)", async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ deviceCodeTimeoutMs: 30_000 })
      );
      await mgr.start();

      vi.advanceTimersByTime(30_000);

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    // T003: FR-005, SC-002, Q3→A — exactly ONE error event with the timeout
    // message and tunnelName. The "code tunnel exited (code N)…" text (from the
    // exit handler's wasPending branch) must NOT appear.
    it("emits exactly one error event with timeout message and tunnelName (FR-005, SC-002)", async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ deviceCodeTimeoutMs: 100 })
      );
      await mgr.start();
      pushLine(child, "Initializing tunnel...");

      vi.advanceTimersByTime(100);

      const errorEvents = relayEvents.filter(
        (e) => e.payload.status === "error"
      );
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].payload.error).toBe(
        "Timed out waiting for device code"
      );
      expect(errorEvents[0].payload.tunnelName).toBe("test-cluster");
      // The wasPending exit-handler text must NOT be present on the timeout path:
      const anyPendingExitText = relayEvents.some((e) =>
        (e.payload.error ?? "").includes(
          "code tunnel exited"
        )
      );
      expect(anyPendingExitText).toBe(false);
    });

    // T004: FR-002, SC-002 — after the timeout-initiated kill, the child's
    // exit must not produce a second error event (wasPending branch suppressed).
    it("does not emit a second error event when child exits after timeout (FR-002)", async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ deviceCodeTimeoutMs: 100 })
      );
      await mgr.start();

      vi.advanceTimersByTime(100);
      const errorCountAfterTimeout = relayEvents.filter(
        (e) => e.payload.status === "error"
      ).length;

      // Simulate the child exiting in response to SIGTERM:
      child.emit("exit", 0);

      const errorCountAfterExit = relayEvents.filter(
        (e) => e.payload.status === "error"
      ).length;
      expect(errorCountAfterExit).toBe(errorCountAfterTimeout);
    });

    // T005: FR-004 — resting status after timeout + exit is "error" (not
    // "stopped"). A device-code timeout is a real failure and must remain
    // observable via getStatus().
    it("keeps status as 'error' after timeout + exit settles (FR-004)", async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ deviceCodeTimeoutMs: 100 })
      );
      await mgr.start();

      vi.advanceTimersByTime(100);
      child.emit("exit", 0);

      expect(mgr.getStatus()).toBe("error");
    });

    // T006: SC-001 — Restart-button recovery. After the timeout cascade
    // settles, a second start() must spawn a fresh child.
    it("subsequent start() after settled timeout spawns a new child (SC-001)", async () => {
      vi.useFakeTimers();

      const child1 = createMockChild();
      const child2 = createMockChild();
      spawnMock
        .mockReturnValueOnce(child1)
        .mockReturnValueOnce(child2);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ deviceCodeTimeoutMs: 100 })
      );
      await mgr.start();

      vi.advanceTimersByTime(100);
      child1.emit("exit", 0);

      // The "Restart tunnel" click:
      await mgr.start();

      expect(spawnMock).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // 4. stop() sends SIGTERM then SIGKILL after forceKillTimeoutMs
  // -------------------------------------------------------------------------
  describe("stop()", () => {
    it("sends SIGTERM to the child process", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      // Start stop, then simulate process exit
      const stopPromise = mgr.stop();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      // Simulate process exiting
      child.emit("exit");
      await stopPromise;
    });

    it("sends SIGKILL after forceKillTimeoutMs if process does not exit", async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ forceKillTimeoutMs: 200 })
      );
      await mgr.start();

      const stopPromise = mgr.stop();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

      // Advance past the force kill timeout
      vi.advanceTimersByTime(200);

      expect(child.kill).toHaveBeenCalledWith("SIGKILL");

      // Now the process exits
      child.emit("exit");
      await stopPromise;
    });

    it("does not SIGKILL if process exits before forceKillTimeoutMs", async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ forceKillTimeoutMs: 5000 })
      );
      await mgr.start();

      const stopPromise = mgr.stop();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      // Process exits quickly
      child.emit("exit");
      await stopPromise;

      // Advance time -- SIGKILL should never have been called
      vi.advanceTimersByTime(5000);
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    });

    it("is a no-op when not running", async () => {
      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await expect(mgr.stop()).resolves.toBeUndefined();
    });

    it("sets status to stopped after stop when not connected", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      const stopPromise = mgr.stop();
      child.emit("exit");
      await stopPromise;

      expect(mgr.getStatus()).toBe("stopped");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Relay event emission
  // -------------------------------------------------------------------------
  describe("relay event emission", () => {
    it("emits starting event on start()", async () => {
      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      expect(relayEvents[0]).toEqual({
        channel: "cluster.vscode-tunnel",
        payload: { status: "starting", tunnelName: "test-cluster" },
      });
    });

    it("emits authorization_pending event with device code", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(
        child,
        "Enter code WXYZ-9876 at https://github.com/login/device"
      );

      expect(relayEvents[1]).toEqual({
        channel: "cluster.vscode-tunnel",
        payload: {
          status: "authorization_pending",
          deviceCode: "WXYZ-9876",
          verificationUri: "https://github.com/login/device",
          tunnelName: "test-cluster",
        },
      });
    });

    it("emits connected event when tunnel is ready", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, "ABCD-EF12");
      pushLine(child, "Tunnel is ready and is connected");

      const connectedEvent = relayEvents.find(
        (e) => e.payload.status === "connected"
      );
      expect(connectedEvent).toEqual({
        channel: "cluster.vscode-tunnel",
        payload: { status: "connected", tunnelName: "test-cluster" },
      });
    });

    it("reports the ACTUAL tunnel name from the URL when the requested name was taken", async () => {
      // Regression: when the requested --name is already taken (stale
      // registration from a prior Droplet for the same project), `code tunnel`
      // falls back to a random name. We must report that actual name (parsed
      // from the connection URL) so the cloud/UI deep-links to the live tunnel,
      // not the dead one.
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      const startResult = await mgr.start();
      expect(startResult.tunnelName).toBe("test-cluster"); // requested name pre-connect

      pushLine(
        child,
        "Open this link in your browser https://vscode.dev/tunnel/9ac46a6bef24/workspaces"
      );

      const connectedEvent = relayEvents.find(
        (e) => e.payload.status === "connected"
      );
      expect(connectedEvent).toEqual({
        channel: "cluster.vscode-tunnel",
        payload: {
          status: "connected",
          tunnelName: "9ac46a6bef24",
          tunnelUrl: "https://vscode.dev/tunnel/9ac46a6bef24/workspaces",
        },
      });
    });

    it("emits a tunnel-name collision error when actual differs from requested (FR-012)", async () => {
      // Regression: when the requested --name was already taken, the actual
      // tunnel name parsed from vscode.dev/tunnel/<x> differs. We must emit
      // a clear error event so the cloud/UI can resolve the discrepancy
      // (observational only — does NOT abort the tunnel).
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(
        child,
        "Open this link in your browser https://vscode.dev/tunnel/9ac46a6bef24/workspaces"
      );

      const collisionEvent = relayEvents.find(
        (e) =>
          e.payload.status === "error" &&
          e.payload.error === "tunnel name collision"
      );
      expect(collisionEvent).toBeDefined();
      expect(collisionEvent?.payload.tunnelName).toBe("9ac46a6bef24");
      expect(collisionEvent?.payload.details).toContain("requested=test-cluster");
      expect(collisionEvent?.payload.details).toContain("actual=9ac46a6bef24");
    });

    it("does NOT emit a collision error when actual matches requested", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(
        child,
        "Open this link in your browser https://vscode.dev/tunnel/test-cluster/workspaces"
      );

      const collisionEvent = relayEvents.find(
        (e) =>
          e.payload.status === "error" &&
          e.payload.error === "tunnel name collision"
      );
      expect(collisionEvent).toBeUndefined();
    });

    it("emits disconnected event when connected process exits", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, "QWER-TYUI");
      pushLine(child, "Tunnel is ready and is connected");
      child.emit("exit");

      const disconnectedEvent = relayEvents.find(
        (e) => e.payload.status === "disconnected"
      );
      expect(disconnectedEvent).toEqual({
        channel: "cluster.vscode-tunnel",
        payload: { status: "disconnected", tunnelName: "test-cluster" },
      });
    });

    it("emits error event on spawn error", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      child.emit("error", new Error("spawn failed"));

      const errorEvent = relayEvents.find((e) => e.payload.status === "error");
      expect(errorEvent).toEqual({
        channel: "cluster.vscode-tunnel",
        payload: {
          status: "error",
          error: "Failed to spawn VS Code CLI process",
        },
      });
    });

    it("does not emit events when relay push function is not available", async () => {
      getRelayPushEventMock.mockReturnValue(undefined);

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      // Should not throw even with no push function
      pushLine(child, "Enter code AAAA-BBBB");
      expect(pushEventFn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 6. start() when already running returns current status
  // -------------------------------------------------------------------------
  describe("start() idempotency", () => {
    it("returns current status without spawning again when already running", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      const first = await mgr.start();
      expect(first.status).toBe("starting");
      expect(spawnMock).toHaveBeenCalledTimes(1);

      // Move to authorization_pending
      pushLine(child, "Code: ZZZZ-YYYY");
      expect(mgr.getStatus()).toBe("authorization_pending");

      // Second start() should return current status without new spawn
      const second = await mgr.start();
      expect(second.status).toBe("authorization_pending");
      expect(second.tunnelName).toBe("test-cluster");
      expect(spawnMock).toHaveBeenCalledTimes(1); // no additional spawn
    });

    it("returns connected status on second start() when already connected", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, "AAAA-BBBB");
      pushLine(child, "tunnel is ready");

      const result = await mgr.start();
      expect(result.status).toBe("connected");
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it("re-emits authorization_pending event with stored device code on idempotent start()", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(
        child,
        "Enter code ABCD-1234 at https://github.com/login/device"
      );
      expect(mgr.getStatus()).toBe("authorization_pending");

      const eventCountBefore = relayEvents.length;
      await mgr.start();

      const reEmitted = relayEvents.slice(eventCountBefore);
      expect(reEmitted).toHaveLength(1);
      expect(reEmitted[0]).toEqual({
        channel: "cluster.vscode-tunnel",
        payload: {
          status: "authorization_pending",
          deviceCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          tunnelName: "test-cluster",
        },
      });
    });

    it("re-emits connected event on idempotent start() when already connected", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, "AAAA-BBBB");
      pushLine(child, "tunnel is ready");
      expect(mgr.getStatus()).toBe("connected");

      const eventCountBefore = relayEvents.length;
      await mgr.start();

      const reEmitted = relayEvents.slice(eventCountBefore);
      expect(reEmitted).toHaveLength(1);
      expect(reEmitted[0]).toEqual({
        channel: "cluster.vscode-tunnel",
        payload: { status: "connected", tunnelName: "test-cluster" },
      });
    });

    it("re-emits a fresh starting event on second start() while starting (#966 FR-003)", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();
      expect(mgr.getStatus()).toBe("starting");

      const eventCountBefore = relayEvents.length;
      await mgr.start();

      const reEmitted = relayEvents.slice(eventCountBefore);
      expect(reEmitted).toHaveLength(1);
      expect(reEmitted[0]).toEqual({
        channel: "cluster.vscode-tunnel",
        payload: { status: "starting", tunnelName: "test-cluster" },
      });
      // Second start() must NOT respawn while the child is alive.
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it("clears stored deviceCode/verificationUri on process exit", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(
        child,
        "Enter code WXYZ-5678 at https://github.com/login/device"
      );
      expect(mgr.getStatus()).toBe("authorization_pending");

      // Process exits unexpectedly during authorization_pending — transitions to error
      // (FR-002: unexpected exit before reaching connected state)
      child.emit("exit");
      expect(mgr.getStatus()).toBe("error");

      // After exit, child is null so a new start() spawns fresh — no stale re-emit
      // Verify by checking no authorization_pending event was emitted between exit and now
      const authEventsAfterExit = relayEvents.filter(
        (e) => e.payload.status === "authorization_pending"
      );
      // Only 1 authorization_pending event total (the original, not a re-emit)
      expect(authEventsAfterExit).toHaveLength(1);
    });

    it("clears stored deviceCode/verificationUri on transition to connected", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(
        child,
        "Enter code MNOP-9999 at https://github.com/login/device"
      );
      expect(mgr.getStatus()).toBe("authorization_pending");

      // Transition to connected — clears device code fields
      pushLine(child, "Tunnel is ready and is connected");
      expect(mgr.getStatus()).toBe("connected");

      // Idempotent start() should re-emit connected, NOT authorization_pending
      const eventCountBefore = relayEvents.length;
      await mgr.start();

      const reEmitted = relayEvents.slice(eventCountBefore);
      expect(reEmitted).toHaveLength(1);
      expect(reEmitted[0].payload.status).toBe("connected");
      expect(reEmitted[0].payload).not.toHaveProperty("deviceCode");
    });

    // T007: FR-003, SC-003 — stale-child recovery when status === "error".
    // Simulates a hypothetical future regression where a code path leaves
    // this.child set with a resting-error status; start() must SIGTERM the
    // stale child, await its exit, then spawn — never overlap.
    it("recovers a stale child when status is 'error' (FR-003, SC-003)", async () => {
      const staleChild = createMockChild();
      const freshChild = createMockChild();
      spawnMock
        .mockReturnValueOnce(staleChild)
        .mockReturnValueOnce(freshChild);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start(); // wires stale child + exit handler

      // Manually corrupt the manager state to simulate the resting-error-with-
      // stale-child condition:
      (mgr as any).status = "error";

      const startPromise = mgr.start();
      // stop() sent SIGTERM synchronously; simulate the child obeying it:
      staleChild.emit("exit", 0);
      await startPromise;

      expect(staleChild.kill).toHaveBeenCalledWith("SIGTERM");
      expect(spawnMock).toHaveBeenCalledTimes(2);
      // Ordering: the stale child's SIGTERM must precede the second spawn —
      // no concurrent `code tunnel --name <same>` processes.
      const killOrder = (staleChild.kill as any).mock.invocationCallOrder[0];
      const secondSpawnOrder = spawnMock.mock.invocationCallOrder[1];
      expect(secondSpawnOrder).toBeGreaterThan(killOrder);
    });

    // T008a: FR-003 recovery from status === "disconnected" with stale child.
    it("recovers a stale child when status is 'disconnected' (FR-003)", async () => {
      const staleChild = createMockChild();
      const freshChild = createMockChild();
      spawnMock
        .mockReturnValueOnce(staleChild)
        .mockReturnValueOnce(freshChild);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      (mgr as any).status = "disconnected";

      const startPromise = mgr.start();
      staleChild.emit("exit", 0);
      await startPromise;

      expect(staleChild.kill).toHaveBeenCalledWith("SIGTERM");
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    // T008b: FR-003 recovery from status === "stopped" with stale child.
    it("recovers a stale child when status is 'stopped' (FR-003)", async () => {
      const staleChild = createMockChild();
      const freshChild = createMockChild();
      spawnMock
        .mockReturnValueOnce(staleChild)
        .mockReturnValueOnce(freshChild);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      (mgr as any).status = "stopped";

      const startPromise = mgr.start();
      staleChild.emit("exit", 0);
      await startPromise;

      expect(staleChild.kill).toHaveBeenCalledWith("SIGTERM");
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    // T009: regression guard — quickstart.md Case 5. Normal connected → stop
    // → start reconnect still spawns cleanly with only one spawn per start().
    // The FR-003 recovery branch must not fire when this.child === null.
    it("does not double-spawn on normal reconnect after clean stop (Case 5)", async () => {
      const child1 = createMockChild();
      const child2 = createMockChild();
      spawnMock
        .mockReturnValueOnce(child1)
        .mockReturnValueOnce(child2);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child1, "AAAA-BBBB");
      pushLine(child1, "is connected");
      expect(mgr.getStatus()).toBe("connected");

      const stopPromise = mgr.stop();
      child1.emit("exit", 0);
      await stopPromise;
      expect(mgr.getStatus()).toBe("stopped");

      await mgr.start();
      expect(mgr.getStatus()).toBe("starting");
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Process exit while connected -> disconnected state
  // -------------------------------------------------------------------------
  describe("process exit while connected", () => {
    it("transitions to disconnected when connected process exits", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      // Reach connected state
      pushLine(child, "RSTU-VWXY");
      pushLine(child, "Tunnel is ready and is connected");
      expect(mgr.getStatus()).toBe("connected");

      // Process exits unexpectedly
      child.emit("exit");
      expect(mgr.getStatus()).toBe("disconnected");
    });

    it("transitions to error when non-connected process exits unexpectedly", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();
      expect(mgr.getStatus()).toBe("starting");

      // Process exits before reaching connected state — per FR-002 this is an
      // unexpected failure (user-initiated termination would go through stop()).
      child.emit("exit");
      expect(mgr.getStatus()).toBe("error");
    });

    it("can be restarted after disconnection", async () => {
      const child1 = createMockChild();
      const child2 = createMockChild();
      spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child1, "AAAA-BBBB");
      pushLine(child1, "is connected");
      expect(mgr.getStatus()).toBe("connected");

      child1.emit("exit");
      expect(mgr.getStatus()).toBe("disconnected");

      // Restart should work -- spawns a new child
      const result = await mgr.start();
      expect(result.status).toBe("starting");
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it("sets error status on spawn error event", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      child.emit("error");
      expect(mgr.getStatus()).toBe("error");
    });
  });

  // -------------------------------------------------------------------------
  // shutdown() delegates to stop()
  // -------------------------------------------------------------------------
  describe("shutdown()", () => {
    it("delegates to stop()", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      const shutdownPromise = mgr.shutdown();
      child.emit("exit");
      await shutdownPromise;

      expect(mgr.getStatus()).toBe("stopped");
    });
  });
});

// ---------------------------------------------------------------------------
// #966: fresh-emit while starting, auth-phase timeout, and timer invariants
// ---------------------------------------------------------------------------
describe("VsCodeTunnelProcessManager #966", () => {
  let pushEventFn: ReturnType<typeof vi.fn>;
  let relayEvents: Array<{ channel: string; payload: VsCodeTunnelEvent }>;

  beforeEach(() => {
    relayEvents = [];
    pushEventFn = vi.fn((channel: string, payload: VsCodeTunnelEvent) => {
      relayEvents.push({ channel, payload });
    });
    getRelayPushEventMock.mockReturnValue(pushEventFn);
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createMockChild());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("FR-003: fresh-emit during starting on second start()", () => {
    it("emits a fresh starting event and does NOT respawn (SC-004)", async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();
      // First start() emits the initial "starting" event.
      const startingBefore = relayEvents.filter(
        (e) => e.payload.status === "starting"
      ).length;
      expect(startingBefore).toBe(1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(mgr.getStatus()).toBe("starting");

      // Second start() with child alive + status === "starting" +
      // deviceCode == null.
      await mgr.start();

      const startingAfter = relayEvents.filter(
        (e) => e.payload.status === "starting"
      ).length;
      expect(startingAfter).toBe(2);
      expect(relayEvents[relayEvents.length - 1]).toEqual({
        channel: "cluster.vscode-tunnel",
        payload: { status: "starting", tunnelName: "test-cluster" },
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("FR-004: auth-phase timeout (SC-003)", () => {
    it("times out authorization_pending after authTimeoutMs (positive)", async () => {
      vi.useFakeTimers();
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ authTimeoutMs: 50, deviceCodeTimeoutMs: 30_000 })
      );
      await mgr.start();

      pushLine(child, "Enter code ABCD-1234 at https://github.com/login/device");
      expect(mgr.getStatus()).toBe("authorization_pending");

      vi.advanceTimersByTime(51);

      expect(mgr.getStatus()).toBe("error");
      const errorEvents = relayEvents.filter(
        (e) => e.payload.status === "error"
      );
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].payload.error).toBe(
        "Timed out waiting for device-code authorization"
      );
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      // Exit handler must not double-emit an "error" event.
      const errorCountBeforeExit = errorEvents.length;
      child.emit("exit", 0);
      const errorCountAfterExit = relayEvents.filter(
        (e) => e.payload.status === "error"
      ).length;
      expect(errorCountAfterExit).toBe(errorCountBeforeExit);
      expect(mgr.getStatus()).toBe("error");
    });

    it("does not fire authTimer when auth completes in time (negative)", async () => {
      vi.useFakeTimers();
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ authTimeoutMs: 50, deviceCodeTimeoutMs: 30_000 })
      );
      await mgr.start();

      pushLine(child, "Enter code AAAA-BBBB at https://github.com/login/device");
      expect(mgr.getStatus()).toBe("authorization_pending");

      // Connect BEFORE the auth timer fires.
      pushLine(child, "Tunnel is ready and is connected");
      expect(mgr.getStatus()).toBe("connected");

      vi.advanceTimersByTime(200);

      const errorEvents = relayEvents.filter(
        (e) =>
          e.payload.status === "error" &&
          e.payload.error === "Timed out waiting for device-code authorization"
      );
      expect(errorEvents).toHaveLength(0);
      expect(child.kill).not.toHaveBeenCalledWith("SIGTERM");
      expect((mgr as unknown as { authTimer: unknown }).authTimer).toBeNull();
    });
  });

  describe("T1/T2 timer invariants", () => {
    it("after connected, both timers are null", async () => {
      vi.useFakeTimers();
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ authTimeoutMs: 5_000, deviceCodeTimeoutMs: 30_000 })
      );
      await mgr.start();
      pushLine(child, "Code CDEF-1234");
      pushLine(child, "Tunnel is ready and is connected");

      const internals = mgr as unknown as {
        deviceCodeTimer: NodeJS.Timeout | null;
        authTimer: NodeJS.Timeout | null;
      };
      expect(internals.deviceCodeTimer).toBeNull();
      expect(internals.authTimer).toBeNull();
    });

    it("after exit, both timers are null", async () => {
      vi.useFakeTimers();
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(
        defaultOpts({ authTimeoutMs: 5_000, deviceCodeTimeoutMs: 30_000 })
      );
      await mgr.start();
      pushLine(child, "Code ZZZZ-1234");
      expect(mgr.getStatus()).toBe("authorization_pending");
      child.emit("exit", 1);

      const internals = mgr as unknown as {
        deviceCodeTimer: NodeJS.Timeout | null;
        authTimer: NodeJS.Timeout | null;
      };
      expect(internals.deviceCodeTimer).toBeNull();
      expect(internals.authTimer).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// deriveTunnelName
// ---------------------------------------------------------------------------
describe("deriveTunnelName", () => {
  it("derives known mapping from UUID", () => {
    expect(deriveTunnelName("9e5c8a0d-755e-40b3-b0c3-43e849f0bb90")).toBe(
      "g-9e5c8a0d755e40b3b0"
    );
  });

  it("output length is <= 20 characters", () => {
    expect(
      deriveTunnelName("9e5c8a0d-755e-40b3-b0c3-43e849f0bb90").length
    ).toBeLessThanOrEqual(20);
  });

  it("is deterministic (same input -> same output)", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(deriveTunnelName(id)).toBe(deriveTunnelName(id));
  });

  it("handles already-hyphen-free input", () => {
    const result = deriveTunnelName("9e5c8a0d755e40b3b0c343e849f0bb90");
    expect(result).toBe("g-9e5c8a0d755e40b3b0");
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it("output always matches /^[a-z][a-z0-9-]{0,19}$/ for valid UUIDs", () => {
    // Property: any UUID-shaped input that consists of lowercase hex + hyphens
    // satisfies the Microsoft tunnel-name constraint.
    const inputs = [
      "9e5c8a0d-755e-40b3-b0c3-43e849f0bb90",
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "abcdef01-2345-6789-abcd-ef0123456789",
    ];
    for (const id of inputs) {
      expect(deriveTunnelName(id)).toMatch(/^[a-z][a-z0-9-]{0,19}$/);
    }
  });

  it("randomized UUIDs always satisfy the Microsoft tunnel-name regex (SC-004)", () => {
    // Property: for any randomly-generated UUID, deriveTunnelName produces a
    // string matching /^[a-z][a-z0-9-]{0,19}$/ (≤20 chars, letter-initial,
    // lowercase hex + hyphens only).
    const randHex = (n: number): string => {
      let s = "";
      for (let i = 0; i < n; i++) {
        s += Math.floor(Math.random() * 16).toString(16);
      }
      return s;
    };
    for (let trial = 0; trial < 100; trial++) {
      const uuid = `${randHex(8)}-${randHex(4)}-${randHex(4)}-${randHex(4)}-${randHex(12)}`;
      const name = deriveTunnelName(uuid);
      expect(name).toMatch(/^[a-z][a-z0-9-]{0,19}$/);
      expect(name.length).toBeLessThanOrEqual(20);
    }
  });
});

// ---------------------------------------------------------------------------
// loadOptionsFromEnv
// ---------------------------------------------------------------------------
describe("loadOptionsFromEnv", () => {
  it("returns options with derived tunnel name from GENERACY_CLUSTER_ID", () => {
    const opts = loadOptionsFromEnv({
      GENERACY_CLUSTER_ID: "9e5c8a0d-755e-40b3-b0c3-43e849f0bb90",
      VSCODE_CLI_BIN: "/opt/vscode/code",
    });
    expect(opts.tunnelName).toBe("g-9e5c8a0d755e40b3b0");
    expect(opts.binPath).toBe("/opt/vscode/code");
  });

  it("uses default bin path when VSCODE_CLI_BIN is not set", () => {
    const opts = loadOptionsFromEnv({
      GENERACY_CLUSTER_ID: "9e5c8a0d-755e-40b3-b0c3-43e849f0bb90",
    });
    expect(opts.binPath).toBe(DEFAULT_VSCODE_CLI_BIN);
  });

  it("produces the same tunnel name across multiple calls for the same cluster", () => {
    const env = { GENERACY_CLUSTER_ID: "9e5c8a0d-755e-40b3-b0c3-43e849f0bb90" };
    expect(loadOptionsFromEnv(env).tunnelName).toBe(
      loadOptionsFromEnv(env).tunnelName
    );
  });

  it("derives different tunnel names for sibling clusters under one project", () => {
    // Multi-cluster regression: two clusters under the same project must
    // produce different tunnel names (#744 FR-001/FR-002).
    const a = loadOptionsFromEnv({
      GENERACY_CLUSTER_ID: "11111111-1111-1111-1111-111111111111",
    });
    const b = loadOptionsFromEnv({
      GENERACY_CLUSTER_ID: "22222222-2222-2222-2222-222222222222",
    });
    expect(a.tunnelName).not.toBe(b.tunnelName);
  });

  it("throws when GENERACY_CLUSTER_ID is not set", () => {
    expect(() => loadOptionsFromEnv({})).toThrow(
      "GENERACY_CLUSTER_ID is required"
    );
  });
});
