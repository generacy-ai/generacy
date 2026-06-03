---
"@generacy-ai/control-plane": patch
---

fix(control-plane): report the actual VS Code tunnel name, not the requested one

The tunnel name is derived from the stable project id (#618), so deleting and
redeploying a cluster for the same project makes the new Droplet request a name
that's still registered to the (now-destroyed) previous Droplet. `code tunnel`
reports "name already taken" and silently falls back to a random name — but the
manager kept emitting the requested name, so the cloud persisted the wrong
`vscodeTunnelName` and vscode.dev deep-linked to the dead tunnel ("Timeout
connecting to relay").

`VsCodeTunnelProcessManager` now parses the actual registered name from the
`https://vscode.dev/tunnel/<name>/…` connection URL and reports that (falling
back to the requested name only if no URL was seen), so the cloud/UI always
points at the tunnel that's actually running.
