---
"@generacy-ai/cockpit": minor
"@generacy-ai/orchestrator": patch
---

Preserve caller-supplied `frameId` on `GateOpenSchema` / `GateOutcomeSchema` and
the orchestrator cockpit-gates route so `cluster.cockpit.reply` correlation
(generacy-cloud#890) stops collapsing onto `(gateId, frameType)` on idempotent
retries. Additive-optional wire-schema field; older callers unaffected.
