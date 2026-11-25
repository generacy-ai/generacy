---
"@generacy-ai/generacy": patch
---

Gate MCP tools return a locally-built `inboxUrl` deep-link (#1235).

`cockpit_gate_open` now returns a required `inboxUrl`
(`${appUrl}/dashboard/inbox?gate=<gateId>`) on both `open` and `retained`
results, and the read tools `cockpit_gate_status` / `cockpit_gate_list`
enrich their responses with the same pointer (`inboxUrl: null` on the
`absent` status, one per row for lists). The URL is built in the CLI from the
tool's already-derived `gateId` with `appUrl` resolved as
`deps.appUrl` > `GENERACY_APP_URL` > `https://app.generacy.ai` — no cloud
round-trip and no change to the fire-and-forget orchestrator ack contract.
This closes the `/cockpit:auto --gates=ui` "DATA GAP" where the playbook had
no real inbox link to print. New result types are internal (not re-exported
from `index.ts`).
