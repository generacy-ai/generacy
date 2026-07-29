---
"@generacy-ai/cockpit": minor
"@generacy-ai/orchestrator": patch
---

Preserve caller-supplied `frameId` on `GateOpenSchema` / `GateOutcomeSchema` and
the orchestrator cockpit-gates route so `cluster.cockpit.reply` correlation
(generacy-cloud#890) *can* stop collapsing onto `(gateId, frameType)` on
idempotent retries. Additive-optional wire-schema field; older callers
unaffected.

This makes correlation *possible*, not delivered. Nothing on the cluster yet
generates a per-frame `frameId` or keeps a `frameId → pending-promise` map, so
outbound frames still omit the field and replies still carry `frameId: null`
until a producer lands in a follow-up.
