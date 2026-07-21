---
"@generacy-ai/orchestrator": minor
"@generacy-ai/cockpit": minor
---

Add orchestrator-side wire for the Cockpit Remote Gates epic (#1021). Three new HTTP routes on the orchestrator (`POST /cockpit/gates`, `POST /cockpit/gates/:id/ack`, `POST /cockpit/answers`), one new `cluster.cockpit` relay channel with retain-and-replay on reconnect (bounded FIFO with count + byte caps, drop-oldest), and one append-only NDJSON answers file at `/workspaces/.generacy/cockpit/answers.ndjson` with size-based rotation (`.1`..`.N`) and in-memory `deliveryId` dedup rebuilt on boot. `@generacy-ai/cockpit` gains `packages/cockpit/src/gates/` with `GateOpenSchema`, `GateAckSchema`, `GateAnswerSchema` (Zod with passthrough for forward-compat) and inferred TS types. Auth reuses `authMiddleware` via a new `COCKPIT_INTERNAL_API_KEY` env var (parallel to `ORCHESTRATOR_INTERNAL_API_KEY` from #598); `/cockpit/answers` reaches the orchestrator via the cluster-relay dispatcher's implicit `orchestratorUrl` fallback with no new route entry. Downstream MCP tools, the doorbell that tails `answers.ndjson`, and the cloud-side inbox UI ship as separate epic issues.
