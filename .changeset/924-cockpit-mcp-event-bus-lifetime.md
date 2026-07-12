---
"@generacy-ai/generacy": patch
---

Harden the `cockpit mcp` event-bus against server restarts and between-call
teardown (#924).

- Cursor tokens now embed a per-process nonce and a per-bus nonce. A cursor
  minted by a previous server instance (restart) or an evicted bus classifies
  as `discarded` and silently resets to head (`resetFrom: "discarded"`) instead
  of being misread as `never-issued`; on any reset the tool issues a fresh
  nonce-carrying cursor rather than echoing the stale token.
- The bus registry decouples bus lifetime from call lifetime: `release()` at
  refcount 0 pauses the poller and arms an idle-TTL timer instead of tearing
  the bus down, and the next `acquire()` resumes it and runs a catch-up poll so
  events between calls aren't lost. A soft cap evicts the least-recently-active
  bus on overflow. Tunable via `COCKPIT_MCP_BUS_IDLE_TTL_MS` (default 600000)
  and `COCKPIT_MCP_BUS_MAX` (default 100).
