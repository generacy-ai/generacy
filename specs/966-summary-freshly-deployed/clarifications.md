# Clarifications

Feature: **VS Code Desktop tunnel hangs on "Starting tunnel…" — device-code auth event dropped/never surfaced** (#966)

## Batch 1 — 2026-07-16

### Q1: Buffer location
**Context**: The event emit site (`emitTunnelEvent` in `packages/control-plane/src/services/vscode-tunnel-manager.ts`) is in the control-plane process. The drop site (`if (client.isConnected)` at `packages/orchestrator/src/routes/internal-relay-events.ts:43`) and the "reconnect code path that already re-sends metadata" (`RelayBridge.handleConnected` at `packages/orchestrator/src/services/relay-bridge.ts:197`) live in a *different* process. FR-001/FR-002 require whichever module owns the buffer to be reachable from both the `/internal/relay-events` handler (writer on drop) and `RelayBridge.handleConnected` (reader on reconnect). Choice determines the entire wiring shape.
**Question**: Where does the retained `cluster.vscode-tunnel` event live?
**Options**:
- A: Module-level singleton in `packages/orchestrator/src/routes/internal-relay-events.ts` (or a sibling `retained-events.ts`) with `get`/`set` accessors imported by both `RelayBridge.handleConnected` and the route handler — mirrors the existing `getRelayPushEvent` / `setRelayPushEvent` pattern in control-plane.
- B: Private field on `RelayBridge` exposed via a public `setRetainedTunnelEvent()` method; the `/internal/relay-events` route is wired with a reference to `RelayBridge` at setup and stores the retained event through it — buffer state is owned by the reconnect path.
- C: Retain in control-plane's `VsCodeTunnelProcessManager` (which already caches `deviceCode`/`verificationUri`/`tunnelUrl`); orchestrator signals reconnect via a new HTTP `POST /lifecycle/relay-reconnect` (or similar) that the control-plane responds to by re-emitting through the existing `emitTunnelEvent` path.

**Answer**: *Pending*

### Q2: Actionable status set
**Context**: FR-001 lists retained statuses "at minimum `authorization_pending`, `connected`, `disconnected`, `error`". The word "minimum" leaves the exact set open. Notably, `error` events also come from the admin `unregister()` flow (`vscode-tunnel-manager.ts:326-378`) — those are one-shot cleanup errors, not lifecycle-state transitions of a live tunnel, and replaying them post-reconnect could confuse the UI (e.g., appearing to error a tunnel that is actually `connected`).
**Question**: What is the exact set of statuses/payloads that MUST be retained and replayed?
**Options**:
- A: Exactly `authorization_pending`, `connected`, `disconnected`, `error` — retain every `error` payload regardless of source (lifecycle vs. `unregister`).
- B: Same statuses as A, but retain `error` only when emitted from the child lifecycle path (spawn failure, exit-before-connected, device-code timeout); skip `error` emitted from `unregister()` and the `actualTunnelName !== opts.tunnelName` "tunnel name collision" observational emit at `vscode-tunnel-manager.ts:434`.
- C: Retain only `authorization_pending` and `error` (lifecycle-path); treat `connected` / `disconnected` as transient (the periodic metadata timer at `relay-bridge.ts:507` already surfaces tunnel liveness via `codeServerReady`-style metadata).

**Answer**: *Pending*

### Q3: Per-class buffer semantics (FR-005)
**Context**: FR-005 says "at most one retained event per tunnel *per event-class* (latest wins)". Ambiguous whether "class" = one slot per status value (multiple slots per tunnel, replay all) or one slot total per tunnel (latest actionable event overwrites regardless of prior status). This shapes what the UI sees on reconnect when the disconnect window spans a `authorization_pending` → `connected` transition.
**Question**: When multiple actionable events fire during one `!isConnected` window, what does the buffer keep and replay?
**Options**:
- A: **Single slot per tunnel, latest wins** — replay `connected` only; the earlier `authorization_pending` is discarded. UI transitions straight from `starting` to `connected` with no intermediate device-code prompt (acceptable because the user never needed to act — the tunnel authorized itself somehow, e.g., a still-valid token appeared).
- B: **One slot per status value**, all replayed in insertion order on reconnect — UI reconstructs the full transition (`authorization_pending` then `connected`), preserving audit-trail semantics.
- C: **Single slot with terminal preference** — `connected` / `disconnected` / `error` always overwrite an earlier `authorization_pending`; among terminals, latest wins. Same visible behaviour as A but the rule is explicit about terminal-beats-pending.

**Answer**: *Pending*

### Q4: Device-code timeout scope (FR-004)
**Context**: The current `deviceCodeTimer` (`vscode-tunnel-manager.ts:259-289`) only fires when `status === "starting"` and is cleared on the transition to `authorization_pending` at line 392. The reported hang is 10+ minutes *in* `authorization_pending`, so today's 30 s timer cannot possibly fire — it was cancelled before the hang began. FR-004 requires the timeout to fire when the child "stays in `authorization_pending` past `DEFAULT_DEVICE_CODE_TIMEOUT_MS`". This is a semantic change to what the constant means, and the choice affects UX (users typing device codes in a browser take real time).
**Question**: How should the timeout window be redefined to cover the `authorization_pending` phase?
**Options**:
- A: **Re-arm the same 30 s timer** on transition to `authorization_pending` — total budget becomes 30 s starting + 30 s pending = 60 s. Simplest; keeps a single constant. Risk: 30 s is too short for a human to open a browser, log in, and type an 8-char code.
- B: **Extend the single starting-phase timer to cover both phases** — one 30 s window from spawn to `connected`, cancelled by either terminal state. Same risk as A; a user who takes >30 s in the browser sees an `error`.
- C: **Introduce a distinct `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS`** (proposal: 300 s / 5 minutes — GitHub device codes are valid ~15 min but users typically act in <2 min) armed on transition to `authorization_pending`. Preserves the 30 s starting timer for the "spawned but never printed the code" case (real symptom of a broken CLI binary), and gives a realistic budget for human interaction.

**Answer**: *Pending*

### Q5: FR-003 fresh-emit behavior
**Context**: The current `start()` early-return branch (`vscode-tunnel-manager.ts:143-163`) already re-emits when status is `authorization_pending && this.deviceCode` (deviceCode non-null) or `connected`. It emits nothing when the child is alive with `status === "starting"` (the device code has not been parsed yet). FR-003 mandates that a user-triggered `POST /lifecycle/vscode-tunnel-start` "MUST re-emit a fresh, deliverable status event, rather than early-returning without emitting". The `starting`-with-live-child case is the exact gap that turns a click into silence.
**Question**: When `POST /lifecycle/vscode-tunnel-start` is called with the child alive and `status === "starting"` (no device code parsed yet), what should the manager do?
**Options**:
- A: **Emit a fresh `starting` event and return** — keeps the child; UI sees liveness while it waits for the device code that is about to appear. Cheapest fix; no wasted spawn.
- B: **Emit nothing** — treat `starting` as a normal in-progress state on the assumption that the UI already set its local state to `'starting'` when the user clicked. Accepts that the user must wait for the natural `authorization_pending` emission.
- C: **Kill + respawn** — extend the existing `error` / `disconnected` / `stopped` fall-through at `vscode-tunnel-manager.ts:137-142` to also cover `starting`, guaranteeing a fresh device-code sequence at the cost of a wasted CLI spawn if the code was about to appear.

**Answer**: *Pending*
