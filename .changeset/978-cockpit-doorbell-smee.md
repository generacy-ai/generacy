---
"@generacy-ai/generacy": patch
---

`cockpit doorbell` swaps its wake source to a smee.io SSE consumer when a
cluster smee channel is configured, keeping the existing 30s event-bus poll
loop as a safety-net fallback (#978). No CLI surface changes and no public
schemas move (Q1=A preserved): `CockpitEventSchema` enum is unchanged and
`armed\n` still writes immediately after argument validation. Real-time-first
on smee-live clusters drops label-to-wake latency from ~25s to ≤ ~3s p95;
poll-only clusters see no behavior change.
