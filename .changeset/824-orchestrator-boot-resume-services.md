---
"@generacy-ai/orchestrator": patch
---

Resume the VS Code tunnel and code-server on cluster restart (#824).

`generacy stop` explicitly stops the VS Code tunnel and code-server, but on the next
boot neither was ever restarted: the sole auto-start site is the control-plane
`bootstrap-complete` handler, which the orchestrator only replays when
`PostActivationRetryService` reports `needsRetry === true`. On a healthy,
already-activated cluster (`activated && postActivationComplete`) `needsRetry` is
false, so `bootstrap-complete` never replayed and the tunnel/code-server stayed dead
until a full re-activation. A new `BootResumeService` now runs in `server.ts`'s
existing-API-key branch when the cluster is already activated, firing best-effort,
concurrent `vscode-tunnel-start` and `code-server-start` lifecycle POSTs (both
managers are idempotent). Failures surface per-service on the `cluster.bootstrap`
channel without marking the cluster degraded; it runs after the relay bridge is
initialized so the first `starting` events reach the cloud.
