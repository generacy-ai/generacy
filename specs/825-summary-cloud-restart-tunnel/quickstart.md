# Quickstart: Restart-tunnel silently no-ops after device-code timeout — fix validation

**Feature**: `825-summary-cloud-restart-tunnel` | **Date**: 2026-07-07

Reproduce the bug, validate the fix, and confirm regression coverage. All commands run from the `generacy` repo root unless noted.

## Reproduce the bug (pre-fix, on `develop`)

The bug is timing-sensitive and requires either mocked timers (in the unit-test suite) or a network condition that blocks the device-code endpoint for 30s. The unit-test path is faster and reliable.

```bash
git checkout develop
pnpm install
pnpm --filter @generacy-ai/control-plane build

# The bug is that after the device-code timeout, the manager's `child` is still set
# and `status = "error"`. This makes every subsequent start() a no-op.
# Confirm the missing kill / child-clear:
grep -n "child.kill\|this.child = null" \
  packages/control-plane/src/services/vscode-tunnel-manager.ts | \
  head -20
# → In the deviceCodeTimer handler (:235-247), zero matches for `child.kill` or `this.child = null`.
# → In the child.on("exit") handler (:164-201), `this.child = null` is present.
# So: after timeout, `status = "error"` is set but the child is never killed until it exits on its own.

# The observable end-user effect (integration flow):
#   1. First vscode-tunnel-start → child spawns, device code endpoint hangs for 30s
#   2. Timeout fires → status = "error", ONE error event emitted, child STAYS ALIVE
#   3. User clicks Restart → cloud POSTs vscode-tunnel-start again
#   4. start() sees this.child truthy → early-return with { status: "error" }
#   5. No new child spawned. UI shows the old error. Restart button appears dead.
```

## Validate the fix

Switch to this feature branch:

```bash
git checkout 825-summary-cloud-restart-tunnel
pnpm install
pnpm --filter @generacy-ai/control-plane build
```

### Case 1 — timeout leaves the manager cleanly recoverable (SC-001)

The primary success case. Reproduced in the unit-test suite via fake timers:

```bash
pnpm --filter @generacy-ai/control-plane test -- vscode-tunnel-manager
```

Watch for the extended `describe("device code timeout")` block. Key new assertions:

- After `vi.advanceTimersByTime(30_000)`, the mock child receives `child.kill` with `"SIGTERM"`.
- The mock child's subsequent `exit` event does NOT produce a second `error` event on the relay stream — exactly ONE `error` with `error: "Timed out waiting for device code"`.
- After the exit, `mgr.getStatus()` returns `"error"` and `mgr["child"]` (the private field, probed via a test-only accessor OR by observing that a subsequent `start()` re-spawns) is `null`.
- A second `mgr.start()` call causes `spawnMock` to be invoked a second time — the fresh `code tunnel` child spawns.

### Case 2 — subsequent Restart click succeeds after single click (SC-001)

Integration-flavored, still driven by unit-test fakes:

```ts
// pseudocode — see the extended test file for the actual code
const mgr = new VsCodeTunnelProcessManager(defaultOpts({ deviceCodeTimeoutMs: 100 }));
await mgr.start();               // spawn #1
vi.advanceTimersByTime(100);     // timeout fires
child1.emit("exit");             // stale child cleaned up

// Simulated Restart button:
await mgr.start();               // spawn #2 — must succeed, no early-return

expect(spawnMock).toHaveBeenCalledTimes(2);
expect(mgr.getStatus()).toBe("starting");
```

### Case 3 — exactly one error event per failed attempt (SC-002)

Extended assertion in the same test block. Capture `relayEvents` (already collected by the test harness at `vscode-tunnel-manager.test.ts:74-83`):

```ts
const errorEvents = relayEvents.filter(e => e.payload.status === "error");
expect(errorEvents).toHaveLength(1);
expect(errorEvents[0].payload.error).toBe("Timed out waiting for device code");
expect(errorEvents[0].payload.details).toContain("<last stdout>");
```

### Case 4 — no concurrent `code tunnel --name <same>` processes (SC-003)

The FR-003 defense-in-depth branch. Force the manager into the resting-error-with-stale-child state (simulate a future bug that leaves `child` set):

```ts
// Set up a stale-child state manually (simulating a hypothetical future regression):
(mgr as any).child = staleChild;
(mgr as any).status = "error";

await mgr.start();
// Expect `stop()` to run first (staleChild.kill("SIGTERM") called), then spawn:
expect(staleChild.kill).toHaveBeenCalledWith("SIGTERM");
expect(spawnMock.mock.invocationCallOrder[0]).toBeGreaterThan(
  staleChild.kill.mock.invocationCallOrder[0],
);
```

Assert ordering: `stop()`'s kill fires before `spawn()` — no overlap window.

### Case 5 — regression guard: normal disconnect + reconnect still works

The FR-003 recovery branch also fires for `"disconnected"` and `"stopped"`. Ensure the existing behavior for a normal reconnect after a clean stop is unchanged:

```ts
// Normal flow:
await mgr.start();
pushLine(child, "AAAA-BBBB");
pushLine(child, "is connected");
expect(mgr.getStatus()).toBe("connected");
await mgr.stop();
expect(mgr.getStatus()).toBe("stopped");

// Reconnect:
await mgr.start();
expect(mgr.getStatus()).toBe("starting");
expect(spawnMock).toHaveBeenCalledTimes(2);
```

No behavior change — `stop()` already cleared `child`, so the FR-003 defense-in-depth branch is not triggered (skipped because `this.child === null`).

## End-to-end validation (manual, requires cloud)

Only necessary if the unit-test suite passes and you want belt-and-suspenders confirmation.

```bash
# 1. Build a control-plane container with this branch:
pnpm --filter @generacy-ai/control-plane build
docker build -t generacy-cluster-base:local -f cluster-base/.devcontainer/Dockerfile .   # (from tetrad-development repo)

# 2. Boot a cluster targeting a local generacy-cloud instance:
generacy launch --claim=<code> --api-url=http://localhost:3000

# 3. In the cloud UI project page, click "Restart tunnel" while the tunnel is in
#    a stalled starting-state (simulate by iptables-dropping outbound to
#    github.com/login/device or by killing the code tunnel process at pid 1).

# 4. Observe:
#    - Cloud UI shows one "error" state with message "Timed out waiting for device code"
#    - Clicking Restart again yields a fresh spawn (new "starting" event on the relay)
#    - No container restart required
```

## Success criteria checks

Direct grep-based verification against spec §Success Criteria:

**SC-001**: Restart recovers from device-code-timeout state.

```bash
# After the fix, the timeout handler must contain a kill:
grep -A 15 "deviceCodeTimer = setTimeout" \
  packages/control-plane/src/services/vscode-tunnel-manager.ts | \
  grep -E "kill|timedOut = true"
# → Expect at least: this.timedOut = true; child.kill("SIGTERM"); ... SIGKILL backstop
```

**SC-002**: Exactly one `error` event per failed attempt.

```bash
# After the fix, the exit handler must branch on the timedOut flag:
grep -B 2 -A 8 "timedOut" packages/control-plane/src/services/vscode-tunnel-manager.ts | \
  grep -E "timedOut|status = \"error\"|wasPending"
# → Expect: `if (timedOut) { /* skip wasPending emit */ }` branch above the `else if (wasPending)` branch
```

**SC-003**: No concurrent `code tunnel` processes with the same `--name`.

```bash
# After the fix, start() must have an await stop() branch for resting-error states:
grep -B 2 -A 10 "async start()" \
  packages/control-plane/src/services/vscode-tunnel-manager.ts | \
  grep -E "await this.stop\(\)|status === \"error\"|status === \"disconnected\"|status === \"stopped\""
# → Expect: guard checks status ∈ { "error", "disconnected", "stopped" } and awaits stop() before spawning
```

## Test suite

```bash
pnpm --filter @generacy-ai/control-plane test -- vscode-tunnel-manager
```

Watch specifically:

- `__tests__/vscode-tunnel-manager.test.ts` — extended `describe("device code timeout")` and `describe("start() idempotency")` blocks. All new assertions labelled with the corresponding FR / SC IDs.

## Troubleshooting

**Timeout error still fires but Restart still no-ops** — the `timedOut` flag likely was not reset at the top of the exit handler, or the exit handler wasn't updated to check it. Confirm the flag is read at the top and cleared in the same statement (mirroring `stopping`).

**Two `error` events emitted per timeout** — the exit handler's `wasPending` branch is not being suppressed. Confirm the new `else if (timedOut)` branch is placed **before** the `else if (wasPending)` branch (see `data-model.md` §"Exit-handler branching table").

**Restart triggers a fresh spawn but the old `code tunnel` process is still running** — the FR-003 `await stop()` did not run to completion, or the child ignored SIGTERM and the SIGKILL backstop was not reached. Confirm `stop()` is `await`ed (not fire-and-forget) and that `forceKillTimeoutMs` is passed through from options if the manager was constructed with a custom value.

**Legitimate unexpected exit now shows no error** — you likely broke the non-timeout `wasPending` branch. The `else if (timedOut)` branch must **skip the emit but not skip the branch cascade** — i.e. it must not also match legitimate child exits where `timedOut === false`. Re-read the branching table.
