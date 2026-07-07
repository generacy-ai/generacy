---
"@generacy-ai/orchestrator": patch
---

fix(orchestrator): boot-resume never fired on wizard clusters — `await relayBridge.start()` stranded the post-activation dispatch

The `#834` boot-resume was placed after `await relayBridge.start()` in
`activateInBackground` (the startup path every wizard-provisioned cluster takes,
since the relay API key is reloaded from disk rather than present in the process
env). `RelayBridge.start()` awaits `client.connect()`, which is a long-lived
reconnect loop that only resolves on disconnect — so on a healthy relay the
`await` never returns and `runPostActivationBranch()` was unreachable dead code.
The VS Code tunnel therefore never auto-resumed after a `generacy stop`/`start`.

Start the relay bridge fire-and-forget (`relayBridge.start().catch(...)`),
mirroring the synchronous existing-key path, so the post-activation dispatch
runs. Verified end-to-end on a live cluster: after an orchestrator restart the
boot-resume fires and the tunnel reconnects with no manual intervention.

The `#834` regression test could not catch this: its relay-client mock resolved
`connect()` immediately and its control-plane mock omitted `DockerEngineClient`
(making `relayBridge` null), so the blocking `start()` path was never exercised.
The test now keeps `connect()` pending and constructs a non-null bridge, and
fails if the fix is reverted.
