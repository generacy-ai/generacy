---
"@generacy-ai/generacy": patch
---

fix(cockpit-mcp): `cockpit_gate_ack` now builds the full ack envelope the orchestrator requires. It POSTed only `{ outcome, detail? }`, but the orchestrator's authoritative `GateAckSchema` (`@generacy-ai/cockpit`) requires `{ kind:'gate-ack', gateId, generation:number, outcome, ackedAt }` — so gate resolution 400'd after a gate opened. The ack tool input now takes `generation` (the answered delivery's generation, which the cloud's `upsertGate` stale-guard needs), and the tool builds `{ kind:'gate-ack', gateId, generation, outcome, ackedAt: now, detail? }`. Part of the gate wire-contract reconciliation (#1034); pairs with the agency plugin passing `generation` to the ack.
