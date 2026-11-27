---
'@generacy-ai/orchestrator': patch
---

Detect `SPECKIT_IMPLEMENT_PARTIAL` / `SPECKIT_IMPLEMENT_BLOCKED` sentinels embedded inside
`stream-json` envelopes (assistant `text` content blocks and the terminal `result` string),
not only on bare raw lines. Implement phases run under `--output-format stream-json`, so the
sentinel never appeared at the start of a raw line and `implementResult` stayed `undefined`,
causing a partial implement to be treated as complete. The raw-line fallback is preserved.
