---
"@generacy-ai/generacy": patch
---

fix(cockpit-mcp): cockpit_gate_open parses the real orchestrator ack (fixes "malformed gate-open response").

Follow-up to the #1034 wire-contract reconciliation, found in the agency#450
`--gates=ui` dogfood re-run: with the frozen up-path now correct, the gate-open
POST succeeds — but the tool then reported `internal: orchestrator returned
malformed gate-open response` and fell back to a local `AskUserQuestion`.

Root cause: `GateOpenResponseSchema` still asserted a fictional `{ gateId, status }`
echo, but the orchestrator `/cockpit/gates` route is fire-and-forget — it emits the
gate on the `cluster.cockpit` relay and replies `202 { accepted, retained,
retainQueue? }`, never echoing a gateId (the inbox URL is assigned cloud-side,
async). The parity tests mocked the fictional shape, so the route↔tool response
mismatch was never exercised.

Fix: `GateOpenResponseSchema` now validates the real `{ accepted, retained }` ack,
and the tool maps it to the caller-facing `{ gateId, status }` using the gateId it
DERIVED (`retained` → queued/relay-down, else `open`). Adds parity pins for the
real ack (open + retained) and a regression pin that the old `{ gateId, status }`
echo is now rejected as malformed. Cluster-only; no wire-contract or cloud change.
