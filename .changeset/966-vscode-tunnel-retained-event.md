---
"@generacy-ai/orchestrator": patch
"@generacy-ai/control-plane": patch
---

Fix "Connect with VS Code Desktop" hanging on freshly deployed clusters (#966).

The `authorization_pending` event from `code tunnel` was silently dropped when the
orchestrator relay wasn't yet `connected`, so the cloud UI never saw the device code.
The orchestrator now retains the latest actionable `cluster.vscode-tunnel` event and
replays it on relay reconnect, `VsCodeTunnelProcessManager.start()` emits a fresh
`starting` event on user re-trigger while the child is alive, and a distinct 5-minute
timeout bounds the `authorization_pending` phase.
