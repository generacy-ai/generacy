---
"@generacy-ai/generacy": minor
"@generacy-ai/cockpit": minor
---

Fix cross-run terminal-gate collisions by folding an optional per-run discriminator into `gateKey` (#1053). `deriveGateKey(issueRef, gateType, generation)` gains an optional fourth argument `runId?: string`; when passed, the derivation appends `:${runId}` to the pre-image so a re-run of the same natural gate (same `issueRef`, `gateType`, `generation`) produces a fresh `gateId` and stops colliding with a terminal cloud doc from a prior run. `deriveGateId`'s hash function, output length, and 24-hex encoding are unchanged; `GateOpenWireSchema` and `GateOutcomeWireSchema` field-sets are unchanged (the wire carries only the longer opaque `gateKey` string).

MCP tool surface: `GateOpenInputSchema` and `GateAckInputSchema` accept optional `runId?: z.string().min(1).optional()`. `cockpit_gate_open` threads the explicit `runId` through the derivation; when omitted, the tool derives with the pre-#1053 3-tuple shape (byte-for-byte back-compat) and logs the source at `info` as `runIdSource: 'unset'` (event `cockpit_gate_open.runid-source`). A process-scoped fallback (`INSTANCE_NONCE`) was rejected on review — it re-introduced the same cross-run collision this fix exists to close (two `/cockpit:auto` runs in one MCP-server process share the nonce) and desynced against the cloud's positional-3-tuple `generationFromGateKey` read-side parser. `cockpit_gate_ack` accepts-and-ignores `runId` for envelope symmetry. `askedAt` is hoisted above the retry boundary via a per-`gateId` in-memory cache so within-run retries produce byte-identical wire frames — US2 correctness no longer depends on cloud `gateId`-keyed dedup.

The end-to-end #1053 fix requires the sibling `/cockpit:auto` skill (agency repo, FR-006) to thread the auto-run id through as `runId`. Until that companion lands, the schema surface is present but the per-run discriminator is a no-op on the default path (`runIdSource: 'unset'`); a caller that passes an explicit `runId` today already gets a fresh `gateId` per run.

Ships US1 + US2 only. FR-004 / FR-005 / FR-007 (terminal-collision detection + the new `'terminal-collision'` `ErrorClass` value + ack-path parity) and FR-006 (skill-side handler in the sibling `agency` repo) ship in a follow-up PR gated on generacy-cloud#887.
