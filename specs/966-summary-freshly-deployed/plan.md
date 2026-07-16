# Implementation Plan: VS Code Desktop tunnel hangs on "Starting tunnel…" — device-code auth event dropped/never surfaced

**Feature**: On a freshly deployed cluster (preview channel), clicking "Connect with VS Code Desktop" hangs forever because the `authorization_pending` event emitted by `code tunnel` is dropped when the orchestrator relay is not yet `connected`. Fix by retaining the latest actionable `cluster.vscode-tunnel` event per tunnel in the orchestrator, replaying it on relay reconnect, emitting a fresh `starting` on user re-trigger, and arming a distinct 5-min timeout on the `authorization_pending` phase.
**Branch**: `966-summary-freshly-deployed`
**Status**: Complete

## Summary

Three coordinated fixes, all narrowly scoped:

1. **Retained-event singleton (FR-001, FR-002, FR-005, FR-006)** — module-level `get`/`set` accessors in the orchestrator (`packages/orchestrator/src/routes/retained-tunnel-event.ts`, new sibling to `internal-relay-events.ts`). Called by the `/internal/relay-events` route on the `!isConnected` drop branch, read by `RelayBridge.handleConnected()` (which already re-sends metadata on reconnect). Single slot per tunnel with terminal-beats-pending precedence (Q3=C). Only child-lifecycle `error` events retained; `unregister()` cleanup + name-collision `error` events skipped (Q2=B). Mirrors the `getRelayPushEvent`/`setRelayPushEvent` idiom already used by control-plane.

2. **Fresh-emit on user-triggered restart (FR-003)** — in `VsCodeTunnelProcessManager.start()`, the existing early-return branch for a live child (`vscode-tunnel-manager.ts:143-163`) grows one more case: when `status === "starting"` and `deviceCode == null`, emit a fresh `{ status: "starting", tunnelName }` event and return without killing the child (Q5=A). No new spawn, no wasted CLI.

3. **`authorization_pending` phase timeout (FR-004, SC-003)** — introduce `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS = 300_000` (5 min). Armed on transition `starting → authorization_pending` (the same site that clears `deviceCodeTimer` today at `vscode-tunnel-manager.ts:392`). On expiry: set `status = "error"`, emit a terminal `error` event, SIGTERM child (with existing SIGKILL backstop), route the exit through the existing `timedOut` cascade so the exit handler suppresses the duplicate wasPending emit. The existing 30 s starting-phase timer is retained for the "spawned but never printed a code" broken-CLI case (Q4=C).

The retained-event replay rides the existing reconnect code path — no new HTTP endpoint, no cross-process signal, no schema change to `cluster.vscode-tunnel`. Cloud-side consumers (`use-vscode-tunnel.ts`) receive a normally-shaped event they already know how to render.

## Technical Context

- **Languages**: TypeScript (ESM, Node >=22)
- **Packages touched**: `packages/orchestrator/`, `packages/control-plane/`
- **Framework**: None specific — Fastify at server boundary, plain classes elsewhere
- **Dependencies**: `zod` (existing schema for the route), `pino` (existing logger). **No new deps.**
- **Test runner**: Vitest (existing convention in both packages)
- **Cross-package coupling**: none added — the retained-event singleton lives entirely in orchestrator; control-plane behavior change is confined to `VsCodeTunnelProcessManager` internals
- **Wire format**: unchanged — `RelayEventRequestSchema` in `internal-relay-events.ts` still accepts `{ event, data, timestamp }`; retained event is stored as the same `{ event, data, timestamp }` triple

## Project Structure

```
packages/orchestrator/
  src/
    routes/
      internal-relay-events.ts             MOD  — on !isConnected, call setRetainedTunnelEvent()
                                                    only for cluster.vscode-tunnel; other channels
                                                    keep today's silent drop.
      retained-tunnel-event.ts             NEW  — module-level singleton with get/set/clear;
                                                    encodes single-slot + terminal precedence
                                                    + eligibility filter (Q2=B, Q3=C).
    services/
      relay-bridge.ts                      MOD  — handleConnected() reads getRetainedTunnelEvent()
                                                    once, forwards via client.send(), calls
                                                    clearRetainedTunnelEvent(). Order: after
                                                    setupEventForwarding(), before sendMetadata().
    __tests__/
      retained-tunnel-event.test.ts        NEW  — helper regression: FR-005/FR-006 precedence
                                                    and eligibility.
      relay-bridge-retained-replay.test.ts NEW  — handleConnected() replays exactly once and
                                                    clears; empty slot is a no-op.
  routes/__tests__/
    (existing) internal-relay-events.test.ts
                                           MOD  — extend with cases for cluster.vscode-tunnel
                                                    drop + retention (FR-001), other channels
                                                    still silent-drop.

packages/control-plane/
  src/
    services/
      vscode-tunnel-manager.ts             MOD  — three changes:
                                                    (a) add DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS
                                                        and authTimeoutMs option (FR-004).
                                                    (b) arm auth-phase timer at the
                                                        starting→authorization_pending transition
                                                        (~line 391-401); teardown on any
                                                        terminal transition.
                                                    (c) extend start()'s live-child early-return
                                                        (~lines 143-163) with a `starting` +
                                                        deviceCode==null case: fresh-emit and
                                                        return (FR-003, Q5=A).
  __tests__/
    vscode-tunnel-manager.test.ts          MOD  — add cases for FR-003 fresh-emit, FR-004
                                                    auth-phase timeout, SC-004, SC-005.

specs/966-summary-freshly-deployed/
  spec.md                                  (untouched — read-only)
  clarifications.md                        (unchanged)
  plan.md                                  NEW (this file)
  research.md                              NEW
  data-model.md                            NEW
  contracts/
    retained-tunnel-event.md               NEW — helper interface + precedence rules
    vscode-tunnel-manager.md               NEW — new option + timing invariants
  quickstart.md                            NEW

.changeset/
  966-vscode-tunnel-retained-event.md      NEW — patch bump (bugfix, no public API surface).
                                                 Lists both packages/orchestrator and
                                                 packages/control-plane (both `src/` diffs).
```

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo. Skipped.

Existing project conventions honoured:
- **Changeset required** (CI gate at `.github/workflows/changeset-bot.yml`) — this diff touches non-test files under both `packages/orchestrator/src/` and `packages/control-plane/src/`. The changeset MUST list both packages. Bump level: `patch` on both (defect fix, no new public API surface — `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS` is a new export but is internal-tuning, not part of a documented API).
- **No comments describing WHAT** — helpers named for what they do; `Why:` comments only where the constraint isn't obvious (e.g., "terminal-beats-pending" precedence, "auth-phase timer is distinct from starting-phase timer").
- **No new inter-process reconnect signal** — FR-002 explicitly rules out `POST /lifecycle/relay-reconnect`. Retained event lives entirely in the orchestrator process where both writer and reader run.
- **Vitest, no snapshot fixtures** — matches existing test style in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` and `packages/control-plane/src/routes/internal-relay-events.test.ts`.

## Design Overview

### Retained-tunnel-event singleton (`retained-tunnel-event.ts`)

Pure, module-scoped state. No `this`, no I/O. Exports:

```ts
export interface RetainedTunnelEvent {
  event: 'cluster.vscode-tunnel';
  data: unknown;              // stored as-is; the schema at the route boundary already validated the shape
  timestamp: string;          // ISO-8601, from the request
  status: RetainedStatus;     // extracted from data for precedence decisions
}
type RetainedStatus = 'authorization_pending' | 'connected' | 'disconnected' | 'error';

export function getRetainedTunnelEvent(): RetainedTunnelEvent | null;
export function setRetainedTunnelEvent(event: RetainedTunnelEvent): void;
export function clearRetainedTunnelEvent(): void;
```

`setRetainedTunnelEvent` encodes:

1. **Eligibility (FR-001 + Q2=B)**: only `status ∈ {authorization_pending, connected, disconnected, error}`. Other statuses (`starting`, `stopped`) are transient and not retained. `error` payloads whose `data.error` string matches the known non-lifecycle sources (`"tunnel unregister timed out"`, `"tunnel unregister exited with code"`, `"tunnel unregister failed"`, `"tunnel name collision"`) are dropped, not stored — this is where Q2=B is enforced. String-match is acceptable because these strings are constructed at exactly one call-site each in `vscode-tunnel-manager.ts` (lines 347, 363, 373, 436) and are covered by the eligibility test suite.
2. **Precedence (FR-005 + Q3=C)**: if there's an existing retained event whose status is terminal (`connected` / `disconnected` / `error`) and the incoming status is `authorization_pending`, keep the existing — a stale pending event MUST NOT clobber a terminal state. In every other case, the incoming event overwrites.

`clearRetainedTunnelEvent()` is called after successful replay so a subsequent reconnect doesn't re-deliver a stale event.

### Route wiring (`internal-relay-events.ts`)

Only the `!isConnected` branch changes. Before returning 204, if `event === 'cluster.vscode-tunnel'` and the payload passes eligibility, call `setRetainedTunnelEvent({ event, data, timestamp, status })`. Every other channel keeps today's silent-drop behavior (out of scope per spec: "A general-purpose retained/replay layer for other `cluster.*` event channels beyond `cluster.vscode-tunnel`").

Status extraction: the route already `safeParse`s with Zod. `data` is `z.unknown()` today; we narrow to `{ status?: string }` via a local Zod schema (defined in `retained-tunnel-event.ts`) just for the retention decision. If `status` is not one of the retained values, the event is dropped as before.

### Reconnect replay (`relay-bridge.ts::handleConnected`)

After `setupEventForwarding()`, before `sendMetadata()` (metadata already runs on reconnect):

```ts
const retained = getRetainedTunnelEvent();
if (retained && this.client.isConnected) {
  this.client.send({
    type: 'event',
    event: retained.event,
    data: retained.data,
    timestamp: retained.timestamp,
  });
  clearRetainedTunnelEvent();
}
```

Fire-and-forget consistent with existing `emitJobEvent` pattern. Errors during send are swallowed (best-effort — the whole retention system is a reliability improvement, never a correctness dependency).

### Fresh-emit branch (`VsCodeTunnelProcessManager.start()`)

Existing branch at `vscode-tunnel-manager.ts:143-163` covers `authorization_pending && deviceCode` (re-emit cached device code) and `connected` (re-emit cached tunnel URL). It emits nothing for `starting` — the click-into-silence gap.

New case, inserted before the two existing cases:

```ts
} else if (this.status === "starting") {
  // FR-003 (Q5=A): user re-triggered while child is alive but device code has
  // not yet been parsed. Emit a fresh `starting` so the UI sees liveness while
  // the imminent device code is parsed and delivered via the normal
  // authorization_pending emission. Do NOT kill the child.
  emitTunnelEvent({
    status: "starting",
    tunnelName: this.opts.tunnelName,
  });
}
```

The final `return { status, tunnelName }` (lines 159-162) is unchanged.

### Auth-phase timeout (`VsCodeTunnelProcessManager`)

New constant + option:

```ts
export const DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS = 300_000;

export interface VsCodeTunnelManagerOptions {
  // ...existing...
  authTimeoutMs?: number;
}
```

New private field: `private authTimer: NodeJS.Timeout | null = null;`

At the `starting → authorization_pending` transition (`handleStdoutLine` inside the `codeMatch && this.status === "starting"` branch, ~line 391-401), *after* `clearDeviceCodeTimer()` and *before* the `emitTunnelEvent(...)`, arm the auth timer:

```ts
this.armAuthTimer(child);
```

Where `armAuthTimer(child)` is:

```ts
private armAuthTimer(child: ChildProcess): void {
  if (this.authTimer) return;                     // already armed (defense)
  const ms = this.opts.authTimeoutMs ?? DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS;
  this.authTimer = setTimeout(() => {
    if (this.status !== "authorization_pending") return;
    this.status = "error";
    const last20 = this.stdoutBuffer.slice(-20).join("\n");
    emitTunnelEvent({
      status: "error",
      error: "Timed out waiting for device-code authorization",
      details: last20 || undefined,
      tunnelName: this.opts.tunnelName,
    });
    this.timedOut = true;                          // route the exit through the timedOut cascade
    try { child.kill("SIGTERM"); } catch {}
    const forceKillMs = this.opts.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS;
    const forceTimer = setTimeout(() => {
      try { this.child?.kill("SIGKILL"); } catch {}
    }, forceKillMs);
    if (typeof forceTimer.unref === "function") forceTimer.unref();
  }, ms);
  if (typeof this.authTimer.unref === "function") this.authTimer.unref();
}

private clearAuthTimer(): void {
  if (this.authTimer) {
    clearTimeout(this.authTimer);
    this.authTimer = null;
  }
}
```

Teardown points (each already exists — we add `clearAuthTimer()` alongside `clearDeviceCodeTimer()`):

- exit handler (line ~191): `this.clearDeviceCodeTimer(); this.clearAuthTimer();`
- connected transition (line ~411): `this.clearDeviceCodeTimer(); this.clearAuthTimer();`
- `child.on("error", ...)` (line ~230): `this.clearDeviceCodeTimer(); this.clearAuthTimer();`

Reuses the existing `timedOut` mechanism so the exit handler suppresses a duplicate "code tunnel exited (code N)" `error` emit — same pattern as today's starting-phase timeout (lines 273-275, 199-202).

## Behavior Matrix

### Retention slot state transitions (FR-005, FR-006)

Reading order: existing → incoming → resulting slot.

| Existing slot          | Incoming (eligible)     | Result                          | Justification (FR / Q) |
|------------------------|-------------------------|---------------------------------|------------------------|
| empty                  | `authorization_pending` | `authorization_pending`         | first write            |
| empty                  | `connected`             | `connected`                     | first write            |
| `authorization_pending`| `connected`             | `connected`                     | FR-005: terminal wins  |
| `authorization_pending`| `disconnected`          | `disconnected`                  | FR-005                 |
| `authorization_pending`| `error` (lifecycle)     | `error`                         | FR-005                 |
| `authorization_pending`| `authorization_pending` | new `authorization_pending`     | same status, latest wins |
| `connected`            | `authorization_pending` | `connected` (unchanged)         | FR-005 Q3=C: pending never clobbers terminal |
| `connected`            | `disconnected`          | `disconnected`                  | latest terminal wins   |
| `connected`            | `error` (lifecycle)     | `error`                         | latest terminal wins   |
| any                    | `error` (unregister)    | unchanged (event dropped)       | FR-006 Q2=B            |
| any                    | `error` (name-collision)| unchanged (event dropped)       | FR-006 Q2=B            |
| any                    | `starting` / `stopped`  | unchanged (event dropped)       | FR-001 eligibility     |

### Auth-phase timeout state machine

| Phase                 | Timer state                                | Bounded by                        |
|-----------------------|--------------------------------------------|-----------------------------------|
| pre-spawn             | none                                       | -                                 |
| `starting`            | `deviceCodeTimer` armed (30 s)             | starting-phase (broken-CLI)       |
| `authorization_pending` | `authTimer` armed (300 s), device-code cleared | auth-phase (human latency)   |
| `connected`           | both cleared                               | -                                 |
| `disconnected`/`error`| both cleared in exit handler               | -                                 |

## Risks and Mitigations

1. **Retained event replayed to a UI that has already advanced past that state** — mitigated by FR-005 terminal-beats-pending. The UI never sees a device-code prompt after a `connected` state. `starting` is intentionally not retained.
2. **`error` event replayed spuriously after a legitimate `connected`** — mitigated by FR-006 (unregister + name-collision errors filtered at write-time, not retained). A lifecycle `error` that fires after a `connected` is a real state change worth replaying (child died) and is retained by design.
3. **`clearRetainedTunnelEvent()` racing a second write** — the retained-event singleton is single-threaded in the Node event loop. `handleConnected → send → clear` runs to completion in one microtask sequence relative to any subsequent `setRetainedTunnelEvent`. No lock needed.
4. **5-min auth timeout errors legitimate users** — GitHub device codes valid ~15 min; typical user completes in <2 min. 5 min is comfortably above the human-latency P99 and well under GitHub's own expiry. Configurable via `authTimeoutMs` option for tests.
5. **New `authTimer` leaks on abnormal exit** — every existing `clearDeviceCodeTimer()` site gets a paired `clearAuthTimer()`. `unref()` prevents any leaked timer from keeping the event loop alive. Tests assert timer teardown at each exit branch.
6. **String-match on `error` field for FR-006 eligibility is brittle** — mitigated by (a) listing the exact strings in `retained-tunnel-event.ts` as a module-level constant tied to the four call sites in `vscode-tunnel-manager.ts`, and (b) an eligibility test that feeds each of the four exact strings and asserts they're rejected. A future rename in `vscode-tunnel-manager.ts` would be caught by that test.
7. **Reconnect happens while replay is in flight** — `handleConnected` is only invoked on the client's `connected` event, which fires once per connect. `this.client.isConnected` guarding the `send` call handles the race where the client transitions back to disconnected between the retention read and the send.

## Testing Strategy

### Unit tests

- `retained-tunnel-event.test.ts` (NEW) — full precedence matrix from the "Retention slot state transitions" table above; eligibility filter for each of the four non-lifecycle `error` strings; empty-slot get/clear behavior.
- `relay-bridge-retained-replay.test.ts` (NEW) — `handleConnected()` with (a) empty slot (no send), (b) populated slot (exactly one send, then clear), (c) client became disconnected between read and send (no send, no clear). Uses a fake `ClusterRelayClient` with `isConnected` toggleable.
- `internal-relay-events.test.ts` (MOD) — extend existing cases with: `cluster.vscode-tunnel` + `authorization_pending` while `!isConnected` → slot populated; `cluster.audit` while `!isConnected` → slot NOT populated (retention is `cluster.vscode-tunnel`-only); malformed `data` → not retained (Zod validation short-circuits before retention).
- `vscode-tunnel-manager.test.ts` (MOD):
  - **FR-003 (SC-004)**: with child alive and `status === "starting"` + `deviceCode == null`, calling `start()` again emits exactly one `starting` event via `getRelayPushEvent()` mock and does NOT call `spawn` a second time.
  - **FR-004 (SC-003)**: with `authTimeoutMs: 50`, simulate `starting → authorization_pending` (feed device-code line), advance fake timers past 50 ms, assert `status === "error"`, exactly one lifecycle `error` event emitted with `error: "Timed out waiting for device-code authorization"`, child SIGTERM'd, exit handler does not double-emit.
  - **FR-004 negative**: with `authTimeoutMs: 50`, simulate `starting → authorization_pending → connected` before 50 ms, assert no `error` event, no SIGTERM.
  - **SC-005**: emit an `unregister()` `error` via the `unregister()` code path, then simulate reconnect (unit-test the retention layer only, not the full stack); assert the retained slot is empty.

### Integration test (SC-002)

`packages/orchestrator/src/__tests__/vscode-tunnel-retained-replay.integration.test.ts` (NEW) — spin up the Fastify server with a stubbed `ClusterRelayClient`, POST an `authorization_pending` event to `/internal/relay-events` while `isConnected === false`, then flip `isConnected → true` and fire the `connected` handler, assert the client received exactly one `send({ type: 'event', event: 'cluster.vscode-tunnel', … })` call with the retained payload. Follows the pattern in existing `relay-integration.integration.test.ts`.

## Success-Criteria Traceability

| SC     | Test coverage                                                                  |
|--------|--------------------------------------------------------------------------------|
| SC-001 | Manual repro (10 fresh clusters) — not automated; captured in quickstart.md.  |
| SC-002 | `vscode-tunnel-retained-replay.integration.test.ts` (NEW).                     |
| SC-003 | `vscode-tunnel-manager.test.ts` — FR-004 timeout case.                         |
| SC-004 | `vscode-tunnel-manager.test.ts` — FR-003 fresh-emit case.                      |
| SC-005 | `retained-tunnel-event.test.ts` — eligibility for `unregister()` `error` strings. |

## Next Steps

- `/speckit:tasks` to generate task list from this plan.
