---
"@generacy-ai/orchestrator": patch
---

Capture stdout in worker error evidence, not just stderr (#890).

`buildErrorEvidence` tailed only stderr, but Next.js, vitest, and npm write most
failure detail to stdout — so a `validate` failure like `next build`'s type error
surfaced in alerts as `stderr: (empty)`, stranding the auto-mode escalation gate
with nothing to diagnose. The spawn layer now merges stdout+stderr chunks in
arrival order into a bounded ring buffer (~8 KiB) when no explicit capture is
attached, and Claude-CLI phases synthesize the tail from the retained `text`
chunks. `buildErrorEvidence` renders a single interleaved `output` block (keeping
the 4 KiB byte bound; `CommandExitEvidence.stderrTail` renamed `outputTail`), and
collapses the both-empty case to one `(no output on either stream)` line instead
of a misleading `(empty)` marker.
