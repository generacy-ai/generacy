---
"@generacy-ai/control-plane": patch
---

Fix the VS Code tunnel device-code timeout orphaning the code-tunnel child (#825).

When a tunnel start reached the 30s device-code timeout, `VsCodeTunnelProcessManager`
set `status = "error"` but left `this.child` alive, so every later `start()` (the
cloud "Restart tunnel" button, which is start-only) hit the early-return and silently
no-oped until the control-plane process restarted. The timeout handler now kills the
child (SIGTERM with a SIGKILL backstop) so the exit handler clears `this.child`, and
`start()` is hardened to stop-then-respawn when it finds a stale child resting in an
`error` / `disconnected` / `stopped` status instead of returning. A `timedOut` flag
routes the exit-handler cascade past the pending branch so the timeout emits exactly
one `error` event rather than a second misleading "code tunnel exited" event.
