---
"@generacy-ai/cluster-relay": minor
"@generacy-ai/orchestrator": patch
"@generacy-ai/generacy": patch
---

Mint a `frameId` per outbound cockpit frame and correlate `cluster.cockpit.reply` back to it (#1077). The orchestrator's `POST /cockpit/gates` and `POST /cockpit/gates/:id/ack` handlers now mint an `frm_<24-hex>` id at request-accept time (before `tryEmitOrRetain`), so the 202 echoes the id, retained frames carry it into the retain queue, and drain emits it verbatim. A caller-supplied `frameId` on the request body overrides the route mint. `@generacy-ai/cluster-relay` gains a new public `registerPendingFrame(frameId, meta)` method and `PendingFrameMeta` export; the `cluster.cockpit.reply` receive branch settles matching pending entries (info log with `ageMs`), quiet-drops unknown ones (info log naming the `frameId`), and evicts on a 30s TTL (debug log). The map is preserved across transient WebSocket disconnects and cleared on `disconnect()`. `@generacy-ai/generacy`'s `GateOpenWireSchema` / `GateOutcomeWireSchema` gain an optional `frameId` field so callers that hand-supply one pass the tool's self-check.
