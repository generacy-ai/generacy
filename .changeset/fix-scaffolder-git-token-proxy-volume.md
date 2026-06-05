---
"@generacy-ai/generacy": patch
---

Share the `git-token-proxy` socket volume between orchestrator and workers in scaffolded clusters.

cluster-base#61 introduced a git-token proxy: the orchestrator binds
`/run/generacy-git-token/control.sock` and workers connect to it to mint JIT
git installation tokens. The shared volume was added to the cluster-base
devcontainer compose but not to the scaffolder, so generated local/cloud
clusters left workers with their own empty `/run/generacy-git-token` —
`CONTROL_SOCKET_UNREACHABLE`, and worker git operations (clone, commit, push)
fail. Add `git-token-proxy:/run/generacy-git-token` (rw — Unix socket connect
needs write) to both services and declare the named volume, mirroring the
canonical cluster-base compose.
