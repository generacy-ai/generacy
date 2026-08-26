---
"@generacy-ai/orchestrator": patch
---

Capture the agent's real messages in CLI-phase failure comments. The worker's
`OutputCapture` stores every Claude CLI stream-json line as a `type: 'text'`
chunk whose `data` is the raw envelope, so the agent's prose lives at
`data.message.content[].text` (assistant turns) or `data.result` (final turn) —
not at a flat `data.text`. `synthesizeOutputTail` only read `data.text`, so every
CLI-phase failure comment (e.g. `implement` failing `no-product-code-changes`)
rendered an empty or one-line "output (last N lines)" tail even when the agent
had explained itself at length. Extract text from all three envelope shapes so
the diagnostic tail carries the agent's last message — the "why it stopped"
narrative that is the whole point of the failure comment — while still skipping
structural tool/lifecycle chunks and de-duplicating the trailing `result` echo.
