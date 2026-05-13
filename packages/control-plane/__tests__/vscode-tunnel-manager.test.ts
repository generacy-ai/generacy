import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------
const { spawnMock } = vi.hoisted(() => {
  const spawnMock = vi.fn();
  return { spawnMock };
});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

// ---------------------------------------------------------------------------
// Mock relay-events
// ---------------------------------------------------------------------------
const { getRelayPushEventMock } = vi.hoisted(() => {
  const getRelayPushEventMock = vi.fn();
  return { getRelayPushEventMock };
});

vi.mock('../src/relay-events.js', () => ({
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
} from '../src/services/vscode-tunnel-manager.js';

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
function pushLine(child: ReturnType<typeof createMockChild>, line: string): void {
  child.stdout.emit('data', Buffer.from(line + '\n'));
}

function defaultOpts(overrides?: Partial<VsCodeTunnelManagerOptions>): VsCodeTunnelManagerOptions {
  return {
    binPath: '/usr/local/bin/code',
    tunnelName: 'test-cluster',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('VsCodeTunnelProcessManager', () => {
  let pushEventFn: ReturnType<typeof vi.fn>;
  let relayEvents: Array<{ channel: string; payload: VsCodeTunnelEvent }>;

  beforeEach(() => {
    relayEvents = [];
    pushEventFn = vi.fn((channel: string, payload: VsCodeTunnelEvent) => {
      relayEvents.push({ channel, payload });
    });
    getRelayPushEventMock.mockReturnValue(pushEventFn);

    spawnMock.mockImplementation(() => createMockChild());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. State machine transitions: stopped -> starting -> authorization_pending -> connected
  // -------------------------------------------------------------------------
  describe('state machine transitions', () => {
    it('starts in stopped state', () => {
      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      expect(mgr.getStatus()).toBe('stopped');
    });

    it('transitions from stopped to starting on start()', async () => {
      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      const result = await mgr.start();

      expect(result.status).toBe('starting');
      expect(result.tunnelName).toBe('test-cluster');
      expect(mgr.getStatus()).toBe('starting');
    });

    it('transitions stopped -> starting -> authorization_pending -> connected', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      expect(mgr.getStatus()).toBe('stopped');

      await mgr.start();
      expect(mgr.getStatus()).toBe('starting');

      // Emit a line containing a device code
      pushLine(child, 'To grant access, please log in to https://github.com/login/device and use code AB12-CD34');
      expect(mgr.getStatus()).toBe('authorization_pending');

      // Emit a line indicating connection
      pushLine(child, 'Tunnel is ready and is connected');
      expect(mgr.getStatus()).toBe('connected');
    });

    it('spawns with correct arguments', async () => {
      const mgr = new VsCodeTunnelProcessManager(defaultOpts({ binPath: '/custom/code' }));
      await mgr.start();

      expect(spawnMock).toHaveBeenCalledWith(
        '/custom/code',
        ['tunnel', '--accept-server-license-terms', '--name', 'test-cluster'],
        { stdio: ['ignore', 'pipe', 'pipe'], detached: false },
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Device code parsing from stdout (XXXX-XXXX pattern)
  // -------------------------------------------------------------------------
  describe('device code parsing', () => {
    it('parses XXXX-XXXX device code from stdout', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, 'Open https://github.com/login/device and enter code ABCD-1234');

      expect(mgr.getStatus()).toBe('authorization_pending');
      expect(relayEvents).toContainEqual({
        channel: 'cluster.vscode-tunnel',
        payload: {
          status: 'authorization_pending',
          deviceCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          tunnelName: 'test-cluster',
        },
      });
    });

    it('parses device code with all-uppercase letters and digits', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, 'Your device code: XY99-Z0A1');

      expect(mgr.getStatus()).toBe('authorization_pending');
      const authEvent = relayEvents.find(e => e.payload.status === 'authorization_pending');
      expect(authEvent?.payload.deviceCode).toBe('XY99-Z0A1');
    });

    it('handles multi-chunk stdout data correctly', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      // Push partial line then complete it in two data events
      child.stdout.emit('data', Buffer.from('Use code AA'));
      child.stdout.emit('data', Buffer.from('BB-CC11\n'));

      expect(mgr.getStatus()).toBe('authorization_pending');
      const authEvent = relayEvents.find(e => e.payload.status === 'authorization_pending');
      expect(authEvent?.payload.deviceCode).toBe('AABB-CC11');
    });
  });

  // -------------------------------------------------------------------------
  // 3. 30s timeout without device code -> error state with details
  // -------------------------------------------------------------------------
  describe('device code timeout', () => {
    it('transitions to error state after deviceCodeTimeoutMs without device code', async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts({ deviceCodeTimeoutMs: 30_000 }));
      await mgr.start();

      expect(mgr.getStatus()).toBe('starting');

      // Push some stdout lines (but no device code)
      pushLine(child, 'Initializing tunnel...');
      pushLine(child, 'Looking for existing tunnel...');

      // Advance past the timeout
      vi.advanceTimersByTime(30_000);

      expect(mgr.getStatus()).toBe('error');
      const errorEvent = relayEvents.find(e => e.payload.status === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.payload.error).toBe('Timed out waiting for device code');
      expect(errorEvent?.payload.details).toContain('Initializing tunnel...');
    });

    it('includes last 20 lines of stdout in error details', async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts({ deviceCodeTimeoutMs: 100 }));
      await mgr.start();

      // Push 25 lines to exceed the 20-line detail limit
      for (let i = 0; i < 25; i++) {
        pushLine(child, `log line ${i}`);
      }

      vi.advanceTimersByTime(100);

      const errorEvent = relayEvents.find(e => e.payload.status === 'error');
      expect(errorEvent?.payload.details).toBeDefined();
      // The stdoutBuffer keeps 50 but details shows last 20
      const detailLines = errorEvent!.payload.details!.split('\n');
      expect(detailLines).toHaveLength(20);
      expect(detailLines[0]).toBe('log line 5');
      expect(detailLines[19]).toBe('log line 24');
    });

    it('does not timeout if device code is received in time', async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts({ deviceCodeTimeoutMs: 1000 }));
      await mgr.start();

      // Receive device code before timeout
      pushLine(child, 'Code: AAAA-BBBB');
      expect(mgr.getStatus()).toBe('authorization_pending');

      // Advance past the timeout
      vi.advanceTimersByTime(2000);

      // Should still be authorization_pending, not error
      expect(mgr.getStatus()).toBe('authorization_pending');
    });

    it('emits error with undefined details when stdout buffer is empty', async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts({ deviceCodeTimeoutMs: 50 }));
      await mgr.start();

      vi.advanceTimersByTime(50);

      const errorEvent = relayEvents.find(e => e.payload.status === 'error');
      expect(errorEvent?.payload.details).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 4. stop() sends SIGTERM then SIGKILL after forceKillTimeoutMs
  // -------------------------------------------------------------------------
  describe('stop()', () => {
    it('sends SIGTERM to the child process', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      // Start stop, then simulate process exit
      const stopPromise = mgr.stop();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      // Simulate process exiting
      child.emit('exit');
      await stopPromise;
    });

    it('sends SIGKILL after forceKillTimeoutMs if process does not exit', async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts({ forceKillTimeoutMs: 200 }));
      await mgr.start();

      const stopPromise = mgr.stop();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

      // Advance past the force kill timeout
      vi.advanceTimersByTime(200);

      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      // Now the process exits
      child.emit('exit');
      await stopPromise;
    });

    it('does not SIGKILL if process exits before forceKillTimeoutMs', async () => {
      vi.useFakeTimers();

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts({ forceKillTimeoutMs: 5000 }));
      await mgr.start();

      const stopPromise = mgr.stop();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      // Process exits quickly
      child.emit('exit');
      await stopPromise;

      // Advance time -- SIGKILL should never have been called
      vi.advanceTimersByTime(5000);
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    });

    it('is a no-op when not running', async () => {
      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await expect(mgr.stop()).resolves.toBeUndefined();
    });

    it('sets status to stopped after stop when not connected', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      const stopPromise = mgr.stop();
      child.emit('exit');
      await stopPromise;

      expect(mgr.getStatus()).toBe('stopped');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Relay event emission
  // -------------------------------------------------------------------------
  describe('relay event emission', () => {
    it('emits starting event on start()', async () => {
      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      expect(relayEvents[0]).toEqual({
        channel: 'cluster.vscode-tunnel',
        payload: { status: 'starting', tunnelName: 'test-cluster' },
      });
    });

    it('emits authorization_pending event with device code', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, 'Enter code WXYZ-9876 at https://github.com/login/device');

      expect(relayEvents[1]).toEqual({
        channel: 'cluster.vscode-tunnel',
        payload: {
          status: 'authorization_pending',
          deviceCode: 'WXYZ-9876',
          verificationUri: 'https://github.com/login/device',
          tunnelName: 'test-cluster',
        },
      });
    });

    it('emits connected event when tunnel is ready', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, 'ABCD-EF12');
      pushLine(child, 'Tunnel is ready and is connected');

      const connectedEvent = relayEvents.find(e => e.payload.status === 'connected');
      expect(connectedEvent).toEqual({
        channel: 'cluster.vscode-tunnel',
        payload: { status: 'connected', tunnelName: 'test-cluster' },
      });
    });

    it('emits disconnected event when connected process exits', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, 'QWER-TYUI');
      pushLine(child, 'Tunnel is ready and is connected');
      child.emit('exit');

      const disconnectedEvent = relayEvents.find(e => e.payload.status === 'disconnected');
      expect(disconnectedEvent).toEqual({
        channel: 'cluster.vscode-tunnel',
        payload: { status: 'disconnected', tunnelName: 'test-cluster' },
      });
    });

    it('emits error event on spawn error', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      child.emit('error', new Error('spawn failed'));

      const errorEvent = relayEvents.find(e => e.payload.status === 'error');
      expect(errorEvent).toEqual({
        channel: 'cluster.vscode-tunnel',
        payload: { status: 'error', error: 'Failed to spawn VS Code CLI process' },
      });
    });

    it('does not emit events when relay push function is not available', async () => {
      getRelayPushEventMock.mockReturnValue(undefined);

      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      // Should not throw even with no push function
      pushLine(child, 'Enter code AAAA-BBBB');
      expect(pushEventFn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 6. start() when already running returns current status
  // -------------------------------------------------------------------------
  describe('start() idempotency', () => {
    it('returns current status without spawning again when already running', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      const first = await mgr.start();
      expect(first.status).toBe('starting');
      expect(spawnMock).toHaveBeenCalledTimes(1);

      // Move to authorization_pending
      pushLine(child, 'Code: ZZZZ-YYYY');
      expect(mgr.getStatus()).toBe('authorization_pending');

      // Second start() should return current status without new spawn
      const second = await mgr.start();
      expect(second.status).toBe('authorization_pending');
      expect(second.tunnelName).toBe('test-cluster');
      expect(spawnMock).toHaveBeenCalledTimes(1); // no additional spawn
    });

    it('returns connected status on second start() when already connected', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, 'AAAA-BBBB');
      pushLine(child, 'tunnel is ready');

      const result = await mgr.start();
      expect(result.status).toBe('connected');
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it('re-emits authorization_pending event with stored device code on idempotent start()', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, 'Enter code ABCD-1234 at https://github.com/login/device');
      expect(mgr.getStatus()).toBe('authorization_pending');

      const eventCountBefore = relayEvents.length;
      await mgr.start();

      const reEmitted = relayEvents.slice(eventCountBefore);
      expect(reEmitted).toHaveLength(1);
      expect(reEmitted[0]).toEqual({
        channel: 'cluster.vscode-tunnel',
        payload: {
          status: 'authorization_pending',
          deviceCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          tunnelName: 'test-cluster',
        },
      });
    });

    it('re-emits connected event on idempotent start() when already connected', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, 'AAAA-BBBB');
      pushLine(child, 'tunnel is ready');
      expect(mgr.getStatus()).toBe('connected');

      const eventCountBefore = relayEvents.length;
      await mgr.start();

      const reEmitted = relayEvents.slice(eventCountBefore);
      expect(reEmitted).toHaveLength(1);
      expect(reEmitted[0]).toEqual({
        channel: 'cluster.vscode-tunnel',
        payload: { status: 'connected', tunnelName: 'test-cluster' },
      });
    });

    it('does NOT re-emit in starting state (no device code stored yet)', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();
      expect(mgr.getStatus()).toBe('starting');

      const eventCountBefore = relayEvents.length;
      await mgr.start();

      // No new events emitted
      expect(relayEvents.length).toBe(eventCountBefore);
    });

    it('clears stored deviceCode/verificationUri on process exit', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, 'Enter code WXYZ-5678 at https://github.com/login/device');
      expect(mgr.getStatus()).toBe('authorization_pending');

      // Process exits unexpectedly during authorization_pending — transitions to error
      // (FR-002: unexpected exit before reaching connected state)
      child.emit('exit');
      expect(mgr.getStatus()).toBe('error');

      // After exit, child is null so a new start() spawns fresh — no stale re-emit
      // Verify by checking no authorization_pending event was emitted between exit and now
      const authEventsAfterExit = relayEvents.filter(
        e => e.payload.status === 'authorization_pending',
      );
      // Only 1 authorization_pending event total (the original, not a re-emit)
      expect(authEventsAfterExit).toHaveLength(1);
    });

    it('clears stored deviceCode/verificationUri on transition to connected', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child, 'Enter code MNOP-9999 at https://github.com/login/device');
      expect(mgr.getStatus()).toBe('authorization_pending');

      // Transition to connected — clears device code fields
      pushLine(child, 'Tunnel is ready and is connected');
      expect(mgr.getStatus()).toBe('connected');

      // Idempotent start() should re-emit connected, NOT authorization_pending
      const eventCountBefore = relayEvents.length;
      await mgr.start();

      const reEmitted = relayEvents.slice(eventCountBefore);
      expect(reEmitted).toHaveLength(1);
      expect(reEmitted[0].payload.status).toBe('connected');
      expect(reEmitted[0].payload).not.toHaveProperty('deviceCode');
    });
  });

  // -------------------------------------------------------------------------
  // 7. Process exit while connected -> disconnected state
  // -------------------------------------------------------------------------
  describe('process exit while connected', () => {
    it('transitions to disconnected when connected process exits', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      // Reach connected state
      pushLine(child, 'RSTU-VWXY');
      pushLine(child, 'Tunnel is ready and is connected');
      expect(mgr.getStatus()).toBe('connected');

      // Process exits unexpectedly
      child.emit('exit');
      expect(mgr.getStatus()).toBe('disconnected');
    });

    it('transitions to error when non-connected process exits unexpectedly', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();
      expect(mgr.getStatus()).toBe('starting');

      // Process exits before reaching connected state — per FR-002 this is an
      // unexpected failure (user-initiated termination would go through stop()).
      child.emit('exit');
      expect(mgr.getStatus()).toBe('error');
    });

    it('can be restarted after disconnection', async () => {
      const child1 = createMockChild();
      const child2 = createMockChild();
      spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      pushLine(child1, 'AAAA-BBBB');
      pushLine(child1, 'is connected');
      expect(mgr.getStatus()).toBe('connected');

      child1.emit('exit');
      expect(mgr.getStatus()).toBe('disconnected');

      // Restart should work -- spawns a new child
      const result = await mgr.start();
      expect(result.status).toBe('starting');
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it('sets error status on spawn error event', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      child.emit('error');
      expect(mgr.getStatus()).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // shutdown() delegates to stop()
  // -------------------------------------------------------------------------
  describe('shutdown()', () => {
    it('delegates to stop()', async () => {
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const mgr = new VsCodeTunnelProcessManager(defaultOpts());
      await mgr.start();

      const shutdownPromise = mgr.shutdown();
      child.emit('exit');
      await shutdownPromise;

      expect(mgr.getStatus()).toBe('stopped');
    });
  });
});

// ---------------------------------------------------------------------------
// deriveTunnelName
// ---------------------------------------------------------------------------
describe('deriveTunnelName', () => {
  it('derives known mapping from UUID', () => {
    expect(deriveTunnelName('9e5c8a0d-755e-40b3-b0c3-43e849f0bb90')).toBe('g-9e5c8a0d755e40b3b0');
  });

  it('output length is <= 20 characters', () => {
    expect(deriveTunnelName('9e5c8a0d-755e-40b3-b0c3-43e849f0bb90').length).toBeLessThanOrEqual(20);
  });

  it('is deterministic (same input -> same output)', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(deriveTunnelName(id)).toBe(deriveTunnelName(id));
  });

  it('handles already-hyphen-free input', () => {
    const result = deriveTunnelName('9e5c8a0d755e40b3b0c343e849f0bb90');
    expect(result).toBe('g-9e5c8a0d755e40b3b0');
    expect(result.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// loadOptionsFromEnv
// ---------------------------------------------------------------------------
describe('loadOptionsFromEnv', () => {
  it('returns options with derived tunnel name from env vars', () => {
    const opts = loadOptionsFromEnv({
      GENERACY_CLUSTER_ID: '9e5c8a0d-755e-40b3-b0c3-43e849f0bb90',
      VSCODE_CLI_BIN: '/opt/vscode/code',
    });
    expect(opts.tunnelName).toBe('g-9e5c8a0d755e40b3b0');
    expect(opts.binPath).toBe('/opt/vscode/code');
  });

  it('uses default bin path when VSCODE_CLI_BIN is not set', () => {
    const opts = loadOptionsFromEnv({
      GENERACY_CLUSTER_ID: 'my-cluster',
    });
    expect(opts.binPath).toBe(DEFAULT_VSCODE_CLI_BIN);
  });

  it('throws when GENERACY_CLUSTER_ID is not set', () => {
    expect(() => loadOptionsFromEnv({})).toThrow('GENERACY_CLUSTER_ID is required');
  });
});
