---
"@generacy-ai/generacy": patch
---

Keep `generacy cockpit watch` alive across poll intervals (#836).

The watch loop's `sleep()` unref'd its inter-poll timer, so once the first poll's
async I/O settled and the loop awaited the 30s sleep, nothing referenced kept the Node
event loop alive — the process drained and exited 0 mid-sleep, never surviving even one
interval and never emitting a transition line. The `timer.unref?.()` is removed: the
abort listener already guarantees prompt loop exit on SIGINT/SIGTERM/external abort, so
nothing hangs at shutdown. An embedder that needs an unref'd timer must gate it behind an
explicit `WatchDeps` flag the CLI never sets. A subprocess regression test spawns the real
CLI and asserts the watcher is still alive after more than one interval.
