---
"@generacy-ai/control-plane": minor
---

feat(control-plane): package the worker→control-plane git-token proxy as a bin (#768)

Ports the worker-side git-token proxy out of the cluster-base standalone script
(`.devcontainer/generacy/scripts/git-token-proxy.js`) into
`@generacy-ai/control-plane` as a typed, unit-tested bin shipped at
`dist/bin/git-token-proxy.js`, co-located with the existing
`git-credential-generacy` helper.

Behavior is preserved exactly: env `GIT_TOKEN_PROXY_SOCKET` (default
`/run/generacy-git-token/control.sock`) plus `CONTROL_PLANE_SOCKET_PATH`; a
single `POST /git-token` route that 404s everything else; `502
CONTROL_SOCKET_UNREACHABLE` on upstream failure; listen-socket perms `0660`;
stale-socket cleanup on boot; and `SIGTERM`/`SIGINT` graceful shutdown. Unit
tests cover the single-route allow-list (security boundary), forwarding, and the
unreachable-upstream error mapping.
