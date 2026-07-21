---
"@generacy-ai/cluster-relay": minor
"@generacy-ai/orchestrator": minor
---

Make the per-user execution lease path functional in worker mode so concurrent
cockpit auto sessions can execute in parallel across worker replicas (#1016).

The cluster-side lease protocol (#418) was dead end-to-end: `cluster-relay`'s
`RelayMessageSchema` did not include any lease message types, so every inbound
`lease_response` / `slot_available` / `cluster_rejected` was dropped at the
Zod parse; the orchestrator additionally expected `lease_granted`/`lease_denied`
message types the cloud never sends (it sends a single `lease_response`
discriminated by `status`); and worker mode — the only mode that runs the
dispatcher — never routed inbound relay messages to its LeaseManager at all.
Net effect: dispatch was never lease-gated, and a lease denial (had it ever
arrived) would have paused a replica's polling forever on a missed
`slot_available`.

Changes:

- `cluster-relay`: add lease-protocol message types + schemas matching the
  cloud wire contract (`lease_request`, `lease_release`, `lease_heartbeat`,
  `lease_response`, `slot_available`, `cluster_rejected`, `tier_info`).
- `orchestrator`: `LeaseManager` consumes `lease_response` (granted / denied /
  released / error), learns the tier's concurrency limit from the denial
  payload (the cloud never emits `tier_info`), sends the `correlationId` the
  cloud requires on `lease_release` (releases were previously refused
  server-side and only expired by TTL), and swallows release acks.
- `orchestrator`: worker mode wires inbound relay messages to the dispatcher's
  LeaseManager.
- `WorkerDispatcher`: the lease gate engages whenever a lease manager is
  configured (previously also gated on receiving `tier_info`, which never
  arrives). Denials pause claiming and now auto-resume via a
  `denialResumeMs` backstop (new `DispatchConfig` field, default 60s) if the
  `slot_available` broadcast is missed; transient cloud errors re-enqueue and
  retry without pausing; request timeouts fail open (dispatch without a lease)
  so lease-less clouds cannot starve dispatch. The per-replica
  one-job-at-a-time cap is unchanged — parallelism comes from `workers: N`
  container replicas, now properly metered by per-user cloud leases.
