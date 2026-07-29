---
'@generacy-ai/generacy': patch
'@generacy-ai/orchestrator': patch
---

Phase B of the #1053 fix: widen `cockpit_gate_status` / `cockpit_gate_list`
MCP schemas to accept an optional `runId` field, and thread it through the
query client + orchestrator route + cloud gate-query client so a caller that
supplied `runId` on `cockpit_gate_open` can then re-issue `cockpit_gate_status`
in the same run and observe `open` (not `absent`).

- `cockpit_gate_status`: schema widened, `runId` forwarded to the cloud as a
  `runId=<value>` query-string parameter (camelCase); post-call log line emits
  `runIdSource: 'explicit' | 'unset'` on success + failure paths (value never
  logged).
- `cockpit_gate_list`: schema widened for surface parity; handler drops
  `runId` before calling the client (cloud route 400s any list carrying `runId`).
  No `runIdSource` log line on list.

Byte-compat: with `runId` omitted, every derived key, id, and outbound URL is
byte-identical to today (pinned by snapshot + structural tests).

Requires cloud Phase A (generacy-cloud#892, merge `192fca7c`, deployed
`2026-07-29T04:07:07Z`). On-call MUST verify Phase A is in prod at merge time.
